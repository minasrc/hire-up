import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, statSync, symlinkSync, chmodSync, existsSync, linkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { createPairingClient } from '../../services/worker-pairing/client.mjs';
import { createPairingStore, readCredentialFile } from '../../services/worker-pairing/vault.mjs';
import { createPairingTransport } from '../../services/worker-pairing/transport.mjs';
import { PairingError, fingerprint, hash, origin } from '../../services/worker-pairing/protocol.mjs';
import { connectorCredential } from '../../services/telegram-connector/paired-credential.mjs';
import { readHiddenInvitation, main, safeErrorCode } from '../../services/worker-pairing/cli.mjs';
const server = 'https://platform.example', invitationSecret = 's'.repeat(43);
function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pairing-test-'))); chmodSync(directory, 0o700); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = createPairingStore({ directory }); let time = Date.now();
  const now = () => time, advance = (ms = 5000) => { time += ms; };
  const id = randomUUID(), worker = { id: randomUUID(), name: 'Recruiter Mac', expiresAt: new Date(time + 86400000).toISOString() }, organization = { id: randomUUID(), name: 'Synthetic workspace' };
  return { directory, store, now, advance, id, worker, organization, initialize(client) { return client.initialize({ serverOrigin: server, invitation: `${id}.${invitationSecret}`, deviceName: 'My Mac 🐋' }); } };
}
const approved = f => ({ status: 'approved', worker: f.worker, organization: f.organization });
const claimed = f => ({ pairingId: f.id, status: 'claimed', deviceFingerprint: fingerprint(f.store.loadPending()), expiresAt: new Date(f.now() + 600000).toISOString(), pollIntervalSeconds: 5 });

test('durable original identity, fingerprint, rate floor, approval and connector credential', async t => {
  const f = fixture(t); const calls = [];
  const client = createPairingClient({ store: f.store, now: f.now, request: async (action, proof, body) => {
    calls.push({ action, proof, body }); const pending = f.store.loadPending(); assert.equal(pending.nextAction, 'poll');
    assert.equal(body.tokenSha256 ?? hash(pending.workerToken), hash(pending.workerToken));
    return action === 'claim' ? claimed(f) : approved(f);
  } });
  const initial = f.initialize(client), original = f.store.loadPending();
  assert.equal(initial.fingerprint, hash(JSON.stringify(['worker-pairing-v1', f.id, original.claimId, hash(original.workerToken), hash(original.pollVerifier)])).slice(0, 12));
  assert.equal((await client.tick()).status, 'claimed'); assert.equal(f.store.loadPending().invitationSecret, undefined);
  assert.equal((await client.tick()).status, 'waiting'); assert.equal(calls.length, 1);
  f.advance(); assert.equal((await client.tick()).status, 'approved'); assert.equal(f.store.loadPending(), null);
  const c = f.store.loadCredential(); assert.deepEqual(c, { version: 1, server, workerId: f.worker.id, token: original.workerToken, name: f.worker.name, expiresAt: f.worker.expiresAt, organization: f.organization });
  assert.equal(statSync(f.store.credentialPath).mode & 0o777, 0o600); assert.equal(statSync(f.directory).mode & 0o777, 0o700);
  assert.deepEqual(connectorCredential({ credentialFile: './credential.json' }, {}, join(f.directory, 'connector.json')), { server, workerId: c.workerId, token: c.token });
  assert.throws(() => connectorCredential({ credentialFile: f.store.credentialPath, workerId: randomUUID() }, {}), /PAIRED_CREDENTIAL_CONFLICT/);
  assert.deepEqual(connectorCredential({ server, workerId: c.workerId, token: c.token }, {}), { server, workerId: c.workerId, token: c.token });
});

