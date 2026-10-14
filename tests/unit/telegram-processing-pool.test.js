import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createProcessingPool } from '../../services/telegram-hosted/processing-pool.mjs';
import { createProcessingWorkers } from '../../services/telegram-hosted/processing-workers.mjs';
import { createServiceStore, readPrivateJson } from '../../services/telegram-hosted/store.mjs';
import { createSupervisor } from '../../services/telegram-hosted/supervisor.mjs';
const flush = () => new Promise(resolve => setImmediate(resolve));
const record = () => ({ requestId: randomUUID(), workerId: randomUUID(), tokenSha256: 'a'.repeat(64) });

test('shared capacity is bounded, fair across users, and search proceeds during slow extraction', async () => {
  let now = 0;
  const calls = [], waits = [];
  const pool = createProcessingPool({ now: () => now, limits: { extraction: 1, cv: 1, semantic: 1 }, createWorkers: async scope => Object.fromEntries(['extraction', 'cv', 'semantic'].map(kind => [kind, { tick: ({ signal }) => {
    calls.push([scope.requestId, kind]);
    if (kind !== 'extraction') return 'idle';
    return new Promise(resolve => { waits.push(resolve); signal.addEventListener('abort', () => resolve('stopped'), { once: true }); });
  } }])) });
  const a = record(), b = record(); await pool.reconcile([a, b]);
  pool.tick(); pool.tick(); await flush();
  assert.equal(calls.filter(([, kind]) => kind === 'extraction').length, 1);
  assert.ok(calls.some(([, kind]) => kind === 'semantic'));
  pool.tick(); await flush();
  assert.ok(calls.some(([id, kind]) => id === b.requestId && kind === 'semantic'));
  waits.shift()('completed'); await flush(); now = 100;
  pool.tick(); await flush();
  assert.deepEqual(calls.filter(([, kind]) => kind === 'extraction').map(([id]) => id), [a.requestId, b.requestId]);
  await pool.reconcile([a]); // Removal aborts b's in-flight job.
  assert.equal(pool.snapshot().scopes, 1);
  await pool.stop(); assert.deepEqual(pool.snapshot(), { scopes: 0, running: 0 });
  await pool.reconcile([b]); pool.tick(); assert.equal(pool.snapshot().scopes, 0);
});

test('one service processes two registered owners using separate credentials and pending state', async t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'processing-pool-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const server = createServer(async (request, response) => {
    await new Promise(resolve => { request.resume(); request.on('end', resolve); });
    calls.push({ path: request.url, token: request.headers.authorization });
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ job: null }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const save = (name, value) => { const path = join(root, name); writeFileSync(path, value, { mode: 0o600 }); return path; };
  const tokenFile = save('unused-account.token', 'unused-account-token');
  const providerTokenFile = save('provider.token', 'provider-private-token');
  const settings = { serverUrl: origin, workerTokenFile: tokenFile, providerBaseUrl: origin, providerModel: 'gpt-6-luna', providerTokenFile, stateDirectory: root };
  const createWorkers = await createProcessingWorkers({ server: origin,
    extractionConfigFile: save('extraction.json', JSON.stringify(settings)), cvAnalysisConfigFile: save('cv.json', JSON.stringify(settings)),
    semanticConfigFile: save('semantic.json', JSON.stringify({ serverUrl: origin, workerTokenFile: tokenFile, embeddingUrl: origin, embeddingTokenFile: providerTokenFile, stateDirectory: root })),
  });
  const store = createServiceStore({ server: origin, serviceId: randomUUID(), stateDirectory: root });
  const prepare = () => store.prepare({ requestId: randomUUID(), organizationId: randomUUID(), ownerUserId: randomUUID(), workerId: null, tokenSha256: null, state: 'pending', canRun: true }, { apiId: 123, apiHash: 'a'.repeat(32) });
  const a = prepare(), b = prepare();
  const pool = createProcessingPool({ createWorkers, limits: { extraction: 2, cv: 2, semantic: 2 } });
  t.after(() => pool.stop()); await pool.reconcile([a, b]); pool.tick();
  for (let i = 0; i < 100 && (calls.length < 6 || pool.snapshot().running); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls.length, 6);
  for (const scope of [a, b]) {
    const token = readPrivateJson(scope.credentialPath).token;
    assert.deepEqual(calls.filter(call => call.token === `Bearer ${token}`).map(call => call.path).sort(), ['/api/cv-analysis/worker/claim', '/api/profile-search/worker/claim', '/api/telegram-extraction/worker/claim']);
  }
  assert.ok(calls.every(call => call.token !== 'Bearer unused-account-token'));
  const workers = await createWorkers(a);
  const altered = readPrivateJson(a.credentialPath); altered.ownerUserId = b.ownerUserId;
  save(a.credentialPath.slice(root.length + 1), JSON.stringify(altered));
  await assert.rejects(workers.extraction.tick(), /CREDENTIAL_UNAVAILABLE/);
  assert.equal(calls.length, 6, 'changed scope is rejected before any HTTP request');
});

test('processing registry paginates dormant owners and removes revoked access', async () => {
  const a = { ...record(), organizationId: randomUUID(), ownerUserId: randomUUID(), state: 'registered', canRun: true };
  const b = { ...record(), organizationId: randomUUID(), ownerUserId: randomUUID(), state: 'registered', canRun: true };
  let scopes, suspended = 0, stopped = 0;
  const proof = randomUUID();
  const supervisor = createSupervisor({
    control: async (action, input) => action === 'heartbeat' ? { leaseToken: proof, leaseSeconds: 89, capacity: 10 }
      : input.after ? { requests: [b], nextAfter: null } : { requests: [a], nextAfter: a.requestId },
    store: { prepare: item => item }, api: {},
    processingPool: { reconcile: async records => { scopes = records; }, suspend: async () => suspended++, stop: async () => stopped++ },
  });
  await supervisor.refresh(); await supervisor.refreshProcessing();
  assert.deepEqual(scopes.map(scope => scope.requestId), [a.requestId, b.requestId]);
  b.canRun = false; b.state = 'stopped'; await supervisor.refreshProcessing();
  assert.deepEqual(scopes.map(scope => scope.requestId), [a.requestId]);
  assert.equal(suspended, 0); await supervisor.stop(); assert.equal(stopped, 1);
});
