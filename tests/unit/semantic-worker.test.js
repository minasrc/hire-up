import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSemanticWorker } from '../../services/semantic-worker/worker.mjs';
import { createPendingStore } from '../../services/semantic-worker/store.mjs';
import { createLocalClient } from '../../services/semantic-worker/local.mjs';
import { requestJson } from '../../services/semantic-worker/transport.mjs';
import { validateConfig } from '../../services/semantic-worker/config.mjs';
import { CHUNKER_VERSION, CV_CAPABILITY, CV_PROJECTION_VERSION, INDEX_VERSION, MODEL, PROJECTION_VERSION, SemanticWorkerError } from '../../services/semantic-worker/constants.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const embedding = [1, ...Array(383).fill(0)];
const text = '工程师 👩🏽‍💻 café developer';
const versions = { indexVersion: INDEX_VERSION, projectionVersion: PROJECTION_VERSION, chunkerVersion: CHUNKER_VERSION };
function job(kind = 'plan') {
  return { id: randomUUID(), kind, leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 120000).toISOString(), ...versions,
    ...(kind === 'query' ? { query: text, querySha256: hash(text) } : { source: { sourceType: 'draft', sourceId: randomUUID(), revision: 1, sha256: hash(text), ...(kind === 'plan' ? { text } : {}) } }),
    ...(kind === 'embed' ? { manifestSha256: hash('manifest'), chunks: [{ ordinal: 0, startByte: 0, endByte: Buffer.byteLength(text), text, sha256: hash(text) }] } : {}),
  };
}
const manifest = source => ({ index_version: INDEX_VERSION, chunker_version: CHUNKER_VERSION, source_sha256: hash(source), byte_length: Buffer.byteLength(source), chunks: [{ ordinal: 0, start_byte: 0, end_byte: Buffer.byteLength(source), sha256: hash(source), token_count: 15 }] });
function memory() { let saved = null; return { load: () => saved, save: value => { saved = structuredClone(value); }, clear: () => { saved = null; } }; }
function setup(current = job(), options = {}) {
  const calls = [], vault = options.vault ?? memory();
  const host = options.host ?? (async (action, body) => { calls.push({ action, body }); return action === 'claim' ? { job: current } : { ok: true, status: 'ready' }; });
  return { calls, vault, worker: createSemanticWorker({ host, vault, plan: async ({ text: source }) => manifest(source), embed: async ({ texts }) => ({ indexVersion: INDEX_VERSION, embeddings: texts.map(() => embedding) }), ...options }) };
}

