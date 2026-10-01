const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const states = new Set(['requested', 'qr_pending', 'awaiting_password', 'connected', 'disconnecting', 'disconnected', 'failed']);
const errors = new Set(['AUTH_FAILED', 'PASSWORD_INVALID', 'LOGIN_EXPIRED', 'SESSION_MISSING', 'SESSION_REVOKED', 'TELEGRAM_UNAVAILABLE', 'LOGOUT_FAILED']);
function validateTask(task, now) {
  if (!task || !uuid.test(task.id) || !uuid.test(task.leaseToken) || !uuid.test(task.challengeId) || !Number.isSafeInteger(task.generation) || task.generation < 1 || !states.has(task.status) || !Number.isFinite(Date.parse(task.leaseExpiresAt)) || Date.parse(task.leaseExpiresAt) <= now || Date.parse(task.leaseExpiresAt) > now + 125000) throw new Error('INVALID_HOST_RESPONSE');
  return task;
}
export function createConnector({ host, vault, createTelegram, now = Date.now, operationTimeoutMs = 15000, onConnectedTick }) {
  let task = null; let client = null; let saved = null; let epoch = 0; let stopped = false;
  let nextHeartbeat = 0; let nextClaim = 0; let nextKeepalive = 0; let pendingReport = null; let busy = false;
  let connectedProfile = null; let clientAbort = new AbortController();
  let seenCiphertext = null; let nextLogout = 0; let logoutFailures = 0;
  const close = async () => { clientAbort.abort(); connectedProfile = null; const previous = client; client = null; if (previous) await previous.close().catch(() => {}); };
  const active = (version) => !stopped && version === epoch && task && Date.parse(task.leaseExpiresAt) > now();
  async function operation(fn, version) {
    let timer;
    try {
      const value = await Promise.race([fn(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('TELEGRAM_UNAVAILABLE')), operationTimeoutMs); })]);
      if (!active(version)) throw new Error('STALE_TASK');
      return value;
    } finally { clearTimeout(timer); }
  }
  async function report(fields, version = epoch) {
    if (!active(version)) throw new Error('STALE_TASK');
    await host('update', { connectionId: task.id, generation: task.generation, leaseToken: task.leaseToken, ...fields, ...(['qr_pending', 'awaiting_password'].includes(fields.status) ? { challengeId: task.challengeId } : {}) });
    if (!active(version)) throw new Error('STALE_TASK');
    task = { ...task, status: fields.status };
    if (fields.status === 'connected') connectedProfile = fields.profile;
    pendingReport = null;
  }
  function persist(state) {
    saved = { generation: task.generation, state, session: client.session() };
    vault.save(task.id, saved);
  }
  async function open(version, session) {
    // A timed-out connect can still resolve: destroy that late client immediately.
    const created = createTelegram(session, (updatedSession) => {
      if (!active(version)) throw new Error('STALE_TASK');
      saved = { generation: task.generation, state: saved?.state === 'connected' ? 'connected' : 'pending', session: updatedSession };
      vault.save(task.id, saved);
    }).then(async (value) => { if (!active(version)) { await value.close().catch(() => {}); throw new Error('STALE_TASK'); } return value; });
    client = await operation(() => created, version);
    clientAbort = new AbortController();
  }
  async function work() {
    const version = epoch;
    if (!task || !active(version)) return;
    if (task.status === 'failed' || task.status === 'disconnected') {
      saved ??= vault.load(task.id);
      await close();
      // Pending authentication may already have succeeded remotely before its
      // acknowledgement was lost. Revoke before deleting even pending sessions.
      if (saved && saved.state !== 'logged_out' && now() >= nextLogout) {
        try {
          if (saved.session) { await open(version, saved.session); await operation(() => client.logout(), version); await close(); }
          saved = { generation: task.generation, state: 'logged_out', session: '' };
          vault.save(task.id, saved);
        } catch (error) {
          await close();
          if (error.message === 'STALE_TASK') throw error;
          nextLogout = now() + 30000;
        }
      }
      pendingReport = null;
      return;
    }
    if (task.status === 'disconnecting') {
      if (now() < nextLogout) return;
      try {
        saved ??= vault.load(task.id);
        if (!saved) throw new Error('LOGOUT_FAILED');
        if (saved.state !== 'logged_out') {
          if (!client) await open(version, saved.session);
          await operation(() => client.logout(), version);
          // Persist remote acknowledgement before deletion/report, allowing safe restart.
          vault.save(task.id, { generation: task.generation, state: 'logged_out', session: '' });
          saved = { state: 'logged_out' };
          await close();
        }
        await report({ status: 'disconnected' }, version);
        vault.remove(task.id);
        vault.removeHistory?.(task.id);
        saved = null; logoutFailures = 0;
      } catch (error) {
        if (error.message === 'STALE_TASK' || error.status) throw error;
        logoutFailures = Math.min(logoutFailures + 1, 5);
        nextLogout = now() + Math.min(30000, 1000 * 2 ** logoutFailures);
        await report({ status: 'disconnecting', errorCode: 'LOGOUT_FAILED' }, version);
      }
      return;
    }
    if (pendingReport?.status === 'qr_pending' && Date.parse(pendingReport.qrExpiresAt) <= now() + 1000) pendingReport = null;
    if (pendingReport) { await report(pendingReport, version); return; }
    if (!client) {
      saved = vault.load(task.id);
      if (saved && saved.generation !== task.generation) {
        // A retry is a new login generation, not permission to orphan an old
        // remotely authorized session. Preserve the vault until logout succeeds.
        try {
          if (saved.session) { await open(version, saved.session); await operation(() => client.logout(), version); await close(); }
          vault.remove(task.id); saved = null;
        } catch (error) {
          await close();
          if (error.message === 'STALE_TASK' || error.status) throw error;
          await report({ status: 'failed', errorCode: 'LOGOUT_FAILED' }, version);
          return;
        }
      }
      if (task.status === 'connected' && (!saved?.session || saved.state !== 'connected')) { await report({ status: 'failed', errorCode: 'SESSION_MISSING' }, version); return; }
      if (task.status === 'awaiting_password' && !saved?.session) { await report({ status: 'failed', errorCode: 'SESSION_MISSING' }, version); return; }
      await open(version, saved?.session ?? '');
      if (saved?.state === 'connected') {
        const profile = await operation(() => client.profile(), version);
        pendingReport = { status: 'connected', profile };
        await report(pendingReport, version);
        nextKeepalive = now() + 60000;
        return;
      }
      persist('pending');
    }
    if (task.status === 'connected') {
      if (now() >= nextKeepalive) { connectedProfile = await operation(() => client.profile(), version); nextKeepalive = now() + 60000; }
      if (onConnectedTick && connectedProfile) await onConnectedTick({ connectionId: task.id, generation: task.generation, connectionLeaseToken: task.leaseToken, connectionLeaseExpiresAt: task.leaseExpiresAt, accountUserId: connectedProfile.telegramUserId, telegram: { ...client.history, cv: client.cv }, signal: clientAbort.signal, isActive: () => active(version) && task.status === 'connected' });
      return;
    }
    if (task.status === 'awaiting_password') {
      if (!task.passwordCiphertext || task.passwordCiphertext === seenCiphertext || !uuid.test(task.passwordSubmissionId ?? '') || !Number.isFinite(Date.parse(task.passwordExpiresAt)) || Date.parse(task.passwordExpiresAt) <= now()) return;
      seenCiphertext = task.passwordCiphertext;
      let clear;
      try {
        try { clear = vault.decryptPassword(task); } catch { throw new Error('PASSWORD_INVALID'); }
        const result = await operation(() => client.password(clear), version);
        persist('connected');
        pendingReport = result;
        await report(result, version);
      } catch (error) {
        if (error.message !== 'PASSWORD_INVALID') throw error;
        pendingReport = { status: 'awaiting_password', errorCode: 'PASSWORD_INVALID', passwordSubmissionId: task.passwordSubmissionId };
        await report(pendingReport, version);
      } finally { clear?.fill(0); if (task) task.passwordCiphertext = null; }
      return;
    }
    const result = await operation(() => client.poll(), version);
    if (result) {
      persist(result.status === 'connected' ? 'connected' : 'pending');
      pendingReport = result;
      await report(result, version);
    }
  }
  return {
    get stopped() { return stopped; },
    async tick() {
      if (stopped || busy) return;
      busy = true;
      try {
        if (task && Date.parse(task.leaseExpiresAt) <= now()) { epoch++; task = null; nextClaim = 0; pendingReport = null; await close(); }
        if (now() >= nextHeartbeat) { await host('heartbeat', { publicKeySpki: vault.publicKeySpki }); nextHeartbeat = now() + 30000; }
        if (now() >= nextClaim) {
          const response = await host('claim', {});
          if (!Object.hasOwn(response, 'connection')) throw new Error('INVALID_HOST_RESPONSE');
          const incoming = response.connection === null ? null : validateTask(response.connection, now());
          if (task?.id !== incoming?.id || task?.generation !== incoming?.generation || task?.leaseToken !== incoming?.leaseToken || (incoming?.status === 'failed' && task?.status !== 'failed') || incoming === null) {
            epoch++; await close();
            if (!incoming && task) { const record = vault.load(task.id); if (record?.state === 'logged_out') vault.remove(task.id); }
            pendingReport = null; saved = null; seenCiphertext = null; nextLogout = 0; logoutFailures = 0;
          }
          task = incoming;
          nextClaim = now() + (task?.status === 'connected' ? 20000 : 5000);
        }
        await work();
      } catch (error) {
        if (error.status === 401 || error.status === 403) { stopped = true; epoch++; await close(); throw new Error('ACCESS_DENIED'); }
        if (error.status === 409 || error.message === 'STALE_TASK') { epoch++; await close(); task = null; pendingReport = null; nextClaim = 0; return; }
        if (errors.has(error.message) && task && active(epoch)) {
          const code = error.message;
          epoch++; await close();
          pendingReport = null;
          await report({ status: 'failed', errorCode: code });
        } else throw new Error('HOST_UNAVAILABLE');
      } finally { busy = false; }
    },
    async checkLease() { if (task && Date.parse(task.leaseExpiresAt) <= now()) { epoch++; task = null; pendingReport = null; nextClaim = 0; await close(); } },
    async stop() { stopped = true; epoch++; await close(); },
  };
}
