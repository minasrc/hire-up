import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
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
import { getTelegramDraft, decideTelegramDraft, updateTelegramDraft } from '../../src/lib/telegram-intake-operations.js';
import { telegramCvAction, telegramCvWorkerOperation, uploadTelegramCv } from '../../src/lib/telegram-cv-operations.js';
import { createCvAnalysisPdf, createCvAnalysisDocx, cvAnalysisProfile } from '../support/cv-analysis-fixtures.js';
import { cvAnalysisStatus, cvAnalysisAction, cvAnalysisWorkerOperation, readCvAnalysisContent } from '../../src/lib/cv-analysis-operations.js';
import { createCvAnalysisWorker } from '../../services/cv-analysis-worker/worker.mjs';
import { createPendingStore } from '../../services/cv-analysis-worker/vault.mjs';
import { createCvAnalysisProvider } from '../../services/cv-analysis-worker/provider.mjs';
import { runIsolatedParser } from '../../services/cv-analysis-worker/sandbox.mjs';
import { profileSearchStatus, profileSearchAction, profileSearchWorkerOperation } from '../../src/lib/profile-search-operations.js';
import { createSemanticWorker } from '../../services/semantic-worker/worker.mjs';
import { createPendingStore as createSemanticStore } from '../../services/semantic-worker/store.mjs';
import { handleTelegramMaintenance } from '../../src/lib/telegram-maintenance.js';

const owner = { provider: 'google', issuer: 'https://accounts.google.com', subject: CJ_SUBJECTS.ADMIN };
const org = AUTHZ_ID.ORG_B;
const peer = { kind: 'user', id: '456789012345' };