test('plan, query and passage contracts preserve versions, hashes and ordinals', async () => {
  for (const kind of ['plan', 'query', 'embed']) {
    const current = job(kind), { worker, calls } = setup(current);
    assert.equal((await worker.tick()).status, 'completed');
    assert.deepEqual(calls[0].body, { capabilities: [CV_CAPABILITY] });
    const complete = calls[1].body;
    assert.equal(complete.jobId, current.id);
    assert.equal(complete.kind, kind);
    assert.equal(complete.chunkerVersion, CHUNKER_VERSION);
    if (kind === 'plan') assert.equal(complete.result.chunks[0].endByte, Buffer.byteLength(text));
    if (kind === 'query') assert.deepEqual(complete.result.embedding, embedding);
    if (kind === 'embed') assert.deepEqual(complete.result.embeddings, [{ ordinal: 0, embedding }]);
  }
});
test('lost ACK restart replays durable receipt before claim without recalling model', async t => {
  const root = await mkdtemp(join(tmpdir(), 'semantic-store-')); t.after(() => rm(root, { recursive: true, force: true }));
  const config = { root, server: 'https://demo.example', workerToken: 'synthetic-owner-token' }, current = job('query');
  let attempts = 0, inference = 0, first;
  const host = async (action, body) => {
    if (action === 'claim') { assert.equal(attempts, 0); return { job: current }; }
    if (!attempts++) { first = structuredClone(body); throw new SemanticWorkerError('HTTP_UNAVAILABLE'); }
    assert.deepEqual(body, first); return { ok: true, status: 'completed' };
  };
  const embed = async () => { inference++; return { indexVersion: INDEX_VERSION, embeddings: [embedding] }; };
  const a = setup(current, { host, embed, vault: createPendingStore(config) });
  assert.equal((await a.worker.tick()).status, 'retry');
  const b = setup(current, { host, embed, vault: createPendingStore(config) });
  assert.equal((await b.worker.tick()).status, 'completed'); assert.equal(inference, 1);
  assert.equal(createPendingStore(config).load(), null);
  assert.equal(createPendingStore({ ...config, workerToken: 'different-owner' }).load(), null);
  const paths = await readdir(root, { recursive: true });
  for (const path of paths.filter(p => p.endsWith('.json'))) assert.ok(!(await readFile(join(root, path), 'utf8')).includes(text));
});
test('manifest cannot omit tail, split Unicode, exceed token limit or substitute text', async () => {
  for (const mutate of [p => { p.chunks[0].end_byte--; }, p => { p.chunks[0].start_byte = 1; }, p => { p.chunks[0].token_count = 449; }, p => { p.chunks[0].sha256 = hash('invented'); }]) {
    const { worker, calls } = setup(job(), { plan: async () => { const p = manifest(text); mutate(p); return p; } });
    assert.equal((await worker.tick()).status, 'failed'); assert.equal(calls[1].body.code, 'INVALID_RESULT');
  }
});
test('wrong model, dimensions, NaN and nonnormalized vectors fail explicitly', async () => {
  for (const result of [{ indexVersion: 'wrong', embeddings: [embedding] }, { indexVersion: INDEX_VERSION, embeddings: [[1]] }, { indexVersion: INDEX_VERSION, embeddings: [[NaN, ...embedding.slice(1)]] }, { indexVersion: INDEX_VERSION, embeddings: [Array(384).fill(1)] }]) {
    const { worker, calls } = setup(job('query'), { embed: async () => result });
    assert.equal((await worker.tick()).status, 'failed'); assert.equal(calls[1].body.code, 'INVALID_RESULT');
  }
});
test('token overflow is explicit failure, outage never becomes empty success', async () => {
  for (const [error, code] of [[new SemanticWorkerError('INPUT_TOO_LONG', 422), 'INPUT_TOO_LONG'], [new Error('private provider error'), 'EMBEDDING_UNAVAILABLE']]) {
    const { worker, calls } = setup(job('query'), { embed: async () => { throw error; } });
    await worker.tick(); assert.equal(calls[1].action, 'fail'); assert.equal(calls[1].body.code, code);
  }
});
test('cancelled/expired computation does not publish vectors; host409 drops superseded source', async () => {
  let clock = Date.now(); const current = job('query');
  const a = setup(current, { now: () => clock, embed: async () => { clock += 121000; return { indexVersion: INDEX_VERSION, embeddings: [embedding] }; } });
  assert.equal((await a.worker.tick()).status, 'stale'); assert.equal(a.calls.length, 1);
  const controller = new AbortController();
  const b = setup(current, { embed: async () => { controller.abort(); return { indexVersion: INDEX_VERSION, embeddings: [embedding] }; } });
  assert.equal((await b.worker.tick({ signal: controller.signal })).status, 'retry'); assert.equal(b.calls.length, 1);
  const c = setup(current, { host: async action => { if (action === 'claim') return { job: current }; throw new SemanticWorkerError('HTTP_UNAVAILABLE', 409); } });
  assert.equal((await c.worker.tick()).status, 'stale'); assert.equal(c.vault.load(), null);
});
test('definitive completion rejection persists fail-only retry, network uncertainty preserves exact result', async () => {
  const current = job('query'); let failCalls = 0, completed = 0;
  const { worker, vault } = setup(current, { host: async action => {
    if (action === 'claim') return { job: current };
    if (action === 'complete') { completed++; throw new SemanticWorkerError('HTTP_UNAVAILABLE', 422); }
    if (!failCalls++) throw new SemanticWorkerError('HTTP_UNAVAILABLE');
    throw new SemanticWorkerError('HTTP_UNAVAILABLE', 409);
  } });
  assert.equal((await worker.tick()).status, 'retry'); assert.equal(vault.load().action, 'fail');
  assert.equal((await worker.tick()).status, 'stale'); assert.equal(completed, 1); assert.equal(vault.load(), null);
});
test('each stage returns to priority host claim; concurrent ticks cannot duplicate claims', async () => {
  let unblock; const waiting = new Promise(resolve => { unblock = resolve; });
  const order = [], jobs = [job('embed'), job('query'), job('plan')];
  const { worker } = setup(null, { host: async (action, body) => { if (action === 'claim') { await waiting; return { job: jobs.shift() }; } order.push(body.kind); return { ok: true }; } });
  const first = worker.tick(); assert.equal((await worker.tick()).status, 'busy'); unblock(); await first;
  await worker.tick(); await worker.tick(); assert.deepEqual(order, ['embed', 'query', 'plan']);
});
test('local client packs escaped legal chunks within actual128KiB request budget', async t => {
  const root = await mkdtemp(join(tmpdir(), 'semantic-client-')); t.after(() => rm(root, { recursive: true, force: true }));
  const tokenFile = join(root, 'token'); await writeFile(tokenFile, 'synthetic-token-value-1234567890', { mode: 0o600 });
  const bodies = [], client = createLocalClient({ embeddingUrl: 'http://127.0.0.1:8818', embeddingTokenFile: tokenFile, fetchImpl: async (url, options) => {
    assert.ok(Buffer.byteLength(options.body) <= 131072); const body = JSON.parse(options.body); bodies.push(body);
    return new Response(JSON.stringify({ model: MODEL, index_version: INDEX_VERSION, data: body.input.map((_, index) => ({ index, embedding })) }));
  } });
  const result = await client.embed({ texts: Array(8).fill('"'.repeat(16000)), inputType: 'passage' });
  assert.equal(result.embeddings.length, 8); assert.equal(bodies.length, 2); assert.deepEqual(bodies.map(b => b.input.length), [4, 4]);
  await chmod(tokenFile, 0o644); await assert.rejects(client.embed({ texts: ['private'], inputType: 'query' }), { code: 'CREDENTIAL_UNAVAILABLE' });
});
test('transport deadlines, redirect rejection, bounded responses and sanitized token overflow', async () => {
  await assert.rejects(requestJson('http://127.0.0.1', 'token', {}, { maxResponseBytes: 4, fetchImpl: async () => new Response('private data') }), { code: 'INVALID_RESULT' });
  await assert.rejects(requestJson('http://127.0.0.1', 'token', {}, { fetchImpl: async () => new Response(JSON.stringify({ detail: { code: 'INPUT_TOO_LONG', private: 'secret' } }), { status: 422 }) }), { code: 'INPUT_TOO_LONG', message: 'INPUT_TOO_LONG' });
  await assert.rejects(requestJson('http://127.0.0.1', 'token', {}, { fetchImpl: async () => new Response('<html>upstream temporarily unavailable</html>', { status: 503 }) }), { code: 'HTTP_UNAVAILABLE', status: 503 });
  let signal;
  await assert.rejects(requestJson('http://127.0.0.1', 'token', {}, { timeoutMs: 10, fetchImpl: async (_, options) => { signal = options.signal; assert.equal(options.redirect, 'error'); await new Promise(resolve => setTimeout(resolve, 20)); throw new Error('secret failure'); } }), { code: 'HTTP_UNAVAILABLE' });
  assert.equal(signal.aborted, true);
});
test('configuration permits only loopback model endpoint and HTTPS hosted origins', () => {
  const good = { serverUrl: 'https://example.com', embeddingUrl: 'http://127.0.0.1:8818', workerTokenFile: '/private/worker', embeddingTokenFile: '/private/model', stateDirectory: '/private/state' };
  assert.equal(validateConfig(good).embeddingUrl, good.embeddingUrl);
  for (const changes of [{ embeddingUrl: 'https://provider.example' }, { serverUrl: 'http://provider.example' }, { serverUrl: 'https://user:secret@example.com' }, { embeddingUrl: 'http://127.0.0.1:8818/path' }]) assert.throws(() => validateConfig({ ...good, ...changes }), { code: 'INVALID_CONFIG' });
});

