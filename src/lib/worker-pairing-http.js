import { WorkerPairingError, WORKER_PAIRING_BODY_LIMIT } from './worker-pairing-contracts.js';
import { workerPairingStatus } from './worker-pairing-operations.js';
const copy = { INVALID_INPUT: 'Check the request fields.', UNAUTHORIZED: 'Sign in to continue.', FORBIDDEN: 'This action is not permitted.', INVALID_ORIGIN: 'This request origin is not permitted.', PAIRING_UNAVAILABLE: 'Pairing is unavailable or has expired.', WORKER_UNAVAILABLE: 'This device is unavailable.', OPERATION_CONFLICT: 'This operation was already used for a different request.', PAIRING_CLAIMED: 'This invitation was already claimed.', PAIRING_DECIDED: 'This pairing is already closed. Refresh its status.', WORKER_CHANGED: 'The device changed. Refresh before trying again.', RENEWAL_UNAVAILABLE: 'This device cannot be renewed now.', TOKEN_UNAVAILABLE: 'The submitted device credential cannot be enrolled.', PAIRING_RATE_LIMIT: 'Too many pairing requests. Try again shortly.', INVITATION_LIMIT: 'Close an existing invitation or try again later.' };
const headers = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' };
export const workerPairingJson = result => Response.json(result, { status: workerPairingStatus(result), headers });
export function workerPairingError(error) {
    const typed = error instanceof WorkerPairingError;
    const code = typed ? error.code : ['UNAUTHORIZED', 'FORBIDDEN'].includes(error?.code) ? error.code : error?.code === '42501' ? 'FORBIDDEN' : 'PAIRING_UNAVAILABLE';
    const status = typed ? error.status : code === 'UNAUTHORIZED' ? 401 : code === 'FORBIDDEN' ? 403 : 503;
    const retry = Number.isSafeInteger(error?.retryAfterSeconds) ? Math.max(1, Math.min(3600, error.retryAfterSeconds)) : undefined;
    return Response.json({ error: status === 503 ? 'Pairing is temporarily unavailable. Try again shortly.' : copy[code], code, ...(retry ? { retryAfterSeconds: retry } : {}) }, { status, headers: { ...headers, ...(retry ? { 'retry-after': String(retry) } : {}) } });
}
export async function readWorkerPairingJson(request) {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw new WorkerPairingError('INVALID_INPUT');
    const reader = request.body?.getReader(); if (!reader) throw new WorkerPairingError('INVALID_INPUT');
    let bytes = 0; const chunks = []; let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(new WorkerPairingError('INVALID_INPUT')); }, 5000); });
    try {
        while (true) { const { value, done } = await Promise.race([reader.read(), deadline]); if (done) break; bytes += value.byteLength; if (bytes > WORKER_PAIRING_BODY_LIMIT) { await reader.cancel(); throw new WorkerPairingError('INVALID_INPUT'); } chunks.push(Buffer.from(value)); }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw new WorkerPairingError('INVALID_INPUT'); }
    finally { clearTimeout(timer); reader.releaseLock(); }
}