// Real restricted database, CV storage handoff, isolated parser and encrypted
// worker restart. The model is synthetic: this checks delivery and provenance,
// not the accuracy of a live model's interpretation.
test('attachment-only CVs become reviewed candidates without losing field edits or retry receipts', { timeout: 240000 }, async t => {
  assertLocalTestEnvironment();
  const db = await startPostgresContainer('pgcvanalysisruntime', POSTGRES_17_IMAGE, { publish: true });
  const root = mkdtempSync(join(tmpdir(), 'agora-cv-analysis-runtime-'));
  let pool; let workerPool; let maintenancePool; let server;
  t.after(async () => {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await Promise.all([pool?.end(), workerPool?.end(), maintenancePool?.end()]); stopAndRemoveContainer(db); rmSync(root, { recursive: true, force: true });
  });
  const dir = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
  for (const name of readdirSync(dir).filter(name => name >= '20260922090000_foundation_roles.sql' && name <= '20261002210000_cv_search.sql' && name.endsWith('.sql')).sort()) psql(db, readFileSync(join(dir, name), 'utf8'));
  psql(db, readFileSync(join(dir, '20261014160000_telegram_cv_recovery.sql'), 'utf8'));
  const password = installStaffFixture(db); psql(db, clientJobFixtureSql);
  pool = new pg.Pool(staffPoolOptions(db, password, 3));
  const workerPassword = randomUUID();
  psql(db, `create role extraction_runtime_test login noinherit nosuperuser nocreatedb nocreaterole nobypassrls password '${workerPassword}'; grant app_telegram_worker to extraction_runtime_test;`);
  workerPool = new pg.Pool({ ...staffPoolOptions(db, workerPassword, 3), user: 'extraction_runtime_test' });
  assert.equal(psql(db, "select has_function_privilege('app_staff','app.telegram_cv_auto_bootstrap_v1(text)','EXECUTE') or has_function_privilege('app_telegram_worker','app.telegram_cv_auto_bootstrap_v1(text)','EXECUTE')").trim(), 'f', 'automatic bootstrap remains private to the authorized claim procedure');
  await assert.rejects(cvAnalysisWorkerOperation(workerPool, randomBytes(48).toString('base64url'), 'claim', {}), error => error.code === '42501', 'unregistered tokens cannot create CV drafts');
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
  const importJob = (await history('claim')).job;
  const documents = [
    { extension: 'pdf', mimeType: 'application/pdf', bytes: createCvAnalysisPdf() },
    { extension: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: createCvAnalysisDocx(['Alex Rivera', 'Senior platform engineer', 'Madrid, Spain', 'Experience with PostgreSQL and Kafka.', 'Résumé 中文'],
        { header: 'alex.docx@example.invalid', footer: 'Synthetic CV', table: [['Skills', 'Kafka']] }) },
  ];
  const records = documents.map((doc, index) => ({ messageId: String(index + 1), kind: 'message', sentAt: '2026-09-29T12:00:00.000Z', editedAt: null,
    sender: { peer, username: 'unrelated_recruiter', displayName: 'Recruiter sharing a CV' }, replyToMessageId: null, forwardedFrom: null, text: '',
    attachments: [{ id: String(index + 10), kind: 'document', filename: `Synthetic CV.${doc.extension}`, mimeType: doc.mimeType, sizeBytes: doc.bytes.length }] }));
  records.push({ ...records[0], messageId: '3', attachments: [{ ...records[0].attachments[0], id: '30', filename: 'Talent NDA.pdf' }] });
  await history('complete', { jobId: importJob.id, jobLeaseToken: importJob.leaseToken, pageId: randomUUID(), fromCursor: importJob.cursor,
    nextCursor: { beforeMessageId: '1', upperMessageId: '3' }, done: false, records });
  const finalPage = (await history('claim')).job;
  await history('complete', { jobId: finalPage.id, jobLeaseToken: finalPage.leaseToken, pageId: randomUUID(), fromCursor: finalPage.cursor, nextCursor: finalPage.cursor, done: true, records: [] });
  await telegramExtractionAction(pool, owner, org, { action: 'enqueue', chatIds: [chat.id] });
  const textJob = (await telegramExtractionWorkerOperation(workerPool, token, 'claim', {})).job;
  await telegramExtractionWorkerOperation(workerPool, token, 'complete', { jobId: textJob.id, leaseToken: textJob.leaseToken, sourceDigest: textJob.sourceDigest,
    result: { subjects: [] }, metadata: { model: 'synthetic-model', promptVersion: 'candidate-extraction-prompt-v1', reportedModel: null } });
  const batch = await telegramExtractionStatus(pool, owner, org, { jobId: textJob.id });
  psql(db, `update app.telegram_extraction_jobs set status='failed',error_code='INVALID_RESULT' where id='${textJob.id}'`);
  psql(db, `update app.telegram_history_chats set extraction_enabled=false where id='${chat.id}'`);
  await cvAnalysisWorkerOperation(workerPool, token, 'claim', {});
  assert.equal(psql(db, 'select count(*) from app.telegram_cv_jobs').trim(), '0', 'paused chats do not start automatic CV processing');
  psql(db, `update app.telegram_history_chats set extraction_enabled=true where id='${chat.id}'`);
  assert.equal((await cvAnalysisWorkerOperation(workerPool, token, 'claim', {})).job, null);
  assert.equal(psql(db, 'select count(*) from app.telegram_cv_jobs').trim(), '2', 'failed chat extraction still queues both labelled CVs');
  assert.equal(psql(db, "select count(*) from app.telegram_cv_jobs where source->>'messageId'='3'").trim(), '0', 'NDAs are not automatically treated as CVs');
  await cvAnalysisWorkerOperation(workerPool, token, 'claim', {});
  assert.equal(psql(db, 'select count(*) from app.telegram_cv_jobs').trim(), '2', 'repeated polling does not create duplicate drafts or retrievals');
  psql(db, "update app.telegram_cv_jobs set created_at=created_at+(source->>'messageId')::integer*interval '1 millisecond'");
  const maintenancePassword = randomUUID();
  psql(db, `create role maintenance_runtime_test login noinherit nosuperuser nocreatedb nocreaterole nobypassrls password '${maintenancePassword}'; grant app_telegram_maintenance to maintenance_runtime_test;`);
  maintenancePool = new pg.Pool({ ...staffPoolOptions(db, maintenancePassword, 1), user: 'maintenance_runtime_test' });
  const maintenanceSecret = randomBytes(32).toString('base64url');
  const maintenance = async () => {
    const response = await handleTelegramMaintenance(new Request('https://synthetic.invalid/api/telegram-maintenance', { headers: { authorization: `Bearer ${maintenanceSecret}` } }),
      { secret: maintenanceSecret, getPool: () => maintenancePool });
    assert.equal(response.status, 200); return response.json();
  };
  const objects = new Map();
  const storage = { storage: { from: () => ({
    upload: async (key, bytes) => { objects.set(key, Buffer.from(bytes)); return { data: { path: key } }; },
    download: async key => objects.has(key) ? { data: new Blob([objects.get(key)]) } : { error: { status: 404 } },
  }) } };
  const providerToken = randomBytes(32).toString('base64url');
  const providerTokenFile = join(root, 'provider-token'); writeFileSync(providerTokenFile, providerToken, { mode: 0o600 });
  let providerCalls = 0;
  server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, `Bearer ${providerToken}`);
      let raw = ''; for await (const chunk of request) raw += chunk;
      const envelope = JSON.parse(raw);
      const source = JSON.parse(envelope.messages[1].content).source;
      providerCalls++;
      const fact = (field, value) => {
        const block = source.blocks.find(block => block.text.includes(value)); assert.ok(block, `${field} has real parser evidence`);
        const charIndex = block.text.indexOf(value); const startByte = Buffer.byteLength(block.text.slice(0, charIndex));
        return { field, value, evidence: [{ blockOrdinal: block.ordinal, startByte, endByte: startByte + Buffer.byteLength(value), quote: value }] };
      };
      const email = source.extension === 'docx' ? 'alex.docx@example.invalid' : cvAnalysisProfile.primaryEmail;
      const result = { facts: [fact('firstName', 'Alex'), fact('lastName', 'Rivera'), fact('primaryEmail', email), fact('location', 'Madrid, Spain')], issues: [] };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }));
    } catch { response.writeHead(500); response.end('Synthetic provider assertion failed'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = createCvAnalysisProvider({ providerBaseUrl: `http://127.0.0.1:${server.address().port}/v1`, providerModel: 'synthetic-model', providerTokenFile });
  const receipts = [];
  for (const [index, doc] of documents.entries()) {
    const create = { action: 'createDraft', extractionJobId: textJob.id, messageId: String(index + 1), attachmentIndex: 0,
      expectedSourceVersion: batch.sourceRetention.version, operationId: randomUUID() };
    const boot = await telegramCvAction(pool, owner, org, create);
    const replay = await telegramCvAction(pool, owner, org, create);
    assert.equal(replay.draftId, boot.draftId);
    if (index === 0) {
      const anotherOperation = { ...create, operationId: randomUUID() };
      assert.equal((await telegramCvAction(pool, owner, org, anotherOperation)).draftId, boot.draftId);
      await assert.rejects(telegramCvAction(pool, owner, org, { ...anotherOperation, messageId: '2' }), error => error.code === '40001',
        'Even a replay-only operation ID remains bound to its original attachment');
    }

    let draft = await getTelegramDraft(pool, owner, org, boot.draftId);
    assert.equal(draft.fields.telegramUsername ?? '', '', 'The sender is not the candidate');
    assert.equal(draft.fields.primaryEmail ?? '', '');
    if (index === 0) psql(db, `delete from app.cv_bootstraps where draft_id='${boot.draftId}'`);
    const cvJob = (await telegramCvWorkerOperation(workerPool, token, 'claim', proof)).job;
    await uploadTelegramCv(workerPool, token, { ...proof, jobId: cvJob.id, jobLeaseToken: cvJob.leaseToken, sourceDigest: cvJob.sourceDigest,
      sha256: createHash('sha256').update(doc.bytes).digest('hex'), sizeBytes: doc.bytes.length }, async () => doc.bytes, storage);
    if (index === 0) {
      assert.equal(psql(db, `select count(*) from app.cv_analyses where draft_id='${boot.draftId}'`).trim(), '1', 'retrieval starts analysis even for an already-linked draft without a bootstrap');
      psql(db, `delete from app.cv_analyses where draft_id='${boot.draftId}'`);
    }
    if (index) {
      draft = await getTelegramDraft(pool, owner, org, boot.draftId);
      draft = await updateTelegramDraft(pool, owner, org, draft.id, { expectedVersion: draft.version,
        fields: { firstName: 'Alex', lastName: 'Rivera', primaryEmail: 'alex.docx@example.invalid' } });
      await assert.rejects(decideTelegramDraft(pool, owner, org, draft.id, { action: 'approve', expectedVersion: draft.version,
        operationId: randomUUID() }), error => error.code === 'DRAFT_INCOMPLETE' && Boolean(error.fieldErrors.cvAnalysis));
      assert.equal((await profileSearchStatus(pool, owner, org, { scope: 'my_drafts', readyOnly: true })).coverage.eligible, 0,
        'Otherwise complete profiles with active analysis are excluded from ready-only semantic search');
    }
    let loseStage = 'parse'; let parseCalls = 0; let parsed;
    const previousProviderCalls = providerCalls;
    const host = async (action, body) => {
      const result = await cvAnalysisWorkerOperation(workerPool, token, action, body).catch(error => {
        error.status = { '40001': 409, '22023': 400, '42501': 403, P0002: 404 }[error.code]; throw error;
      });
      if (action === 'complete') {
        receipts.push(structuredClone(body));
        if (body.stage === loseStage) { loseStage = null; throw new Error('SYNTHETIC_ACK_LOST'); }
      }
      return result;
    };
    const email = index ? 'alex.docx@example.invalid' : cvAnalysisProfile.primaryEmail;
    const storeConfig = { root: join(root, `encrypted-${index}`), server: 'https://synthetic.invalid', workerToken: token };
    const makeRuntime = () => createCvAnalysisWorker({ host,
      readContent: input => readCvAnalysisContent(workerPool, token, input, storage),
      parse: async (bytes, options) => { parseCalls++; parsed = await runIsolatedParser(bytes, options); return parsed; },
      extract: provider, vault: createPendingStore(storeConfig) });
    let runtime = makeRuntime();
    await assert.rejects(runtime.tick(), /SYNTHETIC_ACK_LOST/);
    assert.equal(parseCalls, 1);
    runtime = makeRuntime(); await runtime.tick(); assert.equal(parseCalls, 1, 'Restart replays parsed text without reparsing');
    draft = await getTelegramDraft(pool, owner, org, boot.draftId);
    await updateTelegramDraft(pool, owner, org, draft.id, { expectedVersion: draft.version, fields: { location: 'Recruiter confirmed location' } });
    loseStage = 'facts';
    await assert.rejects(runtime.tick(), /SYNTHETIC_ACK_LOST/);
    assert.equal(providerCalls - previousProviderCalls, 1);
    draft = await getTelegramDraft(pool, owner, org, boot.draftId);
    assert.equal(draft.fields.firstName, 'Alex'); assert.equal(draft.fields.primaryEmail, email);
    assert.equal(draft.fields.location, 'Recruiter confirmed location');
    assert.equal(draft.pendingCvProposalCount, 1);
    assert.equal((await profileSearchStatus(pool, owner, org, { scope: 'my_drafts', readyOnly: true })).coverage.eligible, 0, 'Pending CV suggestions exclude ready-only profiles');
    let status = await cvAnalysisStatus(pool, owner, org, { draftId: draft.id });
    await cvAnalysisAction(pool, owner, org, { action: 'resolve', analysisId: status.current.id, proposalId: status.proposals[0].id,
      expectedDraftVersion: draft.version, decision: 'dismiss' });
    status = await cvAnalysisStatus(pool, owner, org, { draftId: draft.id });
    assert.equal(status.current.textDecision, 'include', 'Normal candidate approval includes its CV text without a second confirmation');
    assert.equal((await profileSearchStatus(pool, owner, org, { scope: 'my_drafts', readyOnly: true })).coverage.eligible, 1, 'Resolving suggestions restores ready-only eligibility');
    if (index) await cvAnalysisAction(pool, owner, org, { action: 'reviewText', analysisId: status.current.id,
      expectedAnalysisVersion: status.current.version, decision: 'exclude' });
    draft = await getTelegramDraft(pool, owner, org, draft.id);
    const approved = await decideTelegramDraft(pool, owner, org, draft.id, { action: 'approve', expectedVersion: draft.version, operationId: randomUUID() });
    assert.equal(approved.status, 'approved');
    const artifact = JSON.parse(psql(db, `select coalesce(jsonb_agg(jsonb_build_object('text',text_content,'documentSha256',document_sha256,'textSha256',text_sha256,'blocks',blocks)),'[]')::text from app.candidate_reviewed_cv_text where candidate_id='${approved.candidateId}'`).trim());
    if (index) assert.deepEqual(artifact, [], 'Exclude does not publish parsed text');
    else {
      assert.equal(artifact.length, 1);
      assert.equal(artifact[0].text, parsed.blocks.map(block => block.text).join('\n\n'));
      assert.equal(artifact[0].documentSha256, parsed.documentSha256);
      assert.equal(artifact[0].textSha256, parsed.textSha256);
      assert.deepEqual(artifact[0].blocks, parsed.blocks);
      // The real isolated parser and normal approval above now feed the actual
      // semantic queue. Synthetic vectors test delivery, not model relevance.
      const indexVersion = 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2@e8f8c211226b894fcb81acc59f3b34ba3efd5f42:mean-pool:l2:384:v1';
      const sha = value => createHash('sha256').update(value).digest('hex');
      const semantic = createSemanticWorker({
        host: (action, body) => profileSearchWorkerOperation(workerPool, token, action, body),
        plan: async ({ text, chunkerVersion }) => ({ index_version: indexVersion, chunker_version: chunkerVersion,
          source_sha256: sha(text), byte_length: Buffer.byteLength(text),
          chunks: [{ ordinal: 0, start_byte: 0, end_byte: Buffer.byteLength(text), sha256: sha(text), token_count: 100 }] }),
        embed: async ({ texts }) => ({ indexVersion, embeddings: texts.map(text => Array.from({ length: 384 }, (_, i) => i === (text.includes('Kafka') ? 0 : 1) ? 1 : 0)) }),
        vault: createSemanticStore({ root: join(root, 'semantic'), server: 'https://synthetic.invalid', workerToken: token }),
      });
      for (let tick = 0; tick < 50; tick++) if ((await semantic.tick()).status === 'idle') break;
      const query = await profileSearchAction(pool, owner, org, { action: 'search', operationId: randomUUID(), query: 'Kafka', scope: 'approved', readyOnly: false, includeCv: true });
      await semantic.tick();
      const matches = await profileSearchStatus(pool, owner, org, { queryId: query.queryId });
      assert.equal(matches.status, 'completed');
      const match = matches.results.find(row => row.sourceId === approved.candidateId);
      assert.equal(match.matchedComponent, 'cv');
      assert.match(match.matchedText, /Kafka/);
      assert.equal(match.score, 1);

    }
    await maintenance();
    assert.equal(Number(psql(db, `select count(*) from app.candidate_reviewed_cv_text where candidate_id='${approved.candidateId}'`).trim()), index ? 0 : 1);

    runtime = makeRuntime(); await runtime.tick(); assert.equal(providerCalls - previousProviderCalls, 1, 'Approved/cleaned replay never repeats model effects');
    const cleaned = await cvAnalysisStatus(pool, owner, org, { analysisId: status.current.id });
    assert.equal(cleaned.textAvailable, false);
    assert.equal(objects.size, index + 1, 'Approved CV bytes survive private parsed-text cleanup');
    assert.ok(parsed.blocks.some(block => block.text.includes(email)), 'DOCX header email is included');
  }
  psql(db, `update app.telegram_extraction_jobs set status='completed',error_code=null where id='${textJob.id}'`);
  const latestBatch = await telegramExtractionStatus(pool, owner, org, { jobId: textJob.id });
  await telegramExtractionAction(pool, owner, org, { action: 'sourceRetention', jobId: textJob.id, expectedSourceVersion: latestBatch.sourceRetention.version, mode: 'release_after_review' });
  await maintenance();
  assert.equal((await telegramExtractionStatus(pool, owner, org, { jobId: textJob.id })).source, null);
  for (const receipt of receipts) await cvAnalysisWorkerOperation(workerPool, token, 'complete', receipt);
  const changed = structuredClone(receipts.find(receipt => receipt.stage === 'facts'));
  changed.metadata.reportedModel = 'changed-model';
  await assert.rejects(cvAnalysisWorkerOperation(workerPool, token, 'complete', changed), error => error.code === '40001', 'Changed replay cannot reuse a purged receipt');
});
