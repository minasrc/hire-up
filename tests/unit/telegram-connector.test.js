import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicEncrypt, createPublicKey, constants } from 'node:crypto';
import { createVault, acquireLock, unlockStoppedProcess } from '../../services/telegram-connector/vault.mjs';
import { createHostClient } from '../../services/telegram-connector/http.mjs';
import { createConnector } from '../../services/telegram-connector/connector.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const workerId = '22222222-2222-4222-8222-222222222222';
const challengeId = '33333333-3333-4333-8333-333333333333';
const leaseToken = '44444444-4444-4444-8444-444444444444';
const passwordSubmissionId = '55555555-5555-4555-8555-555555555555';
function storage(t, suffix = '') {
  const root = mkdtempSync(join(tmpdir(), 'telegram-connector-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, vault: createVault({ root, workerId, server: `https://example${suffix}.test` }) };
}
function encrypt(vault, task, password) {
  return publicEncrypt({ key: createPublicKey({ key: Buffer.from(vault.publicKeySpki, 'base64'), type: 'spki', format: 'der' }), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256', oaepLabel: Buffer.from(`agora-telegram:${task.id}:${task.generation}:${task.challengeId}`) }, Buffer.from(password)).toString('base64');
}
function fixture(t, overrides = {}) {
  const { vault } = storage(t);
  let time = Date.now();
  let current = { id, generation: 1, status: 'requested', challengeId, leaseToken, leaseExpiresAt: new Date(time + 120000).toISOString() };
  const calls = []; const clients = []; const responses = [];
  const profile = { telegramUserId: '123456789', username: 'synthetic_user', displayName: 'Synthetic User' };
  const host = async (action, body) => {
    calls.push({ action, body });
    if (action === 'claim') return { connection: current ? { ...current, leaseExpiresAt: new Date(time + 120000).toISOString() } : null };
    if (action === 'update') { current = { ...current, status: body.status }; return { ok: true }; }
    return { ok: true };
  };
  const createTelegram = async (session) => {
    const client = { initialSession: session, closes: 0, passwords: [], logouts: 0, session: () => 'private-telegram-session', close: async () => { client.closes++; }, profile: async () => profile, poll: async () => responses.shift() ?? null, password: async (clear) => { client.passwords.push(clear.toString()); return { status: 'connected', profile }; }, logout: async () => { client.logouts++; }, ...overrides };
    clients.push(client); return client;
  };
  const options = { vault, host, createTelegram, now: () => time };
  const connector = createConnector(options);
  t.after(() => connector.stop());
  return { connector, options, vault, calls, clients, responses, profile, get current() { return current; }, set current(value) { current = value; }, advance: (ms = 5000) => { time += ms; }, time: () => time };
}

test('vault keeps session ciphertext private, scoped and stable across restarts', (t) => {
  const { root, vault } = storage(t);
  vault.save(id, { session: 'highly-secret-session', generation: 1, state: 'connected' });
  const directory = join(root, readdirSync(root)[0]);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(join(directory, `${id}.json`)).mode & 0o777, 0o600);
  assert.ok(!readFileSync(join(directory, `${id}.json`), 'utf8').includes('highly-secret-session'));
  const restart = createVault({ root, workerId, server: 'https://example.test' });
  assert.equal(restart.publicKeySpki, vault.publicKeySpki);
  assert.equal(restart.load(id).session, 'highly-secret-session');
  assert.equal(createVault({ root, workerId, server: 'https://other.test' }).load(id), null);
  const encoded = JSON.parse(readFileSync(join(directory, `${id}.json`), 'utf8'));
  encoded.tag = Buffer.alloc(16).toString('base64');
  writeFileSync(join(directory, `${id}.json`), JSON.stringify(encoded), { mode: 0o600 });
  assert.throws(() => vault.load(id));
});

test('password ciphertext binds connection, generation and challenge', (t) => {
  const { vault } = storage(t);
  const task = { id, generation: 2, challengeId };
  task.passwordCiphertext = encrypt(vault, task, 'Synthetïc password');
  const clear = vault.decryptPassword(task);
  assert.equal(clear.toString(), 'Synthetïc password'); clear.fill(0);
  assert.throws(() => vault.decryptPassword({ ...task, generation: 3 }));
  assert.throws(() => vault.decryptPassword({ ...task, challengeId: id }));
});

test('one process lock rejects concurrent starts and cannot unlock a live process', (t) => {
  const { root } = storage(t);
  const release = acquireLock(root);
  assert.throws(() => acquireLock(root), /CONNECTOR_ALREADY_LOCKED/);
  assert.throws(() => unlockStoppedProcess(root), /CONNECTOR_STILL_RUNNING/);
  release(); acquireLock(root)();
});

test('QR, encrypted 2FA and connected restart use the same private session', async (t) => {
  const f = fixture(t);
  f.responses.push({ status: 'qr_pending', qrLoginUrl: 'tg://login?token=synthetic', qrExpiresAt: new Date(f.time() + 60000).toISOString() });
  await f.connector.tick();
  assert.equal(f.current.status, 'qr_pending');
  f.responses.push({ status: 'awaiting_password', passwordHint: 'Synthetic hint' });
  await f.connector.tick();
  f.current.passwordCiphertext = encrypt(f.vault, f.current, 'synthetic-password');
  f.current.passwordExpiresAt = new Date(f.time() + 60000).toISOString();
  f.current.passwordSubmissionId = passwordSubmissionId;
  f.advance(); await f.connector.tick();
  assert.equal(f.current.status, 'connected');
  assert.deepEqual(f.clients[0].passwords, ['synthetic-password']);
  assert.equal(f.vault.load(id).state, 'connected');
  assert.ok(!JSON.stringify(f.calls).includes('synthetic-password'));
  await f.connector.stop();
  const restart = createConnector(f.options);
  await restart.tick();
  assert.equal(f.clients[1].initialSession, 'private-telegram-session');
  assert.equal(f.current.status, 'connected');
  await restart.stop();
});

test('invalid password acknowledges its exact submission and keeps login retryable', async (t) => {
  const f = fixture(t, { password: async () => { throw new Error('PASSWORD_INVALID'); } });
  f.responses.push({ status: 'awaiting_password' }); await f.connector.tick();
  Object.assign(f.current, { passwordCiphertext: encrypt(f.vault, f.current, 'bad-password'), passwordExpiresAt: new Date(f.time() + 60000).toISOString(), passwordSubmissionId });
  f.advance(); await f.connector.tick();
  const update = f.calls.filter((c) => c.action === 'update').at(-1).body;
  assert.equal(update.status, 'awaiting_password'); assert.equal(update.errorCode, 'PASSWORD_INVALID'); assert.equal(update.passwordSubmissionId, passwordSubmissionId);
});

test('expired password is not decrypted or submitted to Telegram', async (t) => {
  const f = fixture(t);
  f.responses.push({ status: 'awaiting_password' }); await f.connector.tick();
  Object.assign(f.current, { passwordCiphertext: encrypt(f.vault, f.current, 'expired'), passwordExpiresAt: new Date(f.time() - 1).toISOString(), passwordSubmissionId });
  f.advance(); await f.connector.tick(); assert.deepEqual(f.clients[0].passwords, []);
});

test('disconnect fences old generation, remotely logs out and then deletes the session', async (t) => {
  const f = fixture(t);
  f.responses.push({ status: 'connected', profile: f.profile }); await f.connector.tick();
  f.current = { ...f.current, generation: 2, status: 'disconnecting' };
  f.advance(20000); await f.connector.tick();
  assert.equal(f.clients[0].closes, 1); assert.equal(f.clients[1].logouts, 1);
  assert.equal(f.current.status, 'disconnected'); assert.equal(f.vault.load(id), null);
});

test('logout failure stays disconnecting and retains recoverable encrypted session', async (t) => {
  const f = fixture(t, { logout: async () => { throw new Error('raw Telegram details'); } });
  f.responses.push({ status: 'connected', profile: f.profile }); await f.connector.tick();
  f.current = { ...f.current, generation: 2, status: 'disconnecting' };
  f.advance(20000); await f.connector.tick();
  assert.equal(f.current.status, 'disconnecting'); assert.equal(f.vault.load(id).state, 'connected');
  assert.equal(f.calls.at(-1).body.errorCode, 'LOGOUT_FAILED');
  assert.ok(!JSON.stringify(f.calls).includes('raw Telegram'));
});

test('restart finishes acknowledged remote logout without a second Telegram session', async (t) => {
  const f = fixture(t);
  f.current.status = 'disconnecting';
  f.vault.save(id, { generation: 1, state: 'logged_out', session: '' });
  await f.connector.tick();
  assert.equal(f.clients.length, 0); assert.equal(f.current.status, 'disconnected'); assert.equal(f.vault.load(id), null);
});

test('connected record with missing local session fails rather than starts a new login', async (t) => {
  const f = fixture(t); f.current.status = 'connected'; await f.connector.tick();
  assert.equal(f.clients.length, 0); assert.equal(f.calls.at(-1).body.errorCode, 'SESSION_MISSING');
});

test('expired lease closes a pending client and prevents stale completion', async (t) => {
  let finish;
  const f = fixture(t, { poll: () => new Promise((resolve) => { finish = resolve; }) });
  const tick = f.connector.tick();
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  f.advance(121000); await f.connector.checkLease();
  finish({ status: 'connected', profile: f.profile }); await tick;
  assert.equal(f.clients[0].closes, 1);
  assert.equal(f.calls.filter((c) => c.action === 'update').length, 0);
});

test('null claim closes client and preserves a potentially authorized session for recovery', async (t) => {
  const f = fixture(t); await f.connector.tick();
  assert.equal(f.vault.load(id).state, 'pending');
  f.current = null; f.advance(); await f.connector.tick();
  assert.equal(f.clients[0].closes, 1); assert.equal(f.vault.load(id).state, 'pending');
});

test('access revocation closes clients and stops polling', async (t) => {
  const f = fixture(t); await f.connector.tick();
  const failing = createConnector({ ...f.options, host: async () => { const error = new Error('raw response'); error.status = 403; throw error; } });
  await assert.rejects(failing.tick(), /ACCESS_DENIED/); assert.equal(failing.stopped, true);
  await failing.tick(); await failing.stop();
});

test('HTTP transport rejects insecure hosts, redirects, credentials and oversized responses', async () => {
  const token = 'x'.repeat(64);
  assert.throws(() => createHostClient({ server: 'http://example.test', token }), /INVALID_SERVER/);
  assert.throws(() => createHostClient({ server: 'https://secret@example.test', token }), /INVALID_SERVER/);
  let request;
  const host = createHostClient({ server: 'https://example.test', token, fetchImpl: async (url, options) => { request = { url, options }; return new Response(JSON.stringify({ ok: true })); } });
  await host('heartbeat', { publicKeySpki: 'synthetic' });
  assert.equal(request.options.redirect, 'error'); assert.equal(request.options.headers.Authorization, `Bearer ${token}`);
  await assert.rejects(host('heartbeat', { data: 'x'.repeat(17000) }), /REQUEST_TOO_LARGE/);
  const oversized = createHostClient({ server: 'https://example.test', token, fetchImpl: async () => new Response('x'.repeat(17000)) });
  await assert.rejects(oversized('claim'), /RESPONSE_TOO_LARGE/);
  const denied = createHostClient({ server: 'https://example.test', token, fetchImpl: async () => new Response('private raw error', { status: 403 }) });
  await assert.rejects(denied('claim'), (error) => error.message === 'ACCESS_DENIED' && error.status === 403);
});

test('new generation revokes old remote session before issuing a replacement QR', async (t) => {
  const f = fixture(t);
  f.vault.save(id, { generation: 1, state: 'connected', session: 'older-authorized-session' });
  f.current.generation = 2;
  f.responses.push({ status: 'qr_pending', qrLoginUrl: 'tg://login?token=new', qrExpiresAt: new Date(f.time() + 60000).toISOString() });
  await f.connector.tick();
  assert.equal(f.clients[0].initialSession, 'older-authorized-session');
  assert.equal(f.clients[0].logouts, 1); assert.equal(f.clients[0].closes, 1);
  assert.equal(f.clients[1].initialSession, ''); assert.equal(f.vault.load(id).generation, 2);
});

test('failed revocation preserves old credentials and blocks replacement login', async (t) => {
  const f = fixture(t, { logout: async () => { throw new Error('provider detail'); } });
  f.vault.save(id, { generation: 1, state: 'pending', session: 'possibly-authorized-session' });
  f.current.generation = 2;
  await f.connector.tick();
  assert.equal(f.clients.length, 1); assert.equal(f.vault.load(id).generation, 1);
  assert.equal(f.current.status, 'failed'); assert.equal(f.calls.at(-1).body.errorCode, 'LOGOUT_FAILED');
});

test('lost password-error acknowledgement is retried without a second password attempt', async (t) => {
  const f = fixture(t, { password: async () => { throw new Error('PASSWORD_INVALID'); } });
  let loseResponse = true;
  const host = async (action, body) => {
    const result = await f.options.host(action, body);
    if (body?.errorCode === 'PASSWORD_INVALID' && loseResponse) { loseResponse = false; throw new Error('network'); }
    return result;
  };
  const connector = createConnector({ ...f.options, host });
  t.after(() => connector.stop());
  f.responses.push({ status: 'awaiting_password' }); await connector.tick();
  Object.assign(f.current, { passwordCiphertext: encrypt(f.vault, f.current, 'bad-password'), passwordExpiresAt: new Date(f.time() + 60000).toISOString(), passwordSubmissionId });
  f.advance(); await assert.rejects(connector.tick(), /HOST_UNAVAILABLE/);
  await connector.tick();
  const acknowledgements = f.calls.filter((call) => call.body?.errorCode === 'PASSWORD_INVALID');
  assert.equal(acknowledgements.length, 2);
  assert.equal(acknowledgements[0].body.passwordSubmissionId, acknowledgements[1].body.passwordSubmissionId);
  assert.equal(f.clients.length, 1); assert.equal(f.current.status, 'awaiting_password');
});

test('slow expired-client shutdown cannot erase a newly claimed generation', async (t) => {
  const f = fixture(t);
  await f.connector.tick();
  let finishClose;
  f.clients[0].close = () => new Promise((resolve) => { finishClose = resolve; });
  f.advance(121000);
  const closing = f.connector.checkLease();
  assert.equal(typeof finishClose, 'function');
  f.current.generation = 2;
  f.responses.push({ status: 'qr_pending', qrLoginUrl: 'tg://login?token=new', qrExpiresAt: new Date(f.time() + 60000).toISOString() });
  await f.connector.tick();
  finishClose(); await closing;
  f.responses.push({ status: 'awaiting_password' }); await f.connector.tick();
  assert.equal(f.current.status, 'awaiting_password'); assert.equal(f.current.generation, 2);
});

test('timed-out connect closes a late client instead of retaining an orphan', async (t) => {
  const f = fixture(t);
  let finishConnect; let closed = 0;
  const connector = createConnector({ ...f.options, operationTimeoutMs: 5, createTelegram: () => new Promise((resolve) => { finishConnect = resolve; }) });
  await connector.tick();
  assert.equal(f.current.status, 'failed');
  finishConnect({ close: async () => { closed++; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, 1); await connector.stop();
});

test('failed pending-auth cleanup keeps logout proof for a later disconnect', async (t) => {
  const f = fixture(t);
  f.vault.save(id, { generation: 1, state: 'pending', session: 'possibly-authorized-session' });
  f.current.status = 'failed';
  await f.connector.tick();
  assert.equal(f.clients[0].logouts, 1); assert.equal(f.vault.load(id).state, 'logged_out');
  f.current = { ...f.current, generation: 2, status: 'disconnecting' };
  f.advance(); await f.connector.tick();
  assert.equal(f.clients.length, 1); assert.equal(f.current.status, 'disconnected'); assert.equal(f.vault.load(id), null);
});

test('an expired QR acknowledgement is replaced by a fresh token after host outage', async (t) => {
  const f = fixture(t); let loseResponse = true;
  const connector = createConnector({ ...f.options, host: async (action, body) => {
    if (action === 'update' && body.status === 'qr_pending' && loseResponse) { loseResponse = false; throw new Error('network'); }
    return f.options.host(action, body);
  } });
  t.after(() => connector.stop());
  f.responses.push({ status: 'qr_pending', qrLoginUrl: 'tg://login?token=old', qrExpiresAt: new Date(f.time() + 10000).toISOString() });
  await assert.rejects(connector.tick(), /HOST_UNAVAILABLE/);
  f.advance(15000);
  f.responses.push({ status: 'qr_pending', qrLoginUrl: 'tg://login?token=fresh', qrExpiresAt: new Date(f.time() + 60000).toISOString() });
  await connector.tick();
  assert.equal(f.calls.at(-1).body.qrLoginUrl, 'tg://login?token=fresh'); assert.equal(f.clients.length, 1);
});