test('actual CLI connects only to configured synthetic host/model and persists no plaintext profile', async t => {
  const { createServer } = await import('node:http');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const root = await mkdtemp(join(tmpdir(), 'semantic-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const current = cvJob('plan'), calls = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); calls.push(request.url);
    assert.equal(request.headers.authorization, 'Bearer synthetic-worker-and-local-token');
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/profile-search/worker/claim') { assert.deepEqual(body, { capabilities: [CV_CAPABILITY] }); response.end(JSON.stringify({ job: current })); }
    else if (request.url === '/v1/chunk-plan') { assert.equal(body.text, text); response.end(JSON.stringify(manifest(text))); }
    else if (request.url === '/api/profile-search/worker/complete') {
      assert.equal(body.projectionVersion, CV_PROJECTION_VERSION);
      assert.equal(body.sourceSha256, hash(text)); assert.equal(body.result.byteLength, Buffer.byteLength(text));
      response.end(JSON.stringify({ ok: true, status: 'embedding' }));
    } else { response.statusCode = 404; response.end('{}'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const token = join(root, 'token'); await writeFile(token, 'synthetic-worker-and-local-token', { mode: 0o600 });
  const config = join(root, 'config.json'), origin = `http://127.0.0.1:${server.address().port}`;
  await writeFile(config, JSON.stringify({ serverUrl: origin, embeddingUrl: origin, workerTokenFile: token, embeddingTokenFile: token, stateDirectory: join(root, 'state') }), { mode: 0o600 });
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['services/semantic-worker/cli.mjs', '--config', config, '--once'], { cwd: process.cwd(), timeout: 10000 });
  assert.equal(stdout, 'completed\n'); assert.equal(stderr, '');
  assert.deepEqual(calls, ['/api/profile-search/worker/claim', '/v1/chunk-plan', '/api/profile-search/worker/complete']);
  for (const path of (await readdir(join(root, 'state'), { recursive: true })).filter(p => p.endsWith('.json'))) {
    assert.ok(!(await readFile(join(root, 'state', path), 'utf8')).includes(text));
  }
});

function cvJob(kind = 'plan') {
  const current = job(kind);
  current.projectionVersion = CV_PROJECTION_VERSION;
  current.source = { ...current.source, sourceType: 'candidate', component: 'cv',
    reviewedTextId: randomUUID(), document: { id: randomUUID(), sha256: hash('original document bytes') } };
  return current;
}

test('approved CV stages bind namespace and preserve exact passages without routing metadata in completion', async () => {
  for (const kind of ['plan', 'embed']) {
    const current = cvJob(kind), { worker, calls } = setup(current);
    assert.equal((await worker.tick()).status, 'completed');
    const complete = calls[1].body;
    assert.equal(complete.projectionVersion, CV_PROJECTION_VERSION);
    assert.equal(complete.sourceRevision, current.source.revision);
    assert.equal(complete.sourceSha256, hash(text));
    for (const key of ['source', 'document', 'reviewedTextId', 'component']) assert.equal(Object.hasOwn(complete, key), false);
  }
  const current = job(); current.source.component = 'profile';
  assert.equal((await setup(current).worker.tick()).status, 'completed');
});

test('CV namespace cannot be attached to profiles, queries, private drafts or malformed document bindings', async () => {
  const mutations = [
    j => { j.projectionVersion = PROJECTION_VERSION; },
    j => { j.source.component = 'profile'; },
    j => { delete j.source.component; },
    j => { j.source.component = null; },
    j => { j.source.sourceType = 'draft'; },
    j => { delete j.source.reviewedTextId; },
    j => { j.source.reviewedTextId = 'not-a-uuid'; },
    j => { delete j.source.document; },
    j => { j.source.document.sha256 = 'not-a-digest'; },
    j => { j.source.document.id = 'not-a-uuid'; },
    j => { j.source.document.objectKey = 'private-storage-path'; },
    j => { j.source.sha256 = hash('substituted'); },
  ];
  for (const mutate of mutations) {
    const current = cvJob(); mutate(current); const { worker, calls } = setup(current);
    await assert.rejects(worker.tick(), { code: 'INVALID_RESULT' }); assert.equal(calls.length, 1);
  }
  const query = job('query'); query.projectionVersion = CV_PROJECTION_VERSION;
  await assert.rejects(setup(query).worker.tick(), { code: 'INVALID_RESULT' });
  const disguised = job(); disguised.source.document = cvJob().source.document;
  await assert.rejects(setup(disguised).worker.tick(), { code: 'INVALID_RESULT' });
});

test('both CV stages survive lost ACK and encrypted restart with their original namespace', async t => {
  const root = await mkdtemp(join(tmpdir(), 'semantic-cv-restart-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const kind of ['plan', 'embed']) {
    const config = { root: join(root, kind), server: 'https://demo.example', workerToken: 'synthetic-cv-owner-token' };
    const current = cvJob(kind); let calls = 0, inference = 0, original;
    const host = async (action, body) => {
      if (action === 'claim') { assert.equal(calls, 0); return { job: current }; }
      if (!calls++) { original = structuredClone(body); throw new SemanticWorkerError('HTTP_UNAVAILABLE', 503); }
      assert.deepEqual(body, original); return { ok: true };
    };
    const options = { host,
      plan: async ({ text: source }) => { inference++; return manifest(source); },
      embed: async () => { inference++; return { indexVersion: INDEX_VERSION, embeddings: [embedding] }; } };
    assert.equal((await setup(current, { ...options, vault: createPendingStore(config) }).worker.tick()).status, 'retry');
    assert.equal(createPendingStore(config).load().body.projectionVersion, CV_PROJECTION_VERSION);
    assert.equal((await setup(current, { ...options, vault: createPendingStore(config) }).worker.tick()).status, 'completed');
    assert.equal(inference, 1); assert.equal(createPendingStore(config).load(), null);
  }
});

test('revoked CV completion or fail receipt unblocks profiles;401 and profile403 preserve pending work', async () => {
  for (const fail of [false, true]) {
    const jobs = [cvJob(), job('query')], vault = memory(); let revoke = true;
    const host = async action => {
      if (action === 'claim') return { job: jobs.shift() };
      if (revoke) throw new SemanticWorkerError('HTTP_UNAVAILABLE', 403);
      return { ok: true };
    };
    const { worker } = setup(null, { host, vault, ...(fail ? { plan: async () => { throw new Error('model outage'); } } : {}) });
    assert.equal((await worker.tick()).status, 'stale'); assert.equal(vault.load(), null);
    revoke = false; assert.equal((await worker.tick()).status, 'completed');
  }
  for (const [current, status] of [[cvJob(), 401], [job(), 403]]) {
    const { worker, vault } = setup(current, { host: async action => {
      if (action === 'claim') return { job: current };
      throw new SemanticWorkerError('HTTP_UNAVAILABLE', status);
    } });
    await assert.rejects(worker.tick(), { status }); assert.ok(vault.load());
  }
});

test('CV validation rejection keeps fail namespace through restart and permission loss', async () => {
  const current = cvJob(), vault = memory(); let stage = 0;
  const host = async action => {
    if (action === 'claim') return { job: current };
    if (action === 'complete') throw new SemanticWorkerError('HTTP_UNAVAILABLE', 422);
    throw new SemanticWorkerError('HTTP_UNAVAILABLE', stage++ ? 403 : 503);
  };
  assert.equal((await setup(current, { host, vault }).worker.tick()).status, 'retry');
  assert.equal(vault.load().action, 'fail'); assert.equal(vault.load().projectionVersion, CV_PROJECTION_VERSION);
  assert.equal((await setup(current, { host, vault }).worker.tick()).status, 'stale');
  assert.equal(vault.load(), null);
});
