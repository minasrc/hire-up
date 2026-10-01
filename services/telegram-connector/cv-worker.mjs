import { createHash } from 'node:crypto';
import { CvReadError, CV_CHUNK_BYTES, CV_MAX_BYTES } from './cv-adapter.mjs';
import { peerKey } from './history-adapter.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
const stateKey = 'pending-cv';
const codes = new Set(['FLOOD_WAIT', 'TELEGRAM_UNAVAILABLE', 'SOURCE_CHANGED', 'SOURCE_UNAVAILABLE', 'FILE_TOO_LARGE', 'INVALID_FILE', 'WORKER_ERROR']);
const retryable = new Set(['FLOOD_WAIT', 'TELEGRAM_UNAVAILABLE', 'WORKER_ERROR']);
export function createCvWorker({ host, upload, vault, now = Date.now }) {
  let busy = false; let scope = ''; let verified = ''; let nextPoll = 0;
  const proof = context => ({ connectionId: context.connectionId, generation: context.generation, connectionLeaseToken: context.connectionLeaseToken, accountUserId: context.accountUserId });
  const active = context => !context.signal?.aborted && context.isActive() && Date.parse(context.connectionLeaseExpiresAt) > now();
  const requireActive = context => { if (!active(context)) throw new CvReadError('CONNECTION_CHANGED'); };
  const load = context => vault.loadHistory(context.connectionId, context.accountUserId, stateKey);
  const save = (context, state) => { requireActive(context); vault.saveHistory(context.connectionId, context.accountUserId, stateKey, state); };
  function clear(context, state) {
    if (state?.jobId) vault.removeCvChunks(context.connectionId, context.accountUserId, state.jobId);
    vault.removeHistoryRecord(context.connectionId, context.accountUserId, stateKey); verified = '';
  }
  function validJob(job, context) {
    const source = job?.source;
    return job && uuid.test(job.id) && uuid.test(job.leaseToken) && digest.test(job.sourceDigest) && Date.parse(job.leaseExpiresAt) > now() + 15000
      && source?.accountUserId === context.accountUserId && uuid.test(source.chatId) && uuid.test(source.extractionJobId)
      && ['user', 'chat', 'channel'].includes(source.peer?.kind) && /^[1-9][0-9]{0,29}$/.test(source.peer.id)
      && /^[1-9][0-9]{0,9}$/.test(source.messageId) && Number(source.messageId) <= 2147483647 && Number.isInteger(source.attachmentIndex) && source.attachmentIndex >= 0 && source.attachmentIndex <= 15
      && /^[1-9][0-9]{0,29}$/.test(source.documentId) && typeof source.filename === 'string' && source.filename.length <= 200
      && (source.sizeBytes === null || Number.isInteger(source.sizeBytes) && source.sizeBytes > 0 && source.sizeBytes <= CV_MAX_BYTES);
  }
  async function defer(context, state, code, seconds = 30) {
    requireActive(context);
    if (!state.pendingDefer) { state.pendingDefer = { code, retryAfterSeconds: Math.max(1, Math.min(604800, seconds)) }; save(context, state); }
    const deferred = state.pendingDefer;
    try {
      const result = await host('defer', { ...proof(context), jobId: state.jobId, jobLeaseToken: state.leaseToken, ...deferred }, { signal: context.signal });
      if (result?.ok !== true) throw new Error('INVALID_CV_RESPONSE');
    } catch (error) { if (error.status !== 409) throw error; clear(context, state); return { status: 'stale' }; }
    if (retryable.has(deferred.code)) {
      delete state.pendingDefer; state.phase = 'downloading'; state.location = null; save(context, state); verified = '';
    } else clear(context, state);
    nextPoll = now() + deferred.retryAfterSeconds * 1000;
    return { status: 'deferred' };
  }
  function bytesFor(context, state) {
    const parts = [];
    try {
      for (let index = 0; index < Math.ceil(state.sizeBytes / CV_CHUNK_BYTES); index++) {
        const bytes = vault.loadCvChunk(context.connectionId, context.accountUserId, state.jobId, index);
        if (bytes.length !== Math.min(CV_CHUNK_BYTES, state.sizeBytes - index * CV_CHUNK_BYTES)) throw new CvReadError('INVALID_FILE');
        parts.push(bytes);
      }
      const bytes = Buffer.concat(parts);
      if (bytes.length !== state.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== state.sha256) { bytes.fill(0); throw new CvReadError('INVALID_FILE'); }
      return bytes;
    } finally { for (const part of parts) part.fill(0); }
  }
  async function finish(context, state) {
    requireActive(context);
    const bytes = bytesFor(context, state);
    try {
      const receipt = await upload({ ...proof(context), jobId: state.jobId, jobLeaseToken: state.leaseToken, sourceDigest: state.sourceDigest, sha256: state.sha256, sizeBytes: state.sizeBytes }, bytes, { signal: context.signal });
      if (receipt?.ok !== true || receipt.jobId !== state.jobId || receipt.status !== 'completed') throw new Error('INVALID_CV_RESPONSE');
      clear(context, state); return { status: 'completed' };
    } catch (error) {
      if (error.status === 409) { clear(context, state); return { status: 'stale' }; }
      if ([400, 422].includes(error.status)) return await defer(context, state, 'INVALID_FILE', 1);
      throw error;
    } finally { bytes.fill(0); }
  }
  return {
    async tick(context) {
      if (busy || !active(context)) return { status: 'stale' };
      const current = `${context.connectionId}:${context.accountUserId}:${context.generation}`;
      if (scope !== current) { scope = current; verified = ''; nextPoll = 0; }
      if (now() < nextPoll) return { status: 'idle' };
      busy = true; let state;
      try {
        state = load(context);
        if (state && state.generation !== context.generation) { clear(context, state); state = null; }
        if (state?.pendingDefer) return await defer(context, state);
        // A committed upload receipt must be retried before claiming another job.
        if (state?.phase === 'upload') return await finish(context, state);
        const response = await host('claim', proof(context), { signal: context.signal }); requireActive(context);
        const job = response.job;
        if (job === null) {
          const retryAt = Date.parse(response.retryAt);
          if (!Number.isFinite(retryAt) || retryAt <= now()) { if (state) clear(context, state); }
          nextPoll = Number.isFinite(retryAt) && retryAt > now() ? retryAt : now() + 5000;
          return { status: 'idle' };
        }
        if (!validJob(job, context)) throw new Error('INVALID_CV_RESPONSE');
        if (state && (state.jobId !== job.id || state.sourceDigest !== job.sourceDigest)) { clear(context, state); state = null; }
        if (!state) state = { generation: context.generation, jobId: job.id, sourceDigest: job.sourceDigest, source: job.source, leaseToken: job.leaseToken, phase: 'downloading', downloaded: 0, sizeBytes: null, location: null, migrations: 0, referenceRefreshes: 0 };
        if (state.leaseToken !== job.leaseToken) { verified = ''; state.location = null; }
        state.leaseToken = job.leaseToken; save(context, state);
        const key = `${job.id}:${job.sourceDigest}:${context.generation}`;
        if (!state.location || verified !== key) {
          const source = state.source;
          const location = await context.telegram.cv.inspect({ peer: source.peer, messageId: source.messageId, attachment: { id: source.documentId, kind: 'document', filename: source.filename, mimeType: source.mimeType, sizeBytes: source.sizeBytes }, readPeer: peer => vault.loadHistory(context.connectionId, context.accountUserId, `peer:${peerKey(peer)}`), signal: context.signal });
          requireActive(context);
          if (!location || !Number.isInteger(location.sizeBytes) || location.sizeBytes < 1 || location.sizeBytes > CV_MAX_BYTES || (state.sizeBytes !== null && state.sizeBytes !== location.sizeBytes)) throw new CvReadError('SOURCE_CHANGED');
          state.location = location; state.sizeBytes = location.sizeBytes; save(context, state); verified = key;
          return { status: 'reading' };
        }
        const bytes = await context.telegram.cv.chunk({ location: state.location, offset: state.downloaded, signal: context.signal });
        try {
          requireActive(context);
          if (!Buffer.isBuffer(bytes) || bytes.length !== Math.min(CV_CHUNK_BYTES, state.sizeBytes - state.downloaded)) throw new CvReadError('INVALID_FILE');
          vault.saveCvChunk(context.connectionId, context.accountUserId, state.jobId, state.downloaded / CV_CHUNK_BYTES, bytes);
          state.downloaded += bytes.length;
          if (state.downloaded === state.sizeBytes) {
            const hash = createHash('sha256');
            for (let index = 0; index < Math.ceil(state.sizeBytes / CV_CHUNK_BYTES); index++) {
              const chunk = vault.loadCvChunk(context.connectionId, context.accountUserId, state.jobId, index); hash.update(chunk); chunk.fill(0);
            }
            state.sha256 = hash.digest('hex'); state.phase = 'upload'; state.location = null;
          }
          save(context, state); return { status: state.phase === 'upload' ? 'ready' : 'reading' };
        } finally { bytes?.fill?.(0); }
      } catch (error) {
        if (error.code === 'CONNECTION_CHANGED' || !active(context)) return { status: 'stale' };
        if (error.status === 409) { if (state) clear(context, state); return { status: 'stale' }; }
        if (error.status === 404) { nextPoll = now() + 30000; return { status: 'idle' }; }
        if (state && error.code === 'FILE_REFERENCE_EXPIRED' && state.referenceRefreshes < 3) { state.location = null; state.referenceRefreshes++; save(context, state); verified = ''; return { status: 'refreshing' }; }
        if (state && error.code === 'FILE_MIGRATE' && state.location && state.migrations < 3) { state.location.dcId = error.dcId; state.migrations++; save(context, state); return { status: 'migrating' }; }
        if (state && ['PEER_CACHE_MISSING', 'FILE_MIGRATE', 'FILE_REFERENCE_EXPIRED'].includes(error.code)) return await defer(context, state, 'SOURCE_UNAVAILABLE', 1);
        if (state && codes.has(error.code)) return await defer(context, state, error.code, error.code === 'FLOOD_WAIT' ? error.retryAfterSeconds : retryable.has(error.code) ? 30 : 1);
        throw error;
      } finally { busy = false; }
    },
  };
}
