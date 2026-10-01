// Loaded only by the Mac CLI, never imported into the hosted application bundle.
export async function createTelegramFactory({ apiId, apiHash }, runtime) {
  const [{ TelegramClient, Api }, { StringSession }, { computeCheck }, { Logger }] = runtime ?? await Promise.all([
    import('teleproto'), import('teleproto/sessions'), import('teleproto/Password.js'), import('teleproto/extensions'),
  ]);
  const profile = (user) => ({ telegramUserId: String(user.id), username: user.username ?? null, displayName: `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) });
  return async (session = '', checkpointSession = () => {}) => {
    const client = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 1, requestRetries: 1, floodSleepThreshold: 0, autoReconnect: false, baseLogger: new Logger('none') });
    client._errorHandler = async () => {};
    let refresh = true; let expiresAt = 0; let passwordNeeded = false;
    const handler = (update) => { if (update instanceof Api.UpdateLoginToken) refresh = true; };
    client.addEventHandler(handler);
    try { await client.connect(); } catch { await client.destroy().catch(() => {}); throw new Error('TELEGRAM_UNAVAILABLE'); }
    async function tokenResult(result, depth = 0) {
      if (result instanceof Api.auth.LoginToken) {
        expiresAt = result.expires * 1000;
        return { status: 'qr_pending', qrLoginUrl: `tg://login?token=${Buffer.from(result.token).toString('base64url')}`, qrExpiresAt: new Date(expiresAt).toISOString() };
      }
      if (result instanceof Api.auth.LoginTokenSuccess && result.authorization instanceof Api.auth.Authorization) return { status: 'connected', profile: profile(result.authorization.user) };
      if (result instanceof Api.auth.LoginTokenMigrateTo && depth < 2) {
        await client._switchDC(result.dcId);
        // Import can authorize remotely even when its response is lost. Save the
        // migrated auth key first so recovery can still revoke that session.
        await checkpointSession(client.session.save());
        return tokenResult(await client.invoke(new Api.auth.ImportLoginToken({ token: result.token })), depth + 1);
      }
      throw new Error('AUTH_FAILED');
    }
    return {
      session: () => client.session.save(),
      close: async () => { client.removeEventHandler(handler); await client.destroy(); },
      profile: async () => {
        try { return profile(await client.getMe()); } catch (error) { throw new Error(['AUTH_KEY_UNREGISTERED', 'SESSION_REVOKED', 'SESSION_EXPIRED', 'USER_DEACTIVATED'].includes(error.errorMessage) ? 'SESSION_REVOKED' : 'TELEGRAM_UNAVAILABLE'); }
      },
      poll: async () => {
        if (passwordNeeded || (!refresh && expiresAt > Date.now() + 5000)) return null;
        refresh = false;
        try { return await tokenResult(await client.invoke(new Api.auth.ExportLoginToken({ apiId, apiHash, exceptIds: [] }))); }
        catch (error) {
          if (error.errorMessage === 'SESSION_PASSWORD_NEEDED') {
            passwordNeeded = true;
            const info = await client.invoke(new Api.account.GetPassword());
            return { status: 'awaiting_password', passwordHint: String(info.hint ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100) };
          }
          throw new Error(error.message === 'AUTH_FAILED' ? 'AUTH_FAILED' : 'TELEGRAM_UNAVAILABLE');
        }
      },
      password: async (clear) => {
        try {
          const info = await client.invoke(new Api.account.GetPassword());
          const proof = await computeCheck(info, clear.toString('utf8'));
          const result = await client.invoke(new Api.auth.CheckPassword({ password: proof }));
          passwordNeeded = false;
          return { status: 'connected', profile: profile(result.user) };
        } catch (error) { throw new Error(error.errorMessage === 'PASSWORD_HASH_INVALID' ? 'PASSWORD_INVALID' : 'TELEGRAM_UNAVAILABLE'); }
      },
      logout: async () => {
        try { await client.invoke(new Api.auth.LogOut()); }
        catch (error) { if (!['AUTH_KEY_UNREGISTERED', 'SESSION_REVOKED', 'SESSION_EXPIRED'].includes(error.errorMessage)) throw new Error('LOGOUT_FAILED'); }
      },
    };
  };
}