test('lost claim ACK and final poll ACK recover after restart with exact token and verifier', async t => {
  const f = fixture(t); let accepted, phase = 0;
  const request = async (action, proof, body) => {
    if (phase === 0) { accepted = { proof, body }; phase++; throw new PairingError('HOST_UNAVAILABLE'); }
    assert.equal(action, 'poll'); assert.equal(hash(proof), accepted.body.verifierSha256);
    if (phase++ === 1) throw new PairingError('HOST_UNAVAILABLE'); return approved(f);
  };
  let client = createPairingClient({ store: f.store, request, now: f.now }); f.initialize(client); const token = f.store.loadPending().workerToken;
  assert.equal((await client.tick()).status, 'retry');
  for (const expected of ['retry', 'approved']) { f.advance(); client = createPairingClient({ store: createPairingStore({ directory: f.directory }), request, now: f.now }); assert.equal((await client.tick()).status, expected); }
  assert.equal(f.store.loadCredential().token, token);
});

test('uncommitted claim retries exact proof/body after verifier poll returns404', async t => {
  const f = fixture(t); const claims = [];
  const client = createPairingClient({ store: f.store, now: f.now, request: async (action, proof, body) => {
    if (action === 'poll') throw new PairingError('PAIRING_UNAVAILABLE', 404);
    claims.push({ proof, body }); if (claims.length === 1) throw new PairingError('HOST_UNAVAILABLE'); return claimed(f);
  } }); f.initialize(client);
  await client.tick(); f.advance(); await client.tick(); f.advance(); assert.equal((await client.tick()).status, 'claimed'); assert.deepEqual(claims[0], claims[1]);
});

test('crash after credential commit clears pending only with matching original identity', async t => {
  const f = fixture(t); const client = createPairingClient({ store: f.store, now: f.now, request: async () => assert.fail() }); f.initialize(client);
  const p = f.store.loadPending(), c = { version: 1, server, workerId: f.worker.id, token: p.workerToken, name: f.worker.name, expiresAt: f.worker.expiresAt, organization: f.organization };
  writeFileSync(f.store.credentialPath, JSON.stringify(c), { mode: 0o600 });
  assert.equal((await client.tick()).status, 'approved'); assert.equal(f.store.loadPending(), null);
  f.store.savePending({ ...p, workerToken: 'x'.repeat(64) }); await assert.rejects(client.tick(), /LOCAL_STATE_EXISTS/); assert.ok(f.store.loadPending());
});

test('claim conflicts and verifier terminal states never replace pending identity', async t => {
  for (const status of ['expired', 'cancelled', 'access_denied', 'claim_conflict']) {
    const f = fixture(t); const client = createPairingClient({ store: f.store, now: f.now, request: async action => { if (status === 'claim_conflict') throw new PairingError('PAIRING_CLAIMED', 409); return action === 'claim' ? claimed(f) : { status }; } });
    f.initialize(client); const token = f.store.loadPending().workerToken; await client.tick(); f.advance(); assert.equal((await client.tick()).status, status);
    assert.equal(f.store.loadPending().workerToken, token); assert.equal(f.store.loadCredential(), null); assert.throws(() => f.initialize(client), /LOCAL_STATE_EXISTS/);
  }
});

test('unclaimed expired invitation stops without regenerating secrets', async t => {
  const f = fixture(t); const client = createPairingClient({ store: f.store, now: f.now, request: async action => { throw new PairingError(action === 'claim' ? 'HOST_UNAVAILABLE' : 'PAIRING_UNAVAILABLE', action === 'claim' ? 503 : 404); } });
  f.initialize(client); await client.tick(); f.advance(600001); assert.equal((await client.tick()).status, 'expired');
});

test('transport proof header, no cookies, request origin and bounded fixed error codes', async () => {
  const raw = 'PRIVATE ' + invitationSecret; let observed;
  const request = createPairingTransport({ server, fetchImpl: async (url, options) => { observed = { url, ...options }; return Response.json({ error: raw, code: raw }, { status: 500 }); } });
  await assert.rejects(request('claim', invitationSecret, { pairingId: randomUUID() }), e => e.code === 'HOST_UNAVAILABLE' && !String(e).includes(raw));
  assert.equal(observed.credentials, 'omit'); assert.equal(observed.redirect, 'error'); assert.equal(observed.headers.Authorization, `PairingInvite ${invitationSecret}`); assert.equal(observed.headers.Cookie, undefined); assert.ok(!observed.url.includes(invitationSecret));
  for (const value of ['http://evil.example','https://a.example/path','https://user:pw@a.example','https://a.example/?secret=1']) assert.throws(() => origin(value), /INVALID_SERVER/);
  assert.equal(origin('http://127.0.0.1:9123'), 'http://127.0.0.1:9123');
});

