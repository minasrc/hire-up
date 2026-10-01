import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCvWorker } from '../../services/telegram-connector/cv-worker.mjs';
import { createCvHostClient } from '../../services/telegram-connector/cv-http.mjs';
import { createConnectedWork } from '../../services/telegram-connector/connected-work.mjs';
import { createVault } from '../../services/telegram-connector/vault.mjs';
import { CvReadError, CV_CHUNK_BYTES, CV_MAX_BYTES } from '../../services/telegram-connector/cv-adapter.mjs';
import { ConnectorHttpError } from '../../services/telegram-connector/http.mjs';

const connectionId = '10000000-0000-4000-8000-000000000001';
const jobId = '20000000-0000-4000-8000-000000000002';
const lease = '30000000-0000-4000-8000-000000000003';
const nextLease = '40000000-0000-4000-8000-000000000004';
function memoryVault() {
  const values = new Map(); const chunks = new Map(); const key = (...ids) => ids.join(':');
  return {
    values, chunks,
    saveHistory: (connection, account, id, value) => values.set(key(connection, account, id), structuredClone(value)),
    loadHistory: (connection, account, id) => structuredClone(values.get(key(connection, account, id)) ?? null),
    removeHistoryRecord: (connection, account, id) => values.delete(key(connection, account, id)),
    saveCvChunk: (connection, account, job, index, bytes) => chunks.set(key(connection, account, job, index), Buffer.from(bytes)),
    loadCvChunk: (connection, account, job, index) => Buffer.from(chunks.get(key(connection, account, job, index))),
    removeCvChunks: (connection, account, job) => { for (let i = 0; i < 8; i++) chunks.delete(key(connection, account, job, i)); },
  };
}
function fixture(size = CV_CHUNK_BYTES + 7, injectedVault) {
  let clock = Date.parse('2026-10-02T12:00:00Z');
  const vault = injectedVault ?? memoryVault(); const bytes = Buffer.alloc(size, 71);
  const context = { connectionId, generation: 1, connectionLeaseToken: lease, accountUserId: '123', connectionLeaseExpiresAt: new Date(clock + 86400000).toISOString(), signal: new AbortController().signal, isActive: () => true, telegram: { cv: {} } };
  const source = { extractionJobId: connectionId, chatId: jobId, accountUserId: '123', peer: { kind: 'user', id: '456' }, messageId: '77', attachmentIndex: 0, documentId: '900', filename: 'Synthetic.pdf', mimeType: 'application/pdf', sizeBytes: size };
  const job = { id: jobId, leaseToken: lease, leaseExpiresAt: new Date(clock + 180000).toISOString(), sourceDigest: 'a'.repeat(64), source };
  const calls = []; const offsets = []; let inspected = 0; let uploads = 0;
  const state = () => vault.loadHistory(connectionId, '123', 'pending-cv');
  const location = () => ({ id: '900', accessHash: '-999', fileReference: Buffer.from('private-file-reference').toString('base64'), dcId: 2, sizeBytes: size });
  context.telegram.cv.inspect = async () => { inspected++; return location(); };
  context.telegram.cv.chunk = async ({ offset }) => { offsets.push(offset); return Buffer.from(bytes.subarray(offset, offset + CV_CHUNK_BYTES)); };
  const host = async (action, body) => { calls.push({ action, body: structuredClone(body) }); return action === 'claim' ? { job: { ...job, leaseExpiresAt: new Date(clock + 180000).toISOString() }, retryAt: null } : { ok: true }; };
  const upload = async (proof, file) => { uploads++; assert.deepEqual(file, bytes); assert.equal(proof.sha256, createHash('sha256').update(bytes).digest('hex')); assert.equal(proof.sizeBytes, size); return { ok: true, jobId, status: 'completed' }; };
  const options = { host, upload, vault, now: () => clock };
  return { context, source, job, options, vault, bytes, calls, offsets, state, location, advance: value => { clock += value; }, inspections: () => inspected, uploads: () => uploads, worker: () => createCvWorker(options) };
}
async function download(f, worker) {
  assert.equal((await worker.tick(f.context)).status, 'reading');
  for (let i = 0; i < Math.ceil(f.bytes.length / CV_CHUNK_BYTES); i++) await worker.tick(f.context);
  assert.equal(f.state().phase, 'upload');
}

