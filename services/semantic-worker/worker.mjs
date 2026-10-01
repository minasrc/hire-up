import { createHash } from 'node:crypto';
import { CHUNKER_VERSION, CV_CHUNKER_VERSION, CV_CAPABILITY, CV_PROJECTION_VERSION, DIMENSIONS, INDEX_VERSION, MODEL_CAPABILITY, PROJECTION_VERSION, SemanticWorkerError } from './constants.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest = /^[0-9a-f]{64}$/;
const hash = text => createHash('sha256').update(text).digest('hex');
const invalid = () => { throw new SemanticWorkerError('INVALID_RESULT'); };
const versions = value => value?.indexVersion === INDEX_VERSION && [CHUNKER_VERSION, CV_CHUNKER_VERSION].includes(value?.chunkerVersion);
const textBytes = text => typeof text === 'string' && Buffer.from(text).toString('utf8') === text;
function vector(value) {
  if (!Array.isArray(value) || value.length !== DIMENSIONS || value.some(x => typeof x !== 'number' || !Number.isFinite(x)) || Math.abs(Math.sqrt(value.reduce((sum, x) => sum + x * x, 0)) - 1) > 0.001) invalid();
  return value;
}
function validateJob(job) {
  if (!job || !uuid.test(job.id) || !uuid.test(job.leaseToken) || !['query', 'plan', 'embed'].includes(job.kind) || !Number.isFinite(Date.parse(job.leaseExpiresAt)) || !versions(job)) invalid();
  if (job.kind === 'query') {
    if (job.projectionVersion !== PROJECTION_VERSION || job.chunkerVersion !== CHUNKER_VERSION || job.source != null) invalid();
    if (!textBytes(job.query) || !job.query.trim() || [...job.query].length > 2000 || Buffer.byteLength(job.query) > 8000 || job.querySha256 !== hash(job.query)) invalid();
  } else {
    const s = job.source;
    if (!s || !['candidate', 'draft'].includes(s.sourceType) || !uuid.test(s.sourceId) || !Number.isSafeInteger(s.revision) || s.revision < 1 || !digest.test(s.sha256)) invalid();
    // Older hosts omit component on profile jobs. Only an explicit CV component
    // may use the reviewed-document namespace; metadata never chooses routing.
    const component = s.component === undefined ? 'profile' : s.component;
    if (!['profile', 'cv'].includes(component)) invalid();
    if (component === 'cv') {
      if (job.projectionVersion !== CV_PROJECTION_VERSION || job.chunkerVersion !== CV_CHUNKER_VERSION || s.sourceType !== 'candidate' || !uuid.test(s.reviewedTextId)
        || !s.document || typeof s.document !== 'object' || Array.isArray(s.document)
        || Object.keys(s.document).some(key => !['id', 'sha256'].includes(key))
        || !uuid.test(s.document.id) || !digest.test(s.document.sha256)) invalid();
    } else if (job.projectionVersion !== PROJECTION_VERSION || job.chunkerVersion !== CHUNKER_VERSION || s.document != null || s.reviewedTextId != null) invalid();
    if (job.kind === 'plan' && (!textBytes(s.text) || !s.text.trim() || Buffer.byteLength(s.text) > 65536 || hash(s.text) !== s.sha256)) invalid();
    if (job.kind === 'embed') {
      if (!digest.test(job.manifestSha256) || !Array.isArray(job.chunks) || job.chunks.length < 1 || job.chunks.length > 8) invalid();
      for (const [index, chunk] of job.chunks.entries()) {
        if (!Number.isInteger(chunk.ordinal) || chunk.ordinal < 0 || chunk.ordinal > 255 || (index && chunk.ordinal !== job.chunks[index - 1].ordinal + 1) || !Number.isSafeInteger(chunk.startByte) || chunk.startByte < 0 || !Number.isSafeInteger(chunk.endByte) || chunk.endByte <= chunk.startByte || chunk.endByte > 65536 || !textBytes(chunk.text) || !chunk.text.trim() || Buffer.byteLength(chunk.text) > 16384 || [...chunk.text].length > 16000 || Buffer.byteLength(chunk.text) !== chunk.endByte - chunk.startByte || hash(chunk.text) !== chunk.sha256) invalid();
      }
    }
  }
  return job;
}
function normalizedPlan(result, source, chunkerVersion) {
  const bytes = Buffer.from(source.text);
  if (result?.index_version !== INDEX_VERSION || result?.chunker_version !== chunkerVersion || result?.source_sha256 !== source.sha256 || result?.byte_length !== bytes.length || !Array.isArray(result.chunks) || !result.chunks.length || result.chunks.length > 256) invalid();
  let position = 0;
  const chunks = result.chunks.map((chunk, ordinal) => {
    if (chunk.ordinal !== ordinal || chunk.start_byte !== position || !Number.isSafeInteger(chunk.end_byte) || chunk.end_byte <= position || chunk.end_byte > bytes.length || chunk.end_byte - position > 16384 || !Number.isInteger(chunk.token_count) || chunk.token_count < 1 || chunk.token_count > 128) invalid();
    const slice = bytes.subarray(position, chunk.end_byte), text = slice.toString('utf8');
    if (!Buffer.from(text).equals(slice) || [...text].length > 16000 || !text.trim() || hash(slice) !== chunk.sha256) invalid();
    position = chunk.end_byte;
    return { ordinal, startByte: chunk.start_byte, endByte: chunk.end_byte, sha256: chunk.sha256, tokenCount: chunk.token_count };
  });
  if (position !== bytes.length) invalid();
  return { byteLength: bytes.length, chunks };
}

