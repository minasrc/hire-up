import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramFactory } from '../../services/telegram-connector/telegram-adapter.mjs';

function fakeRuntime() {
  class ObjectValue { constructor(value) { Object.assign(this, value); } }
  class Authorization extends ObjectValue {}
  class LoginToken extends ObjectValue {}
  class LoginTokenMigrateTo extends ObjectValue {}
  class LoginTokenSuccess extends ObjectValue {}
  class ExportLoginToken extends ObjectValue {}
  class ImportLoginToken extends ObjectValue {}
  class CheckPassword extends ObjectValue {}
  class LogOut {}
  class GetPassword {}
  class UpdateLoginToken {}
  const Api = { auth: { Authorization, LoginToken, LoginTokenMigrateTo, LoginTokenSuccess, ExportLoginToken, ImportLoginToken, CheckPassword, LogOut }, account: { GetPassword }, UpdateLoginToken };
  const queue = []; const calls = []; const clients = [];
  class TelegramClient {
    constructor(session, apiId, apiHash, options) { this.session = session; this.options = options; clients.push(this); }
    async connect() {}
    async destroy() { this.destroyed = true; }
    addEventHandler(handler) { this.handler = handler; }
    removeEventHandler() { this.handler = null; }
    async _switchDC(id) { this.dcId = id; }
    async getMe() { return { id: 123, firstName: 'Synthetic', lastName: 'Recruiter', username: 'example' }; }
    async invoke(request) { calls.push(request); const result = queue.shift(); if (result instanceof Error) throw result; return result; }
  }
  class StringSession { constructor(value) { this.value = value; } save() { return this.value || 'session'; } }
  class Logger {}
  const proofs = [];
  const computeCheck = async (info, password) => { proofs.push({ info, password }); return 'synthetic-proof'; };
  return { runtime: [{ TelegramClient, Api }, { StringSession }, { computeCheck }, { Logger }], Api, queue, calls, clients, proofs };
}

test('actual adapter handles QR refresh signal, DC migration and account identity', async () => {
  const f = fakeRuntime();
  const create = await createTelegramFactory({ apiId: 123, apiHash: 'synthetic' }, f.runtime);
  const client = await create();
  f.queue.push(new f.Api.auth.LoginToken({ token: Buffer.from('synthetic'), expires: Math.floor(Date.now() / 1000) + 60 }));
  assert.equal((await client.poll()).status, 'qr_pending');
  assert.equal(await client.poll(), null);
  f.clients[0].handler(new f.Api.UpdateLoginToken());
  f.queue.push(new f.Api.auth.LoginTokenMigrateTo({ dcId: 4, token: 'migration-token' }), new f.Api.auth.LoginTokenSuccess({ authorization: new f.Api.auth.Authorization({ user: { id: 999, firstName: 'Synthetic', username: 'example' } }) }));
  const result = await client.poll();
  assert.equal(f.clients[0].dcId, 4); assert.equal(result.profile.telegramUserId, '999');
  assert.equal(result.status, 'connected');
  assert.ok(f.calls[2] instanceof f.Api.auth.ImportLoginToken);
  await client.close(); assert.equal(f.clients[0].destroyed, true);
});

test('actual adapter obtains 2FA hint, computes SRP proof and hides provider failures', async () => {
  const f = fakeRuntime();
  const create = await createTelegramFactory({ apiId: 123, apiHash: 'synthetic' }, f.runtime);
  const client = await create();
  const required = new Error('raw detail'); required.errorMessage = 'SESSION_PASSWORD_NEEDED';
  f.queue.push(required, { hint: 'synthetic\n hint' });
  const result = await client.poll(); assert.deepEqual(result, { status: 'awaiting_password', passwordHint: 'synthetic hint' });
  const bad = new Error('provider sensitive data'); bad.errorMessage = 'PASSWORD_HASH_INVALID';
  f.queue.push({ srpId: 'test' }, bad);
  await assert.rejects(client.password(Buffer.from('synthetic-secret')), /^Error: PASSWORD_INVALID$/);
  assert.equal(f.proofs[0].password, 'synthetic-secret');
  assert.equal(f.calls.at(-1).password, 'synthetic-proof');
  const revoked = new Error('raw revoked detail'); revoked.errorMessage = 'AUTH_KEY_UNREGISTERED';
  f.queue.push(revoked); await client.logout();
  f.queue.push(new Error('network secret')); await assert.rejects(client.logout(), /^Error: LOGOUT_FAILED$/);
  await client.close();
});

test('DC migration checkpoints the new auth key before importing an authorization token', async () => {
  const f = fakeRuntime(); const checkpoints = [];
  const create = await createTelegramFactory({ apiId: 123, apiHash: 'synthetic' }, f.runtime);
  const client = await create('', async (session) => { checkpoints.push({ session, calls: f.calls.length }); });
  f.clients[0]._switchDC = async () => { f.clients[0].session.value = 'new-dc-session'; };
  f.queue.push(new f.Api.auth.LoginTokenMigrateTo({ dcId: 4, token: 'migration-token' }), new Error('lost authorized response'));
  await assert.rejects(client.poll(), /^Error: TELEGRAM_UNAVAILABLE$/);
  assert.deepEqual(checkpoints, [{ session: 'new-dc-session', calls: 1 }]);
  assert.ok(f.calls[1] instanceof f.Api.auth.ImportLoginToken);
  await client.close();
});
