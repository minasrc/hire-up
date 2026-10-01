import { createHash } from 'node:crypto';
export class PairingError extends Error {
  constructor(code, status = 0, retryAfterSeconds = 5) { super(code); this.code = code; this.status = status; this.retryAfterSeconds = retryAfterSeconds; }
}
export const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const secret = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
export const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{64}$/.test(value);
export const name = value => typeof value === 'string' && [...value].length >= 1 && [...value].length <= 80 && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value);
export const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
export function origin(value) {
  try { const u = new URL(value); if (u.username || u.password || u.search || u.hash || u.pathname !== '/' || !(u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1','[::1]','localhost'].includes(u.hostname)))) throw new Error(); return u.origin; }
  catch { throw new PairingError('INVALID_SERVER'); }
}
export const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
export const fingerprint = state => hash(JSON.stringify(['worker-pairing-v1', state.pairingId, state.claimId, hash(state.workerToken), hash(state.pollVerifier)])).slice(0, 12);
export function credential(input) {
  if (!input || input.version !== 1 || origin(input.server) !== input.server || !uuid(input.workerId) || !token(input.token) || !name(input.name) || !timestamp(input.expiresAt) || !uuid(input.organization?.id) || typeof input.organization.name !== 'string' || !input.organization.name.length || [...input.organization.name].length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(input.organization.name)) throw new PairingError('INVALID_LOCAL_STATE');
  return input;
}
