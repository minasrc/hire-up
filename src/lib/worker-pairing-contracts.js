import { createHash } from 'node:crypto';
export const WORKER_PAIRING_BODY_LIMIT = 2048;
export const WORKER_PAIRING_TTL_SECONDS = 600;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = /^[a-f0-9]{64}$/;
export class WorkerPairingError extends Error {
    constructor(code, status = 400, retryAfterSeconds) { super(code); this.code = code; this.status = status; this.retryAfterSeconds = retryAfterSeconds; }
}
const invalid = () => { throw new WorkerPairingError('INVALID_INPUT'); };
const object = (v, keys) => { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || Object.keys(v).some(k => !keys.includes(k))) invalid(); };
const id = v => { if (typeof v !== 'string' || !uuid.test(v)) invalid(); return v.toLowerCase(); };
const text = v => { if (typeof v !== 'string' || !v.isWellFormed() || !v.trim() || [...v].length > 80 || /[\u0000-\u001f\u007f]/u.test(v)) invalid(); return v; };
const timestamp = v => { if (typeof v !== 'string' || v.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(v) || !Number.isFinite(Date.parse(v))) invalid(); return v; };
export function workerDeviceInput(input) {
    const fields = { invite: ['action', 'operationId', 'invitationSha256', 'name'], approve: ['action', 'operationId', 'pairingId', 'deviceFingerprint'], cancel: ['action', 'operationId', 'pairingId'], renew: ['action', 'operationId', 'workerId', 'expectedExpiresAt'] }[input?.action];
    if (!fields) invalid(); object(input, fields); const result = { ...input, operationId: id(input.operationId) };
    if (input.action === 'invite') { if (typeof input.invitationSha256 !== 'string' || !hash.test(input.invitationSha256)) invalid(); result.name = text(input.name); }
    else if (input.action === 'renew') { result.workerId = id(input.workerId); result.expectedExpiresAt = timestamp(input.expectedExpiresAt); }
    else { result.pairingId = id(input.pairingId); if (input.action === 'approve' && !/^[a-f0-9]{12}$/.test(input.deviceFingerprint ?? '')) invalid(); }
    return result;
}
export function workerPairingInput(action, input) {
    const keys = action === 'claim' ? ['pairingId', 'claimId', 'deviceName', 'tokenSha256', 'verifierSha256'] : action === 'poll' ? ['pairingId'] : null;
    if (!keys) invalid(); object(input, keys); const result = { ...input, pairingId: id(input.pairingId) };
    if (action === 'claim') { result.claimId = id(input.claimId); result.deviceName = text(input.deviceName); for (const k of ['tokenSha256', 'verifierSha256']) if (typeof input[k] !== 'string' || !hash.test(input[k])) invalid(); }
    return result;
}
export function workerDeviceFilters(input = {}) {
    if (!input || Object.keys(input).some(k => !['pairingId', 'after'].includes(k))) invalid();
    if (input.pairingId != null && input.after != null) invalid();
    if (input.pairingId != null) return { pairingId: id(input.pairingId), after: null };
    let after = null;
    if (input.after != null) { try { if (typeof input.after !== 'string' || input.after.length > 256 || !/^[A-Za-z0-9_-]+$/.test(input.after)) invalid(); after = JSON.parse(Buffer.from(input.after, 'base64url').toString('utf8')); object(after, ['createdAt', 'id']); after = { createdAt: timestamp(after.createdAt), id: id(after.id) }; } catch { invalid(); } }
    return { pairingId: null, after };
}
export function workerPairingFingerprint(pairingId, claimId, tokenSha256, verifierSha256) {
    return createHash('sha256').update(JSON.stringify(['worker-pairing-v1', id(pairingId), id(claimId), tokenSha256, verifierSha256])).digest('hex').slice(0, 12);
}
