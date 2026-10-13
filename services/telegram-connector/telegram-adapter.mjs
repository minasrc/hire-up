import { createNativeAdapter } from './native-adapter.mjs';
import { createHistoryAdapter } from './history-adapter.mjs';
import { createCvAdapter } from './cv-adapter.mjs';

// Loaded only by the Mac CLI, never imported into the hosted application bundle.
export async function createTelegramFactory({ apiId, apiHash }, runtime, onAuthStatus = () => {}) {
  const [{ TelegramClient, Api }, { StringSession }, { computeCheck }, { Logger }] = runtime ?? await Promise.all([
    import('teleproto'), import('teleproto/sessions'), import('teleproto/Password.js'), import('teleproto/extensions'),
  ]);
  const profile = (user) => ({ telegramUserId: String(user.id), username: user.username ?? null, displayName: `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) });
  return async (session = '', checkpointSession = () => {}) => {
    const client = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 1, requestRetries: 1, floodSleepThreshold: 0, autoReconnect: false, baseLogger: new Logger('none') });
    client._errorHandler = async () => {};
    const switchDC = client._switchDC.bind(client);
    client._switchDC = async (dcId) => {
      const result = await switchDC(dcId);
      if (closed) throw new Error('TELEGRAM_UNAVAILABLE');
      // Both explicit QR migration and the SDK's internal RPC migration must
      // persist the new auth key before a subsequent request can authorize it.
      await checkpointSession(client.session.save());
      return result;
    };
    let refresh = true; let expiresAt = 0; let passwordNeeded = false; let authorized = false; let closed = false; let approvalSeen = false;
    const authenticated = user => {
      const value = profile(user);
      if (!authorized) onAuthStatus('CONNECTOR_AUTHENTICATED');
      authorized = true;
      return value;
    };
    const manager = client.updateManager;
    if (!manager || ['start', 'stop', 'onUpdates'].some(method => typeof manager[method] !== 'function')) {
      await client.destroy().catch(() => {});
      throw new Error('TELEGRAM_UNAVAILABLE');
    }
    // The pinned SDK can queue auth notifications behind GetState, which cannot
    // succeed before the login token is imported. Handle only this auth signal
    // directly; all account/channel synchronization uses our fenced checkpoints.
    const stopUpdates = manager.stop.bind(manager);
    manager.start = stopUpdates;
    manager.onUpdates = update => {
      if (closed || authorized) return;
      const isLogin = value => value instanceof Api.UpdateLoginToken;
      if (isLogin(update)
        || (update instanceof Api.UpdateShort && isLogin(update.update))
        || ((update instanceof Api.Updates || update instanceof Api.UpdatesCombined) && Array.isArray(update.updates) && update.updates.some(isLogin))) {
        refresh = true;
        if (!approvalSeen) { approvalSeen = true; onAuthStatus('CONNECTOR_PHONE_APPROVED'); }
      }
    };
    stopUpdates();
    try { await client.connect(); } catch { closed = true; await client.destroy().catch(() => {}); throw new Error('TELEGRAM_UNAVAILABLE'); }
    async function tokenResult(result, depth = 0) {
      if (closed) throw new Error('TELEGRAM_UNAVAILABLE');
      if (result instanceof Api.auth.LoginToken) {
        expiresAt = result.expires * 1000;
        return { status: 'qr_pending', qrLoginUrl: `tg://login?token=${Buffer.from(result.token).toString('base64url')}`, qrExpiresAt: new Date(expiresAt).toISOString() };
      }
      if (result instanceof Api.auth.LoginTokenSuccess && result.authorization instanceof Api.auth.Authorization) {
        return { status: 'connected', profile: authenticated(result.authorization.user) };
      }
      if (result instanceof Api.auth.LoginTokenMigrateTo && depth < 2) {
        await client._switchDC(result.dcId);
        return tokenResult(await client.invoke(new Api.auth.ImportLoginToken({ token: result.token })), depth + 1);
      }
      throw new Error('AUTH_FAILED');
    }
    return {
      history: { ...createHistoryAdapter({ client, Api }), native: createNativeAdapter({ client, Api }) },
      cv: createCvAdapter({ client, Api }),
      session: () => client.session.save(),
      close: async () => { closed = true; stopUpdates(); await client.destroy(); },
      profile: async () => {
        try { const user = await client.getMe(); if (closed) throw new Error('TELEGRAM_UNAVAILABLE'); return authenticated(user); } catch (error) { throw new Error(['AUTH_KEY_UNREGISTERED', 'SESSION_REVOKED', 'SESSION_EXPIRED', 'USER_DEACTIVATED'].includes(error.errorMessage) ? 'SESSION_REVOKED' : 'TELEGRAM_UNAVAILABLE'); }
      },
      poll: async () => {
        if (closed || authorized || passwordNeeded || (!refresh && expiresAt > Date.now() + 5000)) return null;
        refresh = false;
        try { return await tokenResult(await client.invoke(new Api.auth.ExportLoginToken({ apiId, apiHash, exceptIds: [] }))); }
        catch (error) {
          if (error.errorMessage === 'SESSION_PASSWORD_NEEDED') {
            if (closed) throw new Error('TELEGRAM_UNAVAILABLE');
            passwordNeeded = true;
            const info = await client.invoke(new Api.account.GetPassword());
            if (closed) throw new Error('TELEGRAM_UNAVAILABLE');
            onAuthStatus('CONNECTOR_PASSWORD_REQUIRED');
            return { status: 'awaiting_password', passwordHint: String(info.hint ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100) };
          }
          throw new Error(error.message === 'AUTH_FAILED' ? 'AUTH_FAILED' : 'TELEGRAM_UNAVAILABLE');
        }
      },
      password: async (clear) => {
        try {
          if (closed) throw new Error('TELEGRAM_UNAVAILABLE');
          const info = await client.invoke(new Api.account.GetPassword());
          const proof = await computeCheck(info, clear.toString('utf8'));
          if (closed) throw new Error('TELEGRAM_UNAVAILABLE');
          const result = await client.invoke(new Api.auth.CheckPassword({ password: proof }));
          passwordNeeded = false;
          if (closed) throw new Error('TELEGRAM_UNAVAILABLE');
          return { status: 'connected', profile: authenticated(result.user) };
        } catch (error) { throw new Error(error.errorMessage === 'PASSWORD_HASH_INVALID' ? 'PASSWORD_INVALID' : 'TELEGRAM_UNAVAILABLE'); }
      },
      logout: async () => {
        try { await client.invoke(new Api.auth.LogOut()); }
        catch (error) { if (!['AUTH_KEY_UNREGISTERED', 'SESSION_REVOKED', 'SESSION_EXPIRED'].includes(error.errorMessage)) throw new Error('LOGOUT_FAILED'); }
      },
    };
  };
}