test('one metadata/chunk read per renewed tick and exact binary upload uses current proof, no local secrets', async () => {
  const f = fixture(); const worker = f.worker();
  await download(f, worker); assert.deepEqual(f.offsets, [0, CV_CHUNK_BYTES]);
  assert.equal(f.calls.filter(call => call.action === 'claim').length, 3);
  f.context.connectionLeaseToken = nextLease;
  f.options.upload = async () => assert.fail('factory closure must be stable');
  assert.equal((await worker.tick(f.context)).status, 'completed');
  assert.equal(f.uploads(), 1); assert.equal(f.state(), null); assert.equal(f.vault.chunks.size, 0);
  assert.ok(!JSON.stringify(f.calls).includes('private-file-reference')); assert.ok(!JSON.stringify(f.calls).includes('accessHash'));
});

test('lost committed upload ACK replays original bytes before claim after restart with fresh connection proof', async () => {
  const f = fixture(); const payloads = []; let attempts = 0;
  f.options.upload = async (proof, bytes) => { payloads.push({ proof: structuredClone(proof), bytes: Buffer.from(bytes) }); if (++attempts === 1) throw new ConnectorHttpError(503); return { ok: true, jobId, status: 'completed' }; };
  const first = f.worker(); await download(f, first);
  await assert.rejects(first.tick(f.context)); const claims = f.calls.length;
  f.options.host = async () => assert.fail('pending receipt must not claim'); f.context.connectionLeaseToken = nextLease;
  assert.equal((await f.worker().tick(f.context)).status, 'completed');
  assert.equal(f.calls.length, claims); assert.equal(payloads[0].proof.connectionLeaseToken, lease); assert.equal(payloads[1].proof.connectionLeaseToken, nextLease);
  assert.deepEqual(payloads[0].bytes, payloads[1].bytes); assert.equal(payloads[0].proof.sha256, payloads[1].proof.sha256); assert.equal(f.inspections(), 1); assert.equal(f.state(), null);
});

test('restart mid-file rechecks exact source and resumes encrypted verified chunks', async () => {
  const f = fixture(CV_CHUNK_BYTES * 2 + 17); const first = f.worker();
  await first.tick(f.context); await first.tick(f.context);
  assert.equal(f.state().downloaded, CV_CHUNK_BYTES);
  const second = f.worker(); await second.tick(f.context); await second.tick(f.context); await second.tick(f.context);
  assert.deepEqual(f.offsets, [0, CV_CHUNK_BYTES, CV_CHUNK_BYTES * 2]); assert.equal(f.inspections(), 2);
  assert.equal((await second.tick(f.context)).status, 'completed');
});

test('expired file reference re-fetches same document without losing verified chunks; repeated expiry is bounded', async () => {
  const f = fixture(); const worker = f.worker();
  await worker.tick(f.context); await worker.tick(f.context);
  const chunk = f.context.telegram.cv.chunk;
  f.context.telegram.cv.chunk = async () => { throw new CvReadError('FILE_REFERENCE_EXPIRED'); };
  assert.equal((await worker.tick(f.context)).status, 'refreshing');
  assert.equal(f.state().downloaded, CV_CHUNK_BYTES); await worker.tick(f.context);
  f.context.telegram.cv.chunk = chunk; await worker.tick(f.context);
  assert.equal((await worker.tick(f.context)).status, 'completed'); assert.deepEqual(f.offsets, [0, CV_CHUNK_BYTES]);
  const broken = fixture(); const retry = broken.worker(); broken.context.telegram.cv.chunk = async () => { throw new CvReadError('FILE_REFERENCE_EXPIRED'); };
  for (let i = 0; i < 9; i++) await retry.tick(broken.context);
  assert.equal(broken.calls.at(-1).body.code, 'SOURCE_UNAVAILABLE'); assert.equal(broken.state(), null);
});