test('429 honors bounded matching Retry-After; malformed responses remain redacted and backed off', async t => {
  const f = fixture(t); let calls = 0;
  const request = createPairingTransport({ server, fetchImpl: async () => { calls++; return Response.json({ code: 'PAIRING_RATE_LIMIT', retryAfterSeconds: 45 }, { status: 429, headers: { 'Retry-After': '45' } }); } });
  const client = createPairingClient({ store: f.store, now: f.now, request }); f.initialize(client);
  assert.equal((await client.tick()).retryAfterSeconds, 45); f.advance(44000); assert.equal((await client.tick()).status, 'waiting'); assert.equal(calls, 1);
  for (const retry of [0, 99999, 'secret', 5]) {
    const malformed = createPairingTransport({ server, fetchImpl: async () => Response.json({ code: 'PAIRING_RATE_LIMIT', retryAfterSeconds: retry }, { status: 429, headers: { 'Retry-After': 'different' } }) });
    await assert.rejects(malformed('poll', invitationSecret, {}), e => e.code === 'INVALID_RESPONSE' && e.retryAfterSeconds === 60);
  }
});

test('oversized/malformed response, abort and redirects never echo server detail', async () => {
  for (const body of ['not json', JSON.stringify({ text: 'x'.repeat(9000) })]) {
    const request = createPairingTransport({ server, fetchImpl: async () => new Response(body) });
    await assert.rejects(request('poll', invitationSecret, {}), /INVALID_RESPONSE/);
  }
  const request = createPairingTransport({ server, fetchImpl: async () => { throw new Error(invitationSecret); } });
  await assert.rejects(request('poll', invitationSecret, {}), /HOST_UNAVAILABLE/);
  const redirect = createPairingTransport({ server, fetchImpl: async () => ({ redirected: true }) });
  await assert.rejects(redirect('poll', invitationSecret, {}), /INVALID_RESPONSE/);
});

test('fingerprint mismatch and malformed approved identity cannot write credentials', async t => {
  const f = fixture(t); const client = createPairingClient({ store: f.store, now: f.now, request: async action => action === 'claim' ? { ...claimed(f), deviceFingerprint: '000000000000' } : { ...approved(f), worker: { ...f.worker, id: 'bad' } } }); f.initialize(client);
  await assert.rejects(client.tick(), /INVALID_RESPONSE/); f.advance(); await assert.rejects(client.tick(), /INVALID_RESPONSE/); assert.equal(f.store.loadCredential(), null);
});

test('private path, file modes, symlinks and existing identities are enforced', t => {
  const f = fixture(t); const client = createPairingClient({ store: f.store }); f.initialize(client);
  assert.throws(() => f.initialize(client), /LOCAL_STATE_EXISTS/);
  chmodSync(join(f.directory, 'pending.json'), 0o644); assert.throws(() => f.store.loadPending(), /UNSAFE_LOCAL_FILE/); chmodSync(join(f.directory, 'pending.json'), 0o600);
  symlinkSync(join(f.directory, 'pending.json'), join(f.directory, 'credential.json')); assert.throws(() => f.store.loadCredential(), /UNSAFE_LOCAL_FILE/);
  symlinkSync(f.directory, join(f.directory, 'alias')); assert.throws(() => createPairingStore({ directory: join(f.directory, 'alias', 'child') }), /UNSAFE_LOCAL_DIRECTORY/); assert.equal(existsSync(join(f.directory, 'child')), false);
  chmodSync(f.directory, 0o755); assert.throws(() => createPairingStore({ directory: f.directory }), /UNSAFE_LOCAL_DIRECTORY/); chmodSync(f.directory, 0o700);
});

test('process locks prevent two clients; live PID cannot be unlocked', t => {
  const f = fixture(t); const release = f.store.lock(); assert.throws(() => f.store.lock(), /PAIRING_ALREADY_RUNNING/); assert.throws(() => f.store.unlock(), /PAIRING_ALREADY_RUNNING/); release();
});

