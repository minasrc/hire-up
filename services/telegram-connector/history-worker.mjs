import { randomUUID } from 'node:crypto';
import { HistoryReadError, peerKey } from './history-adapter.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const codes = new Set(['FLOOD_WAIT', 'TELEGRAM_UNAVAILABLE', 'PEER_UNAVAILABLE', 'PEER_CACHE_MISSING', 'MESSAGE_TOO_LARGE']);
const pendingKey = 'pending-page';
function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function jobValid(job, context, now) {
  return job && uuid.test(job.id) && uuid.test(job.leaseToken) && ['dialogs', 'history'].includes(job.kind)
    && job.connectionId === context.connectionId && job.generation === context.generation && job.accountUserId === context.accountUserId
    && Number.isSafeInteger(job.pageNumber) && job.pageNumber >= 0 && Date.parse(job.leaseExpiresAt) > now;
}
export function createHistoryWorker({ host, vault, now = Date.now, randomId = randomUUID, maxRequestBytes = 262144 }) {
  let nextPoll = 0; let busy = false; let scope = ''; let pageLimit = 100; let limitJob = null;
  function proof(context) { return { connectionId: context.connectionId, generation: context.generation, connectionLeaseToken: context.connectionLeaseToken, accountUserId: context.accountUserId }; }
  function active(context) { return !context.signal?.aborted && context.isActive() && Date.parse(context.connectionLeaseExpiresAt) > now(); }
  function requireActive(context) { if (!active(context)) throw new HistoryReadError('CONNECTION_CHANGED'); }
  const loadPending = (context) => vault.loadHistory(context.connectionId, context.accountUserId, pendingKey);
  const savePending = (context, value) => vault.saveHistory(context.connectionId, context.accountUserId, pendingKey, value);
  const clearPending = (context) => vault.removeHistoryRecord(context.connectionId, context.accountUserId, pendingKey);
  async function deferRejectedPage(context, pending, code) {
    requireActive(context);
    // Validation rejection is definitive, but its defer acknowledgement can be
    // lost. Persist that distinction and retry only defer after a restart.
    if (!pending.rejectionCode) { pending.rejectionCode = code; savePending(context, pending); }
    let status = 'deferred';
    try {
      const result = await host('defer', { ...proof(context), jobId: pending.payload.jobId, jobLeaseToken: pending.payload.jobLeaseToken, code });
      if (result.ok !== true) throw new Error('INVALID_HISTORY_RESPONSE');
    } catch (error) { if (error.status !== 409) throw error; status = 'stale'; }
    // An accepted defer or a stale-lease fence leaves the authoritative cursor
    // untouched. Uncertain network/5xx results keep the encrypted pending page.
    clearPending(context);
    nextPoll = now() + 5000;
    return { status };
  }
  async function complete(context, pending) {
    requireActive(context);
    let result;
    try { result = await host('complete', { ...proof(context), ...pending.payload }); }
    catch (error) {
      if (error.status === 400 || error.status === 422) return deferRejectedPage(context, pending, error.status === 422 ? 'MESSAGE_TOO_LARGE' : 'PEER_UNAVAILABLE');
      throw error;
    }
    if (result.ok !== true || !['queued', 'completed', 'capacity_paused'].includes(result.status)) throw new Error('INVALID_HISTORY_RESPONSE');
    clearPending(context);
    return { status: result.status };
  }
  async function reconcilePending(context, pending) {
    if (pending.generation !== context.generation) { clearPending(context); return { status: 'stale' }; }
    if (['PEER_UNAVAILABLE', 'MESSAGE_TOO_LARGE'].includes(pending.rejectionCode)) return deferRejectedPage(context, pending, pending.rejectionCode);
    try { return await complete(context, pending); }
    catch (error) {
      if (error.status !== 409) throw error;
      requireActive(context);
      const { job } = await host('claim', proof(context));
      // Cursor progression is authoritative. If no matching resumable lease is
      // available, its unchanged server cursor still permits a later re-read.
      if (!jobValid(job, context, now()) || job.id !== pending.payload.jobId || job.pageNumber !== pending.pageNumber || !same(job.cursor, pending.payload.fromCursor)) {
        clearPending(context); return { status: 'stale' };
      }
      if (job.leaseToken === pending.payload.jobLeaseToken) throw new Error('INVALID_HISTORY_RESPONSE');
      pending.payload = { ...pending.payload, jobLeaseToken: job.leaseToken, pageId: randomId() };
      savePending(context, pending);
      return { status: 'resizing' };
    }
  }
  return {
    async tick(context) {
      if (busy || !active(context)) return { status: 'stale' };
      const currentScope = `${context.connectionId}:${context.accountUserId}:${context.generation}`;
      if (scope !== currentScope) { scope = currentScope; nextPoll = 0; pageLimit = 100; limitJob = null; }
      if (now() < nextPoll) return { status: 'idle' };
      busy = true;
      let job;
      try {
        const pending = loadPending(context);
        if (pending) return await reconcilePending(context, pending);
        const response = await host('claim', proof(context));
        requireActive(context);
        job = response.job;
        if (job === null) { nextPoll = now() + 5000; return { status: 'idle' }; }
        if (!jobValid(job, context, now())) throw new Error('INVALID_HISTORY_RESPONSE');
        if (limitJob !== `${job.id}:${job.pageNumber}`) { pageLimit = 100; limitJob = `${job.id}:${job.pageNumber}`; }
        const args = {
          cursor: job.cursor, peer: job.peer, limit: pageLimit, accountUserId: context.accountUserId, signal: context.signal,
          readPeer: (peer) => vault.loadHistory(context.connectionId, context.accountUserId, `peer:${peerKey(peer)}`),
          cachePeer: (peer, record) => { requireActive(context); vault.saveHistory(context.connectionId, context.accountUserId, `peer:${peerKey(peer)}`, record); },
        };
        requireActive(context);
        // Exactly one provider page per tick; the connector renews its control
        // lease/heartbeat before another tick, including page-size retries.
        const page = await context.telegram[job.kind](args);
        requireActive(context);
        if (!page || !Array.isArray(page.records) || page.records.length > pageLimit || (page.done && page.records.length) || typeof page.done !== 'boolean') throw new HistoryReadError('PEER_UNAVAILABLE');
        const payload = { jobId: job.id, jobLeaseToken: job.leaseToken, pageId: randomId(), fromCursor: job.cursor, nextCursor: page.nextCursor, done: page.done, records: page.records };
        if (Buffer.byteLength(JSON.stringify({ ...proof(context), ...payload })) > maxRequestBytes) {
          if (pageLimit <= 1) throw new HistoryReadError('MESSAGE_TOO_LARGE');
          pageLimit = Math.max(1, Math.floor(pageLimit / 2));
          return { status: 'resizing' };
        }
        const durable = { generation: context.generation, pageNumber: job.pageNumber, payload };
        savePending(context, durable);
        return await complete(context, durable);
      } catch (error) {
        if (error.code === 'CONNECTION_CHANGED' || !active(context)) return { status: 'stale' };
        if (error.status === 409) return { status: 'stale' };
        if (error.status === 404) { nextPoll = now() + 30000; return { status: 'idle' }; }
        if (job && codes.has(error.code)) {
          const body = { ...proof(context), jobId: job.id, jobLeaseToken: job.leaseToken, code: error.code };
          if (error.code === 'FLOOD_WAIT') body.retryAfterSeconds = error.retryAfterSeconds;
          requireActive(context);
          try { await host('defer', body); } catch (deferError) { if (deferError.status !== 409) throw deferError; }
          nextPoll = now() + 5000;
          return { status: 'deferred' };
        }
        throw error;
      } finally { busy = false; }
    },
  };
}