/** One priority host job per tick; injectable I/O never connects at import time. */
export function createSemanticWorker({ host, embed, plan, vault, now = Date.now }) {
  let busy = false;
  async function replay(pending, signal) {
    try {
      const response = await host(pending.action, pending.body, { signal });
      if (!response?.ok) throw new SemanticWorkerError('WORKER_ERROR');
      await vault.clear();
      return { status: pending.action === 'complete' ? 'completed' : 'failed', kind: pending.body.kind };
    } catch (error) {
      if (error.status === 409) { await vault.clear(); return { status: 'stale' }; }
      // A document-permission revocation must not strand ordinary profile work
      // behind a CV receipt. The host retains committed truth and fences leases.
      const cvReceipt = (pending.projectionVersion ?? pending.body.projectionVersion) === CV_PROJECTION_VERSION;
      if (error.status === 403 && cvReceipt) { await vault.clear(); return { status: 'stale' }; }
      if ([401, 403].includes(error.status) || error.code === 'CREDENTIAL_UNAVAILABLE') throw error;
      if (pending.action === 'complete' && [400, 413, 422].includes(error.status)) {
        const { jobId, leaseToken, kind } = pending.body;
        const failure = { action: 'fail', body: { jobId, leaseToken, kind, code: 'INVALID_RESULT', retryAfterSeconds: 1 } };
        if (cvReceipt) failure.projectionVersion = CV_PROJECTION_VERSION;
        await vault.save(failure);
        return replay(failure, signal);
      }
      return { status: 'retry' };
    }
  }
  return {
    async tick({ signal } = {}) {
      if (busy) return { status: 'busy' };
      busy = true;
      try {
        if (signal?.aborted) return { status: 'retry' };
        const pending = await vault.load();
        if (pending) return await replay(pending, signal);
        const { job: raw } = await host('claim', { capabilities: [MODEL_CAPABILITY, CV_CAPABILITY] }, { signal });
        if (!raw) return { status: 'idle' };
        const job = validateJob(raw);
        const body = { jobId: job.id, leaseToken: job.leaseToken, kind: job.kind, indexVersion: INDEX_VERSION, projectionVersion: job.projectionVersion, chunkerVersion: job.chunkerVersion };
        const expires = Date.parse(job.leaseExpiresAt);
        const active = () => { if (signal?.aborted) throw new SemanticWorkerError('CANCELLED'); if (now() >= expires) throw new SemanticWorkerError('LEASE_EXPIRED'); };
        const remaining = Math.max(1, expires - now());
        const deadline = AbortSignal.timeout(Math.min(110000, remaining));
        const operationSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
        let receipt;
        try {
          active();
          if (job.kind === 'plan') {
            body.sourceRevision = job.source.revision;
            body.sourceSha256 = job.source.sha256;
            body.result = normalizedPlan(await plan({ text: job.source.text, chunkerVersion: job.chunkerVersion }, { signal: operationSignal }), job.source, job.chunkerVersion);
          } else {
            const response = await embed({ texts: job.kind === 'query' ? [job.query] : job.chunks.map(c => c.text), inputType: job.kind === 'query' ? 'query' : 'passage' }, { signal: operationSignal });
            if (response?.indexVersion !== INDEX_VERSION || !Array.isArray(response.embeddings) || response.embeddings.length !== (job.kind === 'query' ? 1 : job.chunks.length)) invalid();
            const vectors = response.embeddings.map(vector);
            if (job.kind === 'query') { body.querySha256 = job.querySha256; body.result = { embedding: vectors[0] }; }
            else {
              body.sourceRevision = job.source.revision; body.sourceSha256 = job.source.sha256; body.manifestSha256 = job.manifestSha256;
              body.result = { embeddings: vectors.map((embedding, index) => ({ ordinal: job.chunks[index].ordinal, embedding })) };
            }
          }
          active();
          receipt = { action: 'complete', body };
        } catch (error) {
          if (signal?.aborted || error.code === 'CANCELLED') return { status: 'retry' };
          if (error.code === 'LEASE_EXPIRED' || deadline.aborted) return { status: 'stale' };
          const code = ['INPUT_TOO_LONG', 'INVALID_RESULT'].includes(error.code) ? error.code : 'EMBEDDING_UNAVAILABLE';
          receipt = { action: 'fail', body: { jobId: job.id, leaseToken: job.leaseToken, kind: job.kind, code, retryAfterSeconds: 5 } };
        }
        if (job.projectionVersion === CV_PROJECTION_VERSION) receipt.projectionVersion = CV_PROJECTION_VERSION;
        await vault.save(receipt);
        return await replay(receipt, signal);
      } finally { busy = false; }
    },
  };
}