test('hidden stdin never echoes secret, rejects pipes, restores terminal on cancel', async () => {
  assert.throws(() => readHiddenInvitation(new PassThrough()), /TTY_REQUIRED/);
  const input = new PassThrough(); input.isTTY = true; input.setRawMode = raw => { input.isRaw = raw; }; let output = '';
  const pending = readHiddenInvitation(input, { write: text => { output += text; } });
  const value = `${randomUUID()}.${invitationSecret}`; input.write(value + '\r'); assert.equal(await pending, value); assert.ok(!output.includes(invitationSecret)); assert.equal(input.isRaw, false);
  const ctrl = new AbortController(); const cancelled = readHiddenInvitation(input, { write() {} }, ctrl.signal); ctrl.abort(); await assert.rejects(cancelled, /CANCELLED/); assert.equal(input.isRaw, false);
});

test('CLI rejects secret arguments and resuming mismatched origins without prompting', async t => {
  const f = fixture(t); const client = createPairingClient({ store: f.store }); f.initialize(client); let prompted = false;
  await assert.rejects(main(['--directory', f.directory, '--invitation', invitationSecret]), /INVALID_INPUT/);
  await assert.rejects(main(['--directory', f.directory, '--server', 'https://different.example'], { prompt: async () => { prompted = true; } }), /LOCAL_STATE_EXISTS/);
  assert.equal(prompted, false); assert.equal(safeErrorCode(new Error(invitationSecret)), 'PAIRING_FAILED');
  assert.ok(!readFileSync(join(f.directory, 'pending.json'), 'utf8').includes('different.example'));
  assert.throws(() => readCredentialFile(join(f.directory, 'missing')), /UNSAFE_LOCAL_FILE/);
});

test('CLI completes hidden-prompt enrollment against synthetic HTTP transport without logging secrets', async t => {
  const f = fixture(t); let printed = '', polls = 0; const invitation = `${f.id}.${invitationSecret}`;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.credentials, 'omit');
    if (url.endsWith('/claim')) return Response.json(claimed(f));
    polls++; return Response.json(approved(f));
  });
  await main(['--server', server, '--directory', f.directory, '--name', 'My Mac 🐋'], { prompt: async () => invitation, output: { write: text => { printed += text; } } });
  assert.equal(polls, 1); const c = f.store.loadCredential(); assert.ok(c); assert.ok(printed.includes('Mac paired'));
  assert.ok(!printed.includes(c.token)); assert.ok(!printed.includes(invitation)); assert.equal(f.store.loadPending(), null);
});

test('crash staging is reaped only after exclusive local lock, without touching arbitrary files', t => {
  const f = fixture(t); const staged = join(f.directory, '.abcdefabcdefabcdefabcdef.tmp');
  writeFileSync(staged, '{\"interrupted-write\":', { mode: 0o600 });
  writeFileSync(join(f.directory, 'operator.json'), '{}', { mode: 0o600 });
  const release = f.store.lock(); assert.equal(existsSync(staged), false); assert.equal(existsSync(join(f.directory, 'operator.json')), true); release();
});


test('interrupted atomic PID publication leaves no lock or a complete recoverable lock', t => {
  const f = fixture(t); const staged = join(f.directory, '.aaaaaaaaaaaaaaaaaaaaaaaa.tmp');
  const lock = join(f.directory, 'pairing.lock');
  // Crash before publication: incomplete staging never occupies the lock name.
  writeFileSync(staged, '{"pid":', { mode: 0o600 });
  let release = f.store.lock(); assert.equal(JSON.parse(readFileSync(lock)).pid, process.pid); release();
  // Crash just after atomic publication: both links contain the complete PID.
  writeFileSync(staged, JSON.stringify({ pid: process.pid }), { mode: 0o600 }); linkSync(staged, lock);
  assert.equal(statSync(lock).nlink, 2); assert.throws(() => f.store.unlock(), /PAIRING_ALREADY_RUNNING/);
  unlinkSync(lock); unlinkSync(staged);
  writeFileSync(staged, JSON.stringify({ pid: 2147483647 }), { mode: 0o600 }); linkSync(staged, lock);
  f.store.unlock(); assert.equal(existsSync(lock), false);
  release = f.store.lock(); assert.equal(existsSync(staged), false); release();
});
