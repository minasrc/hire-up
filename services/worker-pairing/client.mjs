import { randomBytes, randomUUID } from 'node:crypto';
import { PairingError, uuid, secret, token, name, timestamp, origin, hash, fingerprint } from './protocol.mjs';
import { createPairingTransport } from './transport.mjs';
function validState(s) {
  if (!s || s.version !== 1 || origin(s.serverOrigin) !== s.serverOrigin || !uuid(s.pairingId) || !uuid(s.claimId) || !token(s.workerToken) || !secret(s.pollVerifier) || !name(s.deviceName) || (s.invitationSecret != null && !secret(s.invitationSecret)) || !Number.isFinite(s.createdAt) || !Number.isFinite(s.nextAttemptAt) || !['claim','poll'].includes(s.nextAction)) throw new PairingError('INVALID_LOCAL_STATE');
  return s;
}
export function createPairingClient({ store, request, fetchImpl, now = Date.now }) {
  function pending() { return validState(store.loadPending()); }
  return {
    initialize({ serverOrigin, invitation, deviceName }) {
      const parts = typeof invitation === 'string' ? invitation.trim().split('.') : [];
      if (parts.length !== 2 || !uuid(parts[0]) || !secret(parts[1]) || !name(deviceName)) throw new PairingError('INVALID_INPUT');
      const state = { version: 1, serverOrigin: origin(serverOrigin), pairingId: parts[0], claimId: randomUUID(), workerToken: randomBytes(48).toString('base64url'), pollVerifier: randomBytes(32).toString('base64url'), deviceName, invitationSecret: parts[1], createdAt: now(), nextAttemptAt: 0, nextAction: 'claim' };
      store.initialize(state); return { status: 'pending', fingerprint: fingerprint(state) };
    },
    snapshot() {
      const c = store.loadCredential(); if (c) return { status: 'approved', credentialPath: store.credentialPath };
      const s = pending(); return { status: s.terminal ?? 'pending', fingerprint: fingerprint(s), serverOrigin: s.serverOrigin, deviceName: s.deviceName };
    },
    async tick({ signal } = {}) {
      const existing = store.loadCredential();
      if (existing) {
        const p = store.loadPending();
        if (p) { validState(p); if (existing.token !== p.workerToken || existing.server !== p.serverOrigin) throw new PairingError('LOCAL_STATE_EXISTS'); store.finalize(existing); }
        return { status: 'approved', credentialPath: store.credentialPath };
      }
      const s = pending(); if (s.terminal) return { status: s.terminal };
      if (signal?.aborted) throw new PairingError('CANCELLED');
      if (s.nextAttemptAt > now()) return { status: 'waiting', retryAfterSeconds: Math.ceil((s.nextAttemptAt - now()) / 1000) };
      const action = s.nextAction;
      if (action === 'claim' && !s.invitationSecret) throw new PairingError('INVALID_LOCAL_STATE');
      // Persist before sending: an uncertain claim is reconciled by verifier poll.
      s.nextAction = 'poll'; s.nextAttemptAt = now() + 5000; store.savePending(s);
      const send = request ?? createPairingTransport({ server: s.serverOrigin, fetchImpl });
      let data;
      try {
        data = await send(action, action === 'claim' ? s.invitationSecret : s.pollVerifier, action === 'claim' ? { pairingId: s.pairingId, claimId: s.claimId, deviceName: s.deviceName, tokenSha256: hash(s.workerToken), verifierSha256: hash(s.pollVerifier) } : { pairingId: s.pairingId }, { signal });
      } catch (e) {
        if (e.code === 'CANCELLED') throw e;
        if (action === 'poll' && e.status === 404 && s.invitationSecret) {
          if (now() - s.createdAt >= 600000) s.terminal = 'expired'; else s.nextAction = 'claim';
        } else if (e.status === 409 || [401, 403, 404].includes(e.status)) s.terminal = e.code === 'PAIRING_CLAIMED' ? 'claim_conflict' : 'access_denied';
        s.nextAttemptAt = now() + Math.max(5, Math.min(3600, e.retryAfterSeconds ?? 5)) * 1000; store.savePending(s);
        return { status: s.terminal ?? 'retry', code: e instanceof PairingError ? e.code : 'HOST_UNAVAILABLE', retryAfterSeconds: Math.ceil((s.nextAttemptAt - now()) / 1000) };
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new PairingError('INVALID_RESPONSE');
      if (action === 'claim') {
        if (data.pairingId !== s.pairingId || !['claimed','approved'].includes(data.status) || (data.status === 'claimed' && (data.deviceFingerprint !== fingerprint(s) || !timestamp(data.expiresAt) || data.pollIntervalSeconds !== 5))) throw new PairingError('INVALID_RESPONSE');
        delete s.invitationSecret; store.savePending(s);
        return { status: 'claimed', fingerprint: fingerprint(s), retryAfterSeconds: 5 };
      }
      if (data.status === 'approved') {
        if (!uuid(data.worker?.id) || !name(data.worker.name) || !timestamp(data.worker.expiresAt) || Date.parse(data.worker.expiresAt) <= now() || !uuid(data.organization?.id) || typeof data.organization.name !== 'string') throw new PairingError('INVALID_RESPONSE');
        store.finalize({ version: 1, server: s.serverOrigin, workerId: data.worker.id, token: s.workerToken, name: data.worker.name, expiresAt: data.worker.expiresAt, organization: { id: data.organization.id, name: data.organization.name } });
        return { status: 'approved', credentialPath: store.credentialPath };
      }
      if (['expired','cancelled','access_denied'].includes(data.status)) { s.terminal = data.status; delete s.invitationSecret; store.savePending(s); return { status: data.status }; }
      if (data.status !== 'claimed' || !timestamp(data.expiresAt) || data.retryAfterSeconds !== 5) throw new PairingError('INVALID_RESPONSE');
      delete s.invitationSecret; store.savePending(s);
      return { status: 'claimed', fingerprint: fingerprint(s), retryAfterSeconds: 5 };
    },
  };
}
