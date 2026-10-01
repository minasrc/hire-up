import { PairingError, origin } from './protocol.mjs';
const codes = new Set(['INVALID_INPUT','UNAUTHORIZED','FORBIDDEN','INVALID_ORIGIN','PAIRING_UNAVAILABLE','WORKER_UNAVAILABLE','OPERATION_CONFLICT','PAIRING_CLAIMED','PAIRING_DECIDED','WORKER_CHANGED','RENEWAL_UNAVAILABLE','TOKEN_UNAVAILABLE','PAIRING_RATE_LIMIT','INVITATION_LIMIT']);
export function createPairingTransport({ server, fetchImpl = fetch, timeoutMs = 10000 }) {
  const base = origin(server);
  return async (action, proof, body, { signal } = {}) => {
    if (!['claim','poll'].includes(action) || !/^[A-Za-z0-9_-]{43}$/.test(proof)) throw new PairingError('INVALID_INPUT');
    const serialized = JSON.stringify(body); if (Buffer.byteLength(serialized) > 2048) throw new PairingError('INVALID_INPUT');
    try {
      const response = await fetchImpl(`${base}/api/worker-pairing/${action}`, { method: 'POST', redirect: 'error', credentials: 'omit', headers: { Authorization: `${action === 'claim' ? 'PairingInvite' : 'PairingPoll'} ${proof}`, 'Content-Type': 'application/json' }, body: serialized, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
      if (response.redirected) throw new PairingError('INVALID_RESPONSE');
      const reader = response.body?.getReader(); if (!reader) throw new PairingError('INVALID_RESPONSE');
      let size = 0; const chunks = [];
      try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 8192) throw new PairingError('INVALID_RESPONSE'); chunks.push(value); } }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      let data; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new PairingError('INVALID_RESPONSE'); }
      if (!response.ok) {
        let retry = 5;
        if (response.status === 429) {
          retry = data?.retryAfterSeconds;
          if (!Number.isInteger(retry) || retry < 1 || retry > 3600 || response.headers.get('retry-after') !== String(retry)) throw new PairingError('INVALID_RESPONSE', 429, 60);
        }
        throw new PairingError(codes.has(data?.code) ? data.code : 'HOST_UNAVAILABLE', response.status, retry);
      }
      return data;
    } catch (e) { if (e instanceof PairingError) throw e; throw new PairingError(signal?.aborted ? 'CANCELLED' : 'HOST_UNAVAILABLE'); }
  };
}
