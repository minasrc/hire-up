import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, chmodSync, linkSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServiceStore, readPrivateJson } from '../../services/telegram-hosted/store.mjs';
import { createControlClient } from '../../services/telegram-hosted/http.mjs';
import { createSupervisor } from '../../services/telegram-hosted/supervisor.mjs';
import { createSupervisionGuard } from '../../services/telegram-connector/supervision.mjs';

const api = { apiId: 12345, apiHash: 'a'.repeat(32) };
const pending = () => ({ requestId: randomUUID(), organizationId: randomUUID(), ownerUserId: randomUUID(),
  workerId: null, tokenSha256: null, state: 'pending', canRun: true });
function fixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'hosted-runtime-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, config: { server: 'http://127.0.0.1:8765', serviceId: randomUUID(), stateDirectory: root } };
}
test('durable registration retries retain tokens, keys and independent owner paths', t => {
  const { root, config } = fixture(t), store = createServiceStore(config), first = pending(), second = pending();
  const a = store.prepare(first, api), b = store.prepare(second, api);
  assert.notEqual(a.configPath, b.configPath); assert.notEqual(a.workerId, b.workerId);
  const original = readFileSync(a.configPath, 'utf8');
  const restored = createServiceStore(config).prepare({ ...first, state: 'registered', workerId: a.workerId, tokenSha256: a.tokenSha256 }, api);
  assert.equal(restored.workerId, a.workerId); assert.equal(readFileSync(a.configPath, 'utf8'), original);
  assert.throws(() => store.prepare({ ...first, workerId: randomUUID() }, api), /LOCAL_SCOPE_CONFLICT/);
  assert.throws(() => store.prepare({ ...pending(), state: 'registered', workerId: randomUUID(), tokenSha256: 'b'.repeat(64) }, api), /LOCAL_CREDENTIAL_MISSING/);
  assert.throws(() => createServiceStore({ ...config, serviceId: randomUUID() }), /LOCAL_SCOPE_CONFLICT/);
  assert.ok(existsSync(join(root, 'service.json')));
});
test('private store rejects unsafe paths and arbitrary links while recovering interrupted publication', t => {
  const { root, config } = fixture(t); createServiceStore(config);
  const target = join(root, 'private.json'); writeFileSync(target, '{"preserved":true}', { mode: 0o600 });
  const temporary = join(root, `.new-${'a'.repeat(32)}`); linkSync(target, temporary);
  assert.equal(readPrivateJson(target).preserved, true); assert.equal(existsSync(temporary), false);
  linkSync(target, join(root, 'unexpected-link.json'));
  assert.throws(() => readPrivateJson(target), /UNSAFE_LOCAL_FILE/);
  const unsafe = join(root, 'unsafe.json'); writeFileSync(unsafe, '{}', { mode: 0o644 }); chmodSync(unsafe, 0o644);
  assert.throws(() => readPrivateJson(unsafe), /UNSAFE_LOCAL_FILE/);
  symlinkSync(unsafe, join(root, 'linked.json'));
  assert.throws(() => readPrivateJson(join(root, 'linked.json')), /UNSAFE_LOCAL_FILE/);
  chmodSync(root, 0o755); assert.throws(() => createServiceStore(config), /UNSAFE_LOCAL_DIRECTORY/);
});
test('control HTTP refuses redirects, bounds bodies and does not expose credentials in errors', async () => {
  const token = 'T'.repeat(64); let called;
  const client = createControlClient({ server: 'http://127.0.0.1:8765', serviceToken: token,
    fetchImpl: async (url, options) => { called = { url, options }; return Response.json({ leaseSeconds: 89 }); } });
  assert.deepEqual(await client('heartbeat', { instanceId: randomUUID() }), { leaseSeconds: 89 });
  assert.equal(called.options.redirect, 'error'); assert.equal(called.options.headers.authorization, `Bearer ${token}`);
  await assert.rejects(client('list', { padding: 'x'.repeat(9000) }), /REQUEST_TOO_LARGE/);
  assert.throws(() => createControlClient({ server: `https://secret:${token}@example.test`, serviceToken: token }), error => error.message === 'INVALID_SERVER' && !error.cause);
  const huge = createControlClient({ server: 'http://127.0.0.1:8765', serviceToken: token,
    fetchImpl: async () => new Response('x'.repeat(65537)) });
  await assert.rejects(huge('heartbeat'), /INVALID_HOST_RESPONSE/);
});
function channelFixture(t) {
  let now = 1000000, mono = 0, lost = 0, check;
  const channel = new EventEmitter(); channel.connected = true;
  const guard = createSupervisionGuard({ channel, wall: () => now, monotonic: () => mono,
    interval: fn => { check = fn; return 1; }, clear: () => {}, onLost: () => lost++ });
  t.after(() => guard.close());
  return { guard, channel, grant: () => channel.emit('message', { type: 'telegram-hosted-lease', leaseToken: '00000000-0000-4000-8000-000000000001', deadline: now + 74000 }),
    advance: (wallDelta, monoDelta = wallDelta) => { now += wallDelta; mono += monoDelta; check(); }, lost: () => lost };
}
test('child cannot run before parent lease and cannot revive an expired grant', async t => {
  const f = channelFixture(t); assert.equal(f.guard.check(), false); f.grant(); await f.guard.ready();
  assert.equal(f.guard.check(), true); f.advance(75000); assert.equal(f.guard.check(), false); assert.equal(f.lost(), 1);
  f.grant(); assert.equal(f.guard.check(), false); assert.equal(f.lost(), 1);
});
test('child fails closed on parent crash, suspend and backward clock movement', async t => {
  for (const scenario of ['disconnect', 'suspend', 'clock-backward']) {
    const f = channelFixture(t); f.grant(); await f.guard.ready();
    if (scenario === 'disconnect') { f.channel.connected = false; f.channel.emit('disconnect'); }
    else if (scenario === 'suspend') f.advance(80000, 0);
    else f.advance(-6000, 1000);
    assert.equal(f.guard.check(), false, scenario); assert.equal(f.lost(), 1);
  }
});
function supervisorFixture() {
  let now = 1000000, mono = 0, heartbeatError = false, delayed;
  const request = pending(), leaseToken = randomUUID(), children = [], requests = [request];
  const prepared = { requestId: request.requestId, workerId: randomUUID(), tokenSha256: 'b'.repeat(64), configPath: '/synthetic/private/config.json' };
  const calls = [];
  const control = async (action, input) => {
    calls.push({ action, input });
    if (action === 'heartbeat') {
      if (heartbeatError) throw new Error('HOST_UNAVAILABLE');
      if (delayed) await delayed;
      return { leaseToken, leaseSeconds: 89, capacity: 10 };
    }
    if (action === 'list') return { requests, nextAfter: null };
    if (action === 'register') return { workerId: input.workerId, state: 'registered' };
  };
  const supervisor = createSupervisor({ control, store: { prepare: () => prepared }, api,
    wall: () => now, monotonic: () => mono, spawn: async (_entry, _record, grant) => {
      const child = new EventEmitter(); child.connected = true; child.send = () => {}; child.grant = grant;
      children.push(child); return child;
    }, terminate: async child => { child.terminated = true; child.emit('exit'); } });
  return { supervisor, children, calls, requests, prepared,
    advance: (ms, monotonicMs = ms) => { now += ms; mono += monotonicMs; },
    failHeartbeat: () => { heartbeatError = true; }, delayHeartbeat: p => { delayed = p; } };
}
test('supervisor provisions only after acknowledged lease and stops revoked owners', async () => {
  const f = supervisorFixture(); await f.supervisor.reconcile(); assert.equal(f.children.length, 0);
  await f.supervisor.refresh(); await f.supervisor.reconcile(); assert.equal(f.children.length, 1);
  assert.equal(f.calls.find(c => c.action === 'register').input.workerId, f.prepared.workerId);
  assert.ok(f.children[0].grant.deadline <= 1074000);
  f.requests[0] = { ...f.requests[0], canRun: false, state: 'stopped' };
  await f.supervisor.reconcile(); assert.equal(f.children[0].terminated, true); await f.supervisor.stop();
});
test('lost renewal does not extend ownership; suspended parent stops all children', async () => {
  const f = supervisorFixture(); await f.supervisor.refresh(); await f.supervisor.reconcile();
  f.advance(50000); f.failHeartbeat(); await f.supervisor.refresh();
  f.advance(25000); f.supervisor.watch(); await f.supervisor.stop();
  assert.equal(f.children[0].terminated, true); assert.equal(f.supervisor.snapshot().leaseAcknowledged, false);
});
test('late successful renewal cannot resurrect old children or expired ownership', async () => {
  const f = supervisorFixture(); await f.supervisor.refresh(); await f.supervisor.reconcile();
  let resolve; f.delayHeartbeat(new Promise(done => { resolve = done; }));
  const refreshing = f.supervisor.refresh(); f.advance(80000); f.supervisor.watch();
  resolve(); await refreshing; await f.supervisor.stop();
  assert.equal(f.supervisor.stopped, true); assert.equal(f.children[0].terminated, true);
});
