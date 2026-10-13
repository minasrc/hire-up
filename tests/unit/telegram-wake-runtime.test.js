import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createWakeClient, listenForServiceWake } from '../../services/telegram-hosted/wake.mjs';
import { createWakeableSleep } from '../../services/telegram-connector/wakeable-sleep.mjs';
import { HostedHttpError } from '../../services/telegram-hosted/http.mjs';

const input = () => ({ instanceId: randomUUID(), leaseToken: randomUUID(), cursor: 'a'.repeat(64) });
test('wake transport sends only fenced scope and refuses extra payload, redirects and oversized responses', async () => {
  let called; const controller = new AbortController(), request = input();
  const token = 'T'.repeat(64);
  const make = response => createWakeClient({ server: 'http://127.0.0.1:8765', serviceToken: token,
    fetchImpl: async (url, options) => { called = { url, options }; return response; } });
  assert.deepEqual(await make(Response.json({ protocolVersion: 1, cursor: request.cursor, changed: false }))(request, controller.signal), { protocolVersion: 1, cursor: request.cursor, changed: false });
  assert.equal(called.url, 'http://127.0.0.1:8765/api/telegram-hosted/wake');
  assert.equal(called.options.redirect, 'error'); assert.deepEqual(JSON.parse(called.options.body), request);
  assert.equal(called.options.headers.authorization, `Bearer ${token}`);
  for (const response of [Response.json({ protocolVersion: 1, cursor: request.cursor, changed: true, qr: 'private' }),
    Response.json({ protocolVersion: 1, cursor: [request.cursor], changed: true }), new Response('a'.repeat(1025))]) {
    await assert.rejects(make(response)(request, controller.signal), /INVALID_WAKE_RESPONSE/);
  }
  await assert.rejects(make(new Response('', { status: 403 }))(request, controller.signal), error => error.status === 403 && !error.message.includes(token));
});
test('wake hint triggers a normal refresh and never installs the returned cursor as a lease', async () => {
  const controller = new AbortController(), scope = input(), codes = []; let refreshed = 0;
  await listenForServiceWake({ signal: controller.signal, scope: () => scope,
    listen: async () => ({ protocolVersion: 1, cursor: 'b'.repeat(64), changed: true }),
    refresh: async () => { refreshed++; }, stop: () => assert.fail('Unexpected stop'), output: code => codes.push(code),
    wait: async ms => { assert.equal(ms, 500); controller.abort(); } });
  assert.equal(refreshed, 1); assert.equal(scope.cursor, 'a'.repeat(64));
  assert.deepEqual(codes, ['SERVICE_WAKE_READY']);
});
test('lost wake transport backs off while fallback can run; revoked ownership stops instead of retrying', async () => {
  const controller = new AbortController(), scope = input(), codes = []; let stopped = 0;
  await listenForServiceWake({ signal: controller.signal, scope: () => scope,
    listen: async () => { throw new HostedHttpError(503); }, refresh: () => assert.fail('Must not refresh from failure'),
    stop: () => { stopped++; }, output: code => codes.push(code), wait: async ms => { assert.equal(ms, 2000); controller.abort(); } });
  assert.equal(stopped, 0); assert.deepEqual(codes, ['SERVICE_WAKE_DEFERRED']);
  for (const status of [401, 403, 409]) {
    await listenForServiceWake({ signal: new AbortController().signal, scope: () => scope,
      listen: async () => { throw new HostedHttpError(status); }, refresh: () => assert.fail('Must not refresh revoked scope'),
      stop: () => { stopped++; }, wait: () => assert.fail('Must not back off revoked ownership') });
  }
  assert.equal(stopped, 3);
});
test('late wake from a replaced instance cannot reach its successor', async () => {
  const controller = new AbortController(); let scope = input(), calls = 0; const original = scope;
  await listenForServiceWake({ signal: controller.signal, scope: () => scope,
    listen: async () => { if (++calls === 1) scope = input(); else controller.abort(); return { changed: true, cursor: original.cursor }; },
    refresh: () => assert.fail('Late response must be discarded'), stop: () => assert.fail('Unexpected stop') });
  assert.equal(calls, 2);
});
test('scheduler sleep consumes queued hints, interrupts a live timer and releases timers on shutdown', async () => {
  const controller = new AbortController(), callbacks = new Map(); let next = 0;
  const sleeper = createWakeableSleep(controller.signal, {
    schedule: callback => { callbacks.set(++next, callback); return next; }, cancel: id => callbacks.delete(id),
  });
  sleeper.wake(); sleeper.wake(); await sleeper.sleep(1000); assert.equal(callbacks.size, 0);
  const waiting = sleeper.sleep(1000); assert.equal(callbacks.size, 1);
  sleeper.wake(); await waiting; assert.equal(callbacks.size, 0);
  const shutdown = sleeper.sleep(30000); controller.abort(); await shutdown;
  assert.equal(callbacks.size, 0); await sleeper.sleep(1000); assert.equal(callbacks.size, 0);
});
