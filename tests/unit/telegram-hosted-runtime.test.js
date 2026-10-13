import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, chmodSync, linkSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServiceStore, readPrivateJson } from '../../services/telegram-hosted/store.mjs';
import { createControlClient } from '../../services/telegram-hosted/http.mjs';
import { createSupervisor, connectorStatusCode, launchConnector, terminateChild } from '../../services/telegram-hosted/supervisor.mjs';
import { once } from 'node:events';
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
function supervisorFixture({ earlyExitFirst = false, output = () => {} } = {}) {
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
  const supervisor = createSupervisor({ control, store: { prepare: () => prepared }, api, output,
    wall: () => now, monotonic: () => mono, spawn: async (_entry, _record, grant) => {
      const child = new EventEmitter(); child.exitCode = earlyExitFirst && !children.length ? 1 : null; child.signalCode = null;
      child.connected = true; child.send = () => {}; child.grant = grant;
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
test('a child that exits during launch does not occupy its slot or suppress restart', async () => {
  const f = supervisorFixture({ earlyExitFirst: true }); await f.supervisor.refresh(); await f.supervisor.reconcile();
  assert.equal(f.supervisor.snapshot().runningConnectors, 0);
  f.advance(3000); await f.supervisor.reconcile();
  assert.equal(f.supervisor.snapshot().runningConnectors, 1); await f.supervisor.stop();
});
test('late successful renewal cannot resurrect old children or expired ownership', async () => {
  const f = supervisorFixture(); await f.supervisor.refresh(); await f.supervisor.reconcile();
  let resolve; f.delayHeartbeat(new Promise(done => { resolve = done; }));
  const refreshing = f.supervisor.refresh(); f.advance(80000); f.supervisor.watch();
  resolve(); await refreshing; await f.supervisor.stop();
  assert.equal(f.supervisor.stopped, true); assert.equal(f.children[0].terminated, true);
});
test('real hosted child receives IPC, stops on lost parent and can be forcibly terminated', { timeout: 15000 }, async t => {
  const { root } = fixture(t);
  const entrypoint = join(root, 'synthetic-child.mjs');
  const guardModule = new URL('../../services/telegram-connector/supervision.mjs', import.meta.url).href;
  writeFileSync(entrypoint, `import {createSupervisionGuard} from ${JSON.stringify(guardModule)};
    const guard=createSupervisionGuard({onLost:()=>process.exit(0)});
    await guard.ready();
    process.on('SIGTERM',()=>{});
    process.send({ready:true});\n`, { mode: 0o600 });
  const grant = { type: 'telegram-hosted-lease', leaseToken: randomUUID(), deadline: Date.now() + 74000 };
  const record = { configPath: join(root, 'unused.json'), stateDirectory: root };
  const first = await launchConnector(entrypoint, record, grant);
  t.after(() => { if (first.exitCode === null && first.signalCode === null) first.kill('SIGKILL'); });
  assert.equal((await once(first, 'message'))[0].ready, true);
  const exited = once(first, 'exit'); first.disconnect(); await exited;
  assert.equal(first.exitCode, 0);
  const second = await launchConnector(entrypoint, record, { ...grant, deadline: Date.now() + 74000 });
  t.after(() => { if (second.exitCode === null && second.signalCode === null) second.kill('SIGKILL'); });
  assert.equal((await once(second, 'message'))[0].ready, true);
  await terminateChild(second); assert.equal(second.signalCode, 'SIGKILL');
  const immediate = join(root, 'immediate-exit.mjs'); writeFileSync(immediate, 'process.exit(1);', { mode: 0o600 });
  const early = await launchConnector(immediate, record, { ...grant, deadline: Date.now() + 74000 }).catch(() => null);
  if (early) { if (early.exitCode === null) await once(early, 'exit'); assert.equal(early.exitCode, 1); }
});


test('child status accepts only exact fixed code messages and never logs arbitrary payloads', async () => {
  const secret = 'synthetic-private-token';
  for (const value of [null, [], { type: 'telegram-connector-status', code: secret },
    { type: 'telegram-connector-status', code: 'CONNECTOR_STARTED', token: secret },
    { type: 'other', code: 'CONNECTOR_STARTED' }]) assert.equal(connectorStatusCode(value), null);
  assert.equal(connectorStatusCode({ type: 'telegram-connector-status', code: 'CONNECTOR_INITIALIZING' }), 'CONNECTOR_INITIALIZING');
  for (const code of ['CONNECTOR_PHONE_APPROVED', 'CONNECTOR_PASSWORD_REQUIRED', 'CONNECTOR_AUTHENTICATED', 'CONNECTOR_CONNECTION_CONFIRMED']) {
    assert.equal(connectorStatusCode({ type: 'telegram-connector-status', code }), code);
    assert.equal(connectorStatusCode({ type: 'telegram-connector-status', code, profile: 'private' }), null);
  }
  const logs = []; const f = supervisorFixture({ output: code => logs.push(code) }); await f.supervisor.refresh(); await f.supervisor.reconcile();
  f.children[0].emit('message', { type: 'telegram-connector-status', code: 'CONNECTOR_STARTED', token: secret });
  f.children[0].emit('message', { type: 'telegram-connector-status', code: secret });
  assert.deepEqual(logs, ['CONNECTOR_SPAWNED']);
  f.children[0].emit('message', { type: 'telegram-connector-status', code: 'CONNECTOR_INITIALIZING' });
  assert.deepEqual(logs, ['CONNECTOR_SPAWNED', 'CONNECTOR_INITIALIZING']);
  f.children[0].send = (_grant, callback) => callback(new Error(secret));
  await f.supervisor.refresh(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.children[0].terminated, true);
  await f.supervisor.stop();
});

test('real IPC guard stays alive through repeated renewals beyond its first deadline', async t => {
  const { root } = fixture(t);
  const entry = join(root, 'synthetic-child.mjs');
  const moduleUrl = new URL('../../services/telegram-connector/supervision.mjs', import.meta.url).href;
  writeFileSync(entry, `import { createSupervisionGuard } from ${JSON.stringify(moduleUrl)};
    const guard = createSupervisionGuard({ onLost: () => process.exit(7) });
    await guard.ready(); process.send({type:'telegram-connector-status',code:'CONNECTOR_STARTED'});
    setInterval(() => {}, 100);`, { mode: 0o600 });
  const leaseToken = randomUUID();
  const grant = () => ({ type: 'telegram-hosted-lease', leaseToken, deadline: Date.now() + 1000 });
  const child = await launchConnector(entry, { stateDirectory: root, configPath: '/synthetic/config' }, grant());
  t.after(() => terminateChild(child));
  const renewal = setInterval(() => { if (child.connected) child.send(grant(), () => {}); }, 250);
  t.after(() => clearInterval(renewal));
  await new Promise(resolve => setTimeout(resolve, 1800));
  assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
  clearInterval(renewal); await terminateChild(child);
});
