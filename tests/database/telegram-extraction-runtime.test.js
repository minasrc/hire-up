import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import { POSTGRES_17_IMAGE, assertLocalTestEnvironment, psql, startPostgresContainer, stopAndRemoveContainer } from '../support/foundation-docker.js';
import { AUTHZ_ID, installStaffFixture, staffPoolOptions } from '../support/staff-authorization.js';
import { CJ_SUBJECTS, clientJobFixtureSql } from '../support/client-job-workflows.js';
import { withStaffTransaction } from '../../src/lib/staff-authorization.js';
import { telegramConnectionAction, telegramConnectorOperation } from '../../src/lib/telegram-connection-operations.js';
import { telegramHistoryAction, telegramHistoryStatus, telegramHistoryWorkerOperation } from '../../src/lib/telegram-history-operations.js';
import { telegramExtractionAction, telegramExtractionStatus, telegramExtractionWorkerOperation } from '../../src/lib/telegram-extraction-operations.js';
import { getTelegramDraft } from '../../src/lib/telegram-intake-operations.js';
import { createProvider } from '../../services/telegram-extraction-worker/provider.mjs';
import { createExtractionWorker } from '../../services/telegram-extraction-worker/worker.mjs';
import { createPendingStore } from '../../services/telegram-extraction-worker/store.mjs';

const owner = { provider: 'google', issuer: 'https://accounts.google.com', subject: CJ_SUBJECTS.ADMIN };
const org = AUTHZ_ID.ORG_B;
const peer = { kind: 'user', id: '456789012345' };
const message = id => ({ messageId: String(id), kind: 'message', sentAt: '2026-09-29T12:00:00.000Z', editedAt: null,
  sender: { peer, username: 'synthetic_candidate', displayName: 'Synthetic Candidate' }, replyToMessageId: null, forwardedFrom: null,
  text: `I am Synthetic Candidate. My email is synthetic@example.test. Recruiting history ${id}.`, attachments: [] });