test('file migration persists new DC before next chunk and does not retry in the same tick', async () => {
  const f = fixture(7); const worker = f.worker(); let requests = 0;
  f.context.telegram.cv.chunk = async ({ location }) => { requests++; if (requests === 1) throw new CvReadError('FILE_MIGRATE', undefined, 4); assert.equal(location.dcId, 4); return Buffer.from(f.bytes); };
  await worker.tick(f.context); assert.equal((await worker.tick(f.context)).status, 'migrating'); assert.equal(requests, 1); assert.equal(f.state().location.dcId, 4);
  await worker.tick(f.context); assert.equal((await worker.tick(f.context)).status, 'completed');
});

test('flood wait is durably deferred, survives lost ACK and resumes only after cooldown', async () => {
  const f = fixture(); const oldHost = f.options.host; let failures = 0;
  f.options.host = async (action, body) => { const value = await oldHost(action, body); if (action === 'defer' && failures++ === 0) throw new ConnectorHttpError(503); return value; };
  f.context.telegram.cv.chunk = async () => { throw new CvReadError('FLOOD_WAIT', 60); };
  const worker = f.worker(); await worker.tick(f.context); await assert.rejects(worker.tick(f.context));
  assert.equal(f.state().pendingDefer.code, 'FLOOD_WAIT');
  const restarted = f.worker(); assert.equal((await restarted.tick(f.context)).status, 'deferred');
  const calls = f.calls.length; assert.equal((await restarted.tick(f.context)).status, 'idle'); assert.equal(f.calls.length, calls);
  assert.equal(f.calls.at(-1).body.retryAfterSeconds, 60); f.advance(60000); assert.equal((await restarted.tick(f.context)).status, 'reading');
});

test('seven-day Telegram flood wait is preserved without shortening server cooldown', async () => {
  const f = fixture(); const worker = f.worker();
  f.context.telegram.cv.inspect = async () => { throw new CvReadError('FLOOD_WAIT', 604800); };
  assert.equal((await worker.tick(f.context)).status, 'deferred');
  assert.equal(f.calls.at(-1).body.retryAfterSeconds, 604800);
});

test('cancel/manual CV win/account-generation changes prevent stale data from attaching', async () => {
  const f = fixture(); const worker = f.worker(); await download(f, worker);
  const options = { ...f.options, upload: async () => { throw new ConnectorHttpError(409); } };
  assert.equal((await createCvWorker(options).tick(f.context)).status, 'stale'); assert.equal(f.state(), null); assert.equal(f.vault.chunks.size, 0);
  const g = fixture(); const active = g.worker(); await active.tick(g.context); await active.tick(g.context);
  g.options.host = async () => ({ job: null, retryAt: null });
  assert.equal((await g.worker().tick(g.context)).status, 'idle'); assert.equal(g.state(), null); assert.equal(g.vault.chunks.size, 0);
  const h = fixture(); await download(h, h.worker()); h.context.generation++;
  h.options.host = async () => ({ job: null, retryAt: null }); h.options.upload = async () => assert.fail('no old-generation upload');
  await h.worker().tick(h.context); assert.equal(h.state(), null);
});

test('late cancelled download response is not persisted or uploaded', async () => {
  const f = fixture(); const worker = f.worker(); await worker.tick(f.context);
  const control = new AbortController(); f.context.signal = control.signal;
  f.context.telegram.cv.chunk = async () => { control.abort('private cancellation reason'); return Buffer.alloc(CV_CHUNK_BYTES); };
  assert.equal((await worker.tick(f.context)).status, 'stale'); assert.equal(f.state().downloaded, 0); assert.equal(f.vault.chunks.size, 0); assert.equal(f.uploads(), 0);
});