// This uses the real provider HTTP adapter, durable encrypted worker queue and
// restricted hosted database operations. The provider is deliberately synthetic;
// this tests delivery/validation, not the quality of a live model's interpretation.
test('extraction worker delivers bounded private history through provider failures and lost acknowledgements', { timeout: 120000 }, async t => {
  assertLocalTestEnvironment();
  const db = await startPostgresContainer('pgtelegramextractionruntime', POSTGRES_17_IMAGE, { publish: true });
  const root = mkdtempSync(join(tmpdir(), 'agora-extraction-runtime-'));
  let pool; let workerPool; let server;
  t.after(async () => {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await Promise.all([pool?.end(), workerPool?.end()]); stopAndRemoveContainer(db); rmSync(root, { recursive: true, force: true });
  });
  const dir = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
  for (const name of readdirSync(dir).filter(name => name >= '20260922090000_foundation_roles.sql' && name <= '20261002160000_telegram_extraction.sql' && name.endsWith('.sql')).sort()) psql(db, readFileSync(join(dir, name), 'utf8'));
  const password = installStaffFixture(db); psql(db, clientJobFixtureSql);
  pool = new pg.Pool(staffPoolOptions(db, password, 3));
  const workerPassword = randomUUID();
  psql(db, `create role extraction_runtime_test login noinherit nosuperuser nocreatedb nocreaterole nobypassrls password '${workerPassword}'; grant app_telegram_worker to extraction_runtime_test;`);
  workerPool = new pg.Pool({ ...staffPoolOptions(db, workerPassword, 3), user: 'extraction_runtime_test' });
  const staff = (sql, args = []) => withStaffTransaction(pool, owner, org, ['candidates.read', 'candidates.write'], async ({ client }) => (await client.query(sql, args)).rows[0]?.result);
  const token = randomBytes(48).toString('base64url');
  const registered = await staff('select app.telegram_register_worker_v1($1,$2) as result', ['Synthetic extraction Mac', token]);
  const connector = (action, body = {}) => telegramConnectorOperation(workerPool, token, action, body);
  const publicKeySpki = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  await connector('heartbeat', { publicKeySpki });
  await telegramConnectionAction(pool, owner, org, { action: 'connect', workerId: registered.id });
  const lease = await connector('claim');
  await connector('update', { connectionId: lease.id, generation: lease.generation, leaseToken: lease.leaseToken,
    status: 'connected', profile: { telegramUserId: '123456789012345', username: 'synthetic_owner', displayName: 'Synthetic Owner' } });
  const proof = { connectionId: lease.id, generation: lease.generation, connectionLeaseToken: lease.leaseToken, accountUserId: '123456789012345' };
  const history = (action, body = {}) => telegramHistoryWorkerOperation(workerPool, token, action, { ...proof, ...body });
  await telegramHistoryAction(pool, owner, org, { action: 'discover' });
  let inserted = false;
  for (let i = 0; i < 4; i++) {
    const job = (await history('claim')).job; if (!job) break;
    const records = inserted ? [] : [{ peer, title: 'Synthetic candidate history', username: 'synthetic_candidate', lastMessageAt: null }];
    inserted = true;
    await history('complete', { jobId: job.id, jobLeaseToken: job.leaseToken, pageId: randomUUID(), fromCursor: job.cursor,
      nextCursor: records.length ? { ...job.cursor, offsetDate: 1, offsetId: '1', offsetPeer: peer, excludePinned: true } : job.cursor, done: !records.length, records });
  }
  const chat = (await telegramHistoryStatus(pool, owner, org)).chats[0];
  await telegramHistoryAction(pool, owner, org, { action: 'select', chatId: chat.id, expectedVersion: chat.version, selected: true });
  let importJob = (await history('claim')).job;
  await history('complete', { jobId: importJob.id, jobLeaseToken: importJob.leaseToken, pageId: randomUUID(), fromCursor: importJob.cursor,
    nextCursor: { beforeMessageId: '1', upperMessageId: '85' }, done: false, records: Array.from({ length: 85 }, (_, i) => message(85 - i)) });
  importJob = (await history('claim')).job;
  await history('complete', { jobId: importJob.id, jobLeaseToken: importJob.leaseToken, pageId: randomUUID(), fromCursor: importJob.cursor, nextCursor: importJob.cursor, done: true, records: [] });
  await telegramConnectionAction(pool, owner, org, { action: 'disconnect', connectionId: lease.id, generation: lease.generation });
  assert.equal((await telegramExtractionAction(pool, owner, org, { action: 'enqueue', chatIds: [chat.id] })).queued, 1);

  const providerToken = randomBytes(32).toString('base64url');
  const providerTokenFile = join(root, 'provider-token'); writeFileSync(providerTokenFile, providerToken, { mode: 0o600 });
  let providerCalls = 0; let providerMode = 'valid'; const sourceCounts = [];
  server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/chat/completions'); assert.equal(request.headers.authorization, `Bearer ${providerToken}`);
      let raw = ''; for await (const chunk of request) raw += chunk;
      const payload = JSON.parse(raw); const source = JSON.parse(payload.messages[1].content).source;
      assert.equal(payload.model, 'synthetic-model'); assert.equal(payload.response_format.json_schema.strict, true);
      assert.equal(payload.tools, undefined); assert.ok(source.messages.length <= 40); sourceCounts.push(source.messages.length); providerCalls++;
      if (providerMode === 'unavailable') { response.writeHead(503); response.end('Synthetic provider outage'); return; }
      const first = source.messages[0];
      const fact = (field, value) => ({ field, value, evidence: [{ messageId: first.messageId, quote: first.text }] });
      const result = { subjects: [{ key: 'candidate', identity: { kind: 'telegram_sender', messageId: first.messageId, quote: first.text },
        facts: [fact('firstName', 'Synthetic'), fact('lastName', 'Candidate'), fact('primaryEmail', 'synthetic@example.test')], attachments: [] }] };
      if (providerMode === 'invalid') for (const fact of result.subjects[0].facts) fact.evidence[0].quote = 'Invented quote absent from source';
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ model: 'synthetic-reported-model', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }));
    } catch { response.writeHead(500); response.end('Synthetic test server assertion failed'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = createProvider({ providerBaseUrl: `http://127.0.0.1:${server.address().port}/v1`, providerModel: 'synthetic-model', providerTokenFile });
  let loseAck = true; const completions = [];
  const host = async (action, body) => {
    const result = await telegramExtractionWorkerOperation(workerPool, token, action, body).catch(error => {
      error.status = { '40001': 409, '22023': 400, '42501': 403, P0002: 404 }[error.code]; throw error;
    });
    if (action === 'complete') { completions.push({ body: structuredClone(body), result }); if (loseAck) { loseAck = false; throw new Error('SYNTHETIC_ACK_LOST'); } }
    return result;
  };
  const storeConfig = { root: join(root, 'encrypted-state'), server: 'https://synthetic.invalid', workerToken: token };
  let pendingStore = createPendingStore(storeConfig);
  let runtime = createExtractionWorker({ host, provider, pendingStore });
  const status = () => telegramExtractionStatus(pool, owner, org);

  await t.test('restart replays committed result without repeating model request', async () => {
    await assert.rejects(runtime.tick(), /SYNTHETIC_ACK_LOST/); assert.equal(providerCalls, 1);
    assert.ok(await pendingStore.load());
    pendingStore = createPendingStore(storeConfig); runtime = createExtractionWorker({ host, provider, pendingStore });
    assert.equal(await runtime.tick(), 'completed'); assert.equal(providerCalls, 1); assert.equal(await pendingStore.load(), null);
    assert.deepEqual(completions[0], completions[1]);
    const draft = await getTelegramDraft(pool, owner, org, completions[0].result.draftIds[0]);
    assert.equal(draft.fields.telegramUsername, 'synthetic_candidate'); assert.equal(draft.fields.telegramUserId, peer.id);
    assert.equal(draft.cv, null); assert.ok(draft.missingFields.includes('cv'));
  });
  await t.test('provider outage and invalid evidence keep immutable input retryable', async () => {
    providerMode = 'unavailable'; assert.equal(await runtime.tick(), 'failed');
    assert.equal((await status()).counts.waiting, 1); assert.equal((await status()).counts.completed, 1);
    psql(db, "update app.telegram_extraction_jobs set available_at=now()-interval '1 second' where status='waiting'");
    providerMode = 'invalid'; assert.equal(await runtime.tick(), 'failed');
    const failed = (await status()).jobs.find(job => job.status === 'failed'); assert.equal(failed.errorCode, 'INVALID_RESULT');
    await telegramExtractionAction(pool, owner, org, { action: 'retry', jobId: failed.id });
    providerMode = 'valid'; assert.equal(await runtime.tick(), 'completed');
    assert.equal(await runtime.tick(), 'completed'); assert.equal(await runtime.tick(), 'idle');
    const final = await status(); assert.equal(final.counts.completed, 3); assert.equal(final.counts.failed, 0);
    assert.deepEqual(sourceCounts, [40, 40, 40, 40, 40, 5]);
    assert.equal(new Set(completions.flatMap(item => item.result.draftIds)).size, 1, 'Same observed sender resolves to one private draft');
    assert.equal(Number(psql(db, 'select count(*) from app.telegram_extraction_sources').trim()), 85);
    assert.equal(Number(psql(db, "select count(*) from app.telegram_extraction_jobs where metadata->>'model'='synthetic-model' and metadata->>'reportedModel'='synthetic-reported-model'").trim()), 3);
  });
});