test('host validation rejection becomes fail-only replay; denied upload keeps encrypted state until repair', async () => {
  const f = fixture(10); f.options.upload = async () => { throw new ConnectorHttpError(422); };
  const host = f.options.host; let deferCalls = 0;
  f.options.host = async (action, body) => { if (action === 'defer' && ++deferCalls === 1) throw new ConnectorHttpError(503); return host(action, body); };
  const worker = f.worker(); await download(f, worker); await assert.rejects(worker.tick(f.context));
  assert.equal(f.state().pendingDefer.code, 'INVALID_FILE');
  f.options.upload = async () => assert.fail('do not retry definitively invalid upload');
  assert.equal((await f.worker().tick(f.context)).status, 'deferred'); assert.equal(f.state(), null);
  const denied = fixture(10); denied.options.upload = async () => { throw new ConnectorHttpError(403); };
  const blocked = denied.worker(); await download(denied, blocked); await assert.rejects(blocked.tick(denied.context), error => error.message === 'ACCESS_DENIED');
  assert.equal(denied.state().phase, 'upload'); assert.equal(denied.vault.chunks.size, 1);
});

test('fair connected scheduler alternates queues including errors', async () => {
  const calls = []; const schedule = createConnectedWork({ cv: { tick: async () => { calls.push('cv'); if (calls.length === 1) throw new Error('offline'); } }, history: { tick: async () => { calls.push('history'); } } });
  await assert.rejects(schedule({})); await schedule({}); await schedule({}); await schedule({});
  assert.deepEqual(calls, ['cv', 'history', 'cv', 'history']);
});

test('full 4MiB CV survives encrypted chunk restart and remains unreadable in private cache files', async t => {
  const root = mkdtempSync(join(tmpdir(), 'telegram-cv-cache-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = { root, server: 'https://example.test', workerId: connectionId };
  const vault = createVault(config); const f = fixture(CV_MAX_BYTES, vault); await download(f, f.worker());
  let fileCount = 0;
  function inspect(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name); assert.equal(statSync(file).mode & 0o077, 0);
      if (entry.isDirectory()) inspect(file);
      else { fileCount++; assert.ok(!readFileSync(file, 'utf8').includes('G'.repeat(200))); }
    }
  }
  inspect(root); assert.equal(fileCount, 10);
  const restored = createVault(config); const worker = createCvWorker({ ...f.options, vault: restored, host: async () => assert.fail('ready upload requires no claim') });
  assert.equal((await worker.tick(f.context)).status, 'completed');
  assert.throws(() => restored.loadCvChunk(connectionId, '123', jobId, 0), /ENOENT/);
});

test('binary host transport bounds input/output, refuses redirects and exposes no general storage destination', async () => {
  const calls = []; const client = createCvHostClient({ server: 'http://127.0.0.1:9000', token: 'a'.repeat(64), fetchImpl: async (url, request) => { calls.push({ url, request }); return new Response(JSON.stringify({ ok: true })); } });
  const proof = { connectionId, generation: 1, connectionLeaseToken: lease, accountUserId: '123', jobId, jobLeaseToken: lease, sourceDigest: 'a'.repeat(64), sha256: 'b'.repeat(64), sizeBytes: 3 };
  await client.upload(proof, Buffer.from('abc'));
  assert.equal(calls[0].request.redirect, 'error'); assert.equal(calls[0].request.headers['Content-Type'], 'application/octet-stream');
  assert.deepEqual(JSON.parse(Buffer.from(calls[0].request.headers['X-Telegram-CV-Proof'], 'base64url')), proof);
  assert.deepEqual(calls[0].request.body, Buffer.from('abc')); assert.equal(calls[0].url, 'http://127.0.0.1:9000/api/telegram-cv/worker/upload');
  assert.throws(() => client.upload({ ...proof, sizeBytes: CV_MAX_BYTES + 1 }, Buffer.alloc(CV_MAX_BYTES + 1)), /INVALID_CV_UPLOAD/);
  const large = createCvHostClient({ server: 'https://example.test', token: 'a'.repeat(64), fetchImpl: async () => new Response('x'.repeat(32769)) });
  await assert.rejects(large.host('claim', {}), /INVALID_CV_RESPONSE/);
});
