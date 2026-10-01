import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import { POSTGRES_17_IMAGE, assertLocalTestEnvironment, psql, startPostgresContainer, stopAndRemoveContainer } from '../support/foundation-docker.js';
import { AUTHZ_ID, installStaffFixture, staffPoolOptions } from '../support/staff-authorization.js';
import { CJ_ID, CJ_SUBJECTS, clientJobFixtureSql } from '../support/client-job-workflows.js';
import { profileSearchStatus } from '../../src/lib/profile-search-operations.js';
import { withStaffTransaction } from '../../src/lib/staff-authorization.js';
import { telegramExtractionAction, telegramExtractionStatus, telegramExtractionWorkerOperation } from '../../src/lib/telegram-extraction-operations.js';
import { getTelegramDraft, decideTelegramDraft } from '../../src/lib/telegram-intake-operations.js';
const dir = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
const migrations = readdirSync(dir).filter(f => f >= '20260922090000_foundation_roles.sql' && f <= '20261002190000_telegram_retention.sql' && f.endsWith('.sql')).sort();
const identity = subject => ({ provider: 'google', issuer: 'https://accounts.google.com', subject });
const quoteSql = text => `'${String(text).replaceAll("'", "''")}'`;
const message = (id, text, extra = {}) => ({ messageId: String(id), kind: 'message', sentAt: '2026-01-01T00:00:00.000Z', editedAt: null, sender: { peer: { kind: 'user', id: '777' }, username: 'ali', displayName: 'Alice Smith' }, replyToMessageId: null, forwardedFrom: null, text, attachments: [], ...extra });

test('automatic catch-up and explicit reviewed-source cleanup', async t => {
    assertLocalTestEnvironment(); const container = await startPostgresContainer('pgtelegramextract', POSTGRES_17_IMAGE, { publish: true });
    let pool; let workerPool; let maintenancePool; t.after(async () => { await Promise.all([pool?.end(), workerPool?.end(), maintenancePool?.end()]); await stopAndRemoveContainer(container); });
    for (const f of migrations) {
        if (f === '20261002190000_telegram_retention.sql') {
            psql(container, 'create role retention_migration_operator login inherit nosuperuser createrole bypassrls; grant app_owner,app_executor to retention_migration_operator;');
            psql(container, `set session authorization retention_migration_operator; ${readFileSync(join(dir, f), 'utf8')} reset session authorization;`);
        } else psql(container, readFileSync(join(dir, f), 'utf8'));
    }
    const password = installStaffFixture(container); psql(container, clientJobFixtureSql);
    const { ORG_B } = AUTHZ_ID;
    psql(container, `insert into app.role_permissions(organization_id,role_id,permission_key) values('${ORG_B}','${CJ_ID.ROLE_B_RECRUITER}','candidates.write');`);
    pool = new pg.Pool(staffPoolOptions(container, password, 4));
    const workerPassword = randomUUID(); psql(container, `create role extraction_test login noinherit nosuperuser nocreatedb nocreaterole nobypassrls password '${workerPassword}'; grant app_telegram_worker to extraction_test;`);
    workerPool = new pg.Pool({ ...staffPoolOptions(container, workerPassword, 3), user: 'extraction_test' });
    const owner = identity(CJ_SUBJECTS.ADMIN); const other = identity(CJ_SUBJECTS.RECRUITER);
    const staff = (sql, args = [], who = owner) => withStaffTransaction(pool, who, ORG_B, ['candidates.read', 'candidates.write'], async ({ client }) => (await client.query(sql, args)).rows[0]?.result);
    const user = await staff("select app.context_uuid_v1('app.actor_id') as result");
    const token = randomBytes(48).toString('base64url'); const otherToken = randomBytes(48).toString('base64url');
    const worker = await staff('select app.telegram_register_worker_v1($1,$2) as result', ['Extractor', token]);
    await staff('select app.telegram_register_worker_v1($1,$2) as result', ['Other extractor', otherToken], other);
    const publicKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const connection = randomUUID(); const account = randomUUID(); const chat = randomUUID();
    psql(container, `insert into app.telegram_connector_workers(id,organization_id,owner_user_id,public_key_spki) values('${worker.id}','${ORG_B}','${user}','${publicKey}');
      insert into app.telegram_connections(id,organization_id,owner_user_id,worker_id,status,auth_expires_at) values('${connection}','${ORG_B}','${user}','${worker.id}','disconnected',now());
      insert into app.telegram_history_accounts(id,organization_id,owner_user_id,connection_id,account_user_id) values('${account}','${ORG_B}','${user}','${connection}','999');
      insert into app.telegram_history_limits(organization_id,owner_user_id) values('${ORG_B}','${user}');
      insert into app.telegram_history_chats(id,organization_id,owner_user_id,account_id,peer_kind,peer_id,title) values('${chat}','${ORG_B}','${user}','${account}','user','777','Synthetic extraction chat');`);
    const insert = (records, cid = chat) => {
        for (const m of records) psql(container, `insert into app.telegram_history_messages(organization_id,owner_user_id,chat_id,message_id,body,stored_bytes) values('${ORG_B}','${user}','${cid}',${m.messageId},${quoteSql(JSON.stringify(m))},octet_length(${quoteSql(JSON.stringify(m))}::jsonb::text));`);
    };
    const call = (action, input = {}, credential = token) => telegramExtractionWorkerOperation(workerPool, credential, action, input);
    const action = (input, who = owner) => telegramExtractionAction(pool, who, ORG_B, input);
    const status = (filters = {}, who = owner) => telegramExtractionStatus(pool, who, ORG_B, filters);
    const draft = id => getTelegramDraft(pool, owner, ORG_B, id);
    const maintenancePassword = randomUUID(); psql(container, `create role retention_maintenance login noinherit nosuperuser nocreatedb nocreaterole nobypassrls password '${maintenancePassword}'; grant app_telegram_maintenance to retention_maintenance;`);
    maintenancePool = new pg.Pool({ ...staffPoolOptions(container, maintenancePassword, 2), user: 'retention_maintenance' });
    const maintain = async () => { const c = await maintenancePool.connect(); try { await c.query("begin; set local role app_telegram_maintenance; set local statement_timeout='10s'; set local lock_timeout='500ms'"); const r = (await c.query('select app.telegram_maintenance_v1() result')).rows[0].result; await c.query('commit'); return r; } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); } };
    const recount = () => psql(container, `update app.telegram_history_limits set stored_messages=(select count(*) from app.telegram_history_messages),stored_bytes=(select coalesce(sum(stored_bytes),0) from app.telegram_history_messages) where owner_user_id='${user}'`);
    const due = () => psql(container, `update app.telegram_maintenance_owners set due_at=now(); update app.telegram_extraction_jobs set cleanup_due_at=now() where source_release_requested_at is not null and source_purged_at is null`);
    const fact = (field, value, m) => ({ field, value, evidence: [{ messageId: m.messageId, quote: m.text }] });
    const subject = (m, fields, ident = { kind: 'telegram_sender', messageId: m.messageId, quote: m.text }) => ({ subjects: [{ key: 'person', identity: ident, facts: Object.entries(fields).map(([k, v]) => fact(k, v, m)), attachments: [] }] });
    const complete = (j, result) => ({ jobId: j.id, leaseToken: j.leaseToken, sourceDigest: j.sourceDigest, result, metadata: { model: 'synthetic-demo', promptVersion: 'candidate-extraction-prompt-v1', reportedModel: null } });
    let first; let payload; let person;
    await t.test('enable/disable catch-up is versioned, private and receives late import pages', async () => {
        const m = message(1, 'I am Alice Smith, email alice@example.test.'); insert([m]); recount();
        assert.equal((await call('claim')).job, null);
        await assert.rejects(action({ action: 'setExtraction', chats: [{ chatId: chat, expectedVersion: 1 }], enabled: true }, other));
        const enabled = await action({ action: 'setExtraction', chats: [{ chatId: chat, expectedVersion: 1 }], enabled: true }); assert.equal(enabled.queued, 1); assert.equal((await status()).jobs[0].sourceRetention.state, 'kept');
        await assert.rejects(action({ action: 'setExtraction', chats: [{ chatId: chat, expectedVersion: 1 }], enabled: false }), { code: '40001' });
        await action({ action: 'setExtraction', chats: [{ chatId: chat, expectedVersion: 2 }], enabled: false }); assert.equal((await call('claim')).job, null);
        await action({ action: 'setExtraction', chats: [{ chatId: chat, expectedVersion: 3 }], enabled: true }); first = (await call('claim')).job;
        payload = complete(first, subject(m, { firstName: 'Alice', lastName: 'Smith', primaryEmail: 'alice@example.test' })); person = (await call('complete', payload)).draftIds[0];
        insert([message(2, 'Client and job context for explicit review.')]); recount();
        const late = (await call('claim')).job; assert(late); assert.equal(late.source.messages[0].messageId, '2'); await call('complete', complete(late, { subjects: [] }));
        assert.equal((await status({ jobId: late.id })).sourceRetention.state, 'kept'); due(); await maintain(); assert((await status({ jobId: late.id })).source, 'zero-subject context stays until explicit release');
    });
    await t.test('explicit release waits for drafts and purges exactly once; receipt survives source deletion', async () => {
        let snap = await status({ jobId: first.id }); assert.equal(snap.sourceRetention.holds.openDrafts, 1);
        await assert.rejects(staff('select app.telegram_extraction_action_v1($1::jsonb) result', [JSON.stringify({ action: 'sourceRetention', jobId: first.id, expectedSourceVersion: snap.sourceRetention.version, mode: null })]), { code: '40001' });
        await action({ action: 'sourceRetention', jobId: first.id, expectedSourceVersion: snap.sourceRetention.version, mode: 'release_after_review' });
        snap = await status({ jobId: first.id });
        await action({ action: 'sourceRetention', jobId: first.id, expectedSourceVersion: snap.sourceRetention.version, mode: 'keep' });
        await assert.rejects(action({ action: 'sourceRetention', jobId: first.id, expectedSourceVersion: snap.sourceRetention.version, mode: 'release_after_review' }), { code: '40001' });
        snap = await status({ jobId: first.id }); assert.equal(snap.sourceRetention.state, 'kept');
        const release = await action({ action: 'sourceRetention', jobId: first.id, expectedSourceVersion: snap.sourceRetention.version, mode: 'release_after_review' }); assert.equal(release.sourceRetention.state, 'release_pending');
        due(); assert.equal((await maintain()).batchesPurged, 0); assert((await status({ jobId: first.id })).source);
        const d = await draft(person); await decideTelegramDraft(pool, owner, ORG_B, d.id, { expectedVersion: d.version, action: 'discard', operationId: randomUUID() });
        assert(!(await status({ view: 'needs_review' })).jobs.some(j => j.id === first.id), 'released closed batch leaves review queue before physical purge');
        assert((await status()).jobs.some(j => j.id === first.id), 'released batch remains visible in all batches');
        const removed = await maintain(); assert.equal(removed.batchesPurged, 1); assert.equal(removed.messagesPurged, 1); assert(removed.bytesFreed > 0);
        snap = await status({ jobId: first.id }); assert.equal(snap.source, null); assert.equal(snap.sourceRetention.state, 'purged');
        assert.deepEqual(await call('complete', payload), { ok: true, draftIds: [person], proposalCount: 0, nextQueued: false });
        await assert.rejects(call('complete', { ...payload, result: { subjects: [] } }), { code: '40001' });
        assert.equal((await maintain()).messagesPurged, 0); assert.equal(psql(container, `select count(*) from app.telegram_extraction_sources where job_id='${first.id}'`).trim(), '1');
        assert.equal(psql(container, 'select stored_messages from app.telegram_history_limits').trim(), '1');
        await assert.rejects(action({ action: 'sourceRetention', jobId: first.id, expectedSourceVersion: snap.sourceRetention.version, mode: 'keep' }), { code: '40001' });
    });
    await t.test('legal oversized singleton remains complete and failed provider work stays private', async () => {
        const m = message(3, '長い本文'.repeat(7000)); insert([m]); recount();
        const j = (await call('claim')).job; assert.equal(j.sourceLimitBytes, 327680); assert.equal(j.source.messages.length, 1); assert.equal(j.source.messages[0].text, m.text);
        await call('fail', { jobId: j.id, leaseToken: j.leaseToken, code: 'INVALID_RESULT', retryAfterSeconds: 1 });
        due(); await maintain(); assert(psql(container, `select body->>'text' from app.telegram_history_messages where message_id=3`).includes('長い本文'));
        await action({ action: 'retry', jobId: j.id }); const retry = (await call('claim')).job; await call('complete', complete(retry, { subjects: [] }));
        const snap = await status({ jobId: j.id }); await action({ action: 'sourceRetention', jobId: j.id, expectedSourceVersion: snap.sourceRetention.version, mode: 'release_after_review' });
        assert.equal((await maintain()).messagesPurged, 1);
    });
    await t.test('a shared batch stays while any draft is open, then clears every evidence copy', async () => {
        const m = message(10, 'Left Person left@example.test and Right Person right@example.test.'); insert([m]); recount(); const j = (await call('claim')).job;
        const left = subject(m, { firstName: 'Left', lastName: 'Person', primaryEmail: 'left@example.test' }, { kind: 'email', email: 'left@example.test' }).subjects[0];
        const right = subject(m, { firstName: 'Right', lastName: 'Person', primaryEmail: 'right@example.test' }, { kind: 'email', email: 'right@example.test' }).subjects[0]; right.key = 'right';
        const receipt = await call('complete', complete(j, { subjects: [left, right] }));
        await action({ action: 'sourceRetention', jobId: j.id, expectedSourceVersion: 1, mode: 'release_after_review' });
        let d = await draft(receipt.draftIds[0]); await decideTelegramDraft(pool, owner, ORG_B, d.id, { expectedVersion: d.version, action: 'discard', operationId: randomUUID() });
        assert.equal((await maintain()).batchesPurged, 0); assert.equal((await status({ jobId: j.id })).sourceRetention.holds.openDrafts, 1);
        d = await draft(receipt.draftIds[1]); await decideTelegramDraft(pool, owner, ORG_B, d.id, { expectedVersion: d.version, action: 'discard', operationId: randomUUID() });
        assert.equal((await maintain()).batchesPurged, 1); assert.equal(psql(container, `select count(*) from app.telegram_evidence where extraction_job_id='${j.id}'`).trim(), '0');
    });
    await t.test('late approved suggestions and active CV consumers hold evidence until explicitly resolved', async () => {
        const m = message(11, 'Bob Smith bob@example.test compensation 1000.'); insert([m]); recount(); let j = (await call('claim')).job;
        const r = await call('complete', complete(j, subject(m, { firstName: 'Bob', lastName: 'Smith', primaryEmail: 'bob@example.test', compensationPreference: '1000' }, { kind: 'email', email: 'bob@example.test' })));
        let d = await draft(r.draftIds[0]); const target = await staff('select app.telegram_cv_target_v1($1) as result', [d.id]);
        const doc = { filename: 'Reviewed CV.pdf', sha256: 'a'.repeat(64), sizeBytes: 500, extension: 'pdf', mimeType: 'application/pdf', objectKey: `staff/${ORG_B}/${target}/${randomUUID()}.pdf` };
        await staff('select app.telegram_reserve_upload_v1($1,$2,$3) as result', [d.id, d.version, doc.objectKey]);
        d = await staff('select app.telegram_attach_cv_v1($1,$2,$3::jsonb) as result', [d.id, d.version, JSON.stringify(doc)]);
        const approved = await decideTelegramDraft(pool, owner, ORG_B, d.id, { expectedVersion: d.version, action: 'approve', operationId: randomUUID() });
        const late = message(12, 'Bob Smith bob@example.test compensation 2000.'); insert([late]); recount(); j = (await call('claim')).job;
        await call('complete', complete(j, subject(late, { primaryEmail: 'bob@example.test', compensationPreference: '2000' }, { kind: 'email', email: 'bob@example.test' })));
        await action({ action: 'sourceRetention', jobId: j.id, expectedSourceVersion: 1, mode: 'release_after_review' });
        assert.equal((await maintain()).batchesPurged, 0); assert.equal((await status({ jobId: j.id })).sourceRetention.holds.pendingProposals, 1);
        d = await draft(d.id); const pending = (await status({ draftId: d.id })).proposals[0]; await action({ action: 'resolve', proposalId: pending.id, decision: 'dismiss', expectedDraftVersion: d.version });
        // A synthetic outstanding CV lease models an interrupted in-flight consumer;
        // the sweeper must still prove its absence even for a closed draft.
        const cv = randomUUID(); psql(container, `insert into app.telegram_cv_jobs(id,organization_id,owner_user_id,draft_id,account_id,extraction_job_id,connection_id,connection_generation,document_revision,source,source_digest) values('${cv}','${ORG_B}','${user}','${d.id}','${account}','${j.id}','${connection}',1,0,'{}',sha256('synthetic'))`);
        assert.equal((await maintain()).batchesPurged, 0); assert.equal((await status({ jobId: j.id })).sourceRetention.holds.activeCv, 1);
        psql(container, `update app.telegram_cv_jobs set status='cancelled' where id='${cv}'`); assert.equal((await maintain()).batchesPurged, 1);
        assert.equal(psql(container, `select count(*) from app.telegram_evidence where extraction_job_id='${j.id}'`).trim(), '0');
        assert.equal(psql(container, `select compensation_preference from app.candidates where id='${approved.candidateId}'`).trim(), '1000');
    });
    await t.test('previously authorized disposal still runs after membership is disabled', async () => {
        const m = message(13, 'Reviewed unrelated client context.'); insert([m]); recount(); const j = (await call('claim')).job; await call('complete', complete(j, { subjects: [] }));
        await action({ action: 'sourceRetention', jobId: j.id, expectedSourceVersion: 1, mode: 'release_after_review' });
        psql(container, `update app.organization_memberships set status='revoked',revoked_at=now() where organization_id='${ORG_B}' and user_id='${user}'`);
        try { assert.equal((await maintain()).batchesPurged, 1); } finally { psql(container, `update app.organization_memberships set status='active',revoked_at=null where organization_id='${ORG_B}' and user_id='${user}'`); }
    });
    await t.test('expired query text becomes unusable immediately while result deletion remains bounded', async () => {
        const qid = randomUUID();
        psql(container, `insert into app.profile_search_queries(id,organization_id,owner_user_id,operation_id,request_digest,query_text,query_sha256,scope,ready_only,status,expires_at) values('${qid}','${ORG_B}','${user}',gen_random_uuid(),sha256('synthetic'),'Private expired search',repeat('a',64),'approved',false,'completed',now()-interval '1 second');
        insert into app.profile_search_sources(organization_id,source_type,source_id,status) select '${ORG_B}','candidate',gen_random_uuid(),'retired' from generate_series(1,6000);
        insert into app.profile_search_results(query_id,source_id,organization_id,owner_user_id,source_revision,score,ordinal,source_type,public_source_id) select '${qid}',id,'${ORG_B}','${user}',revision,0,0,source_type,source_id from app.profile_search_sources where organization_id='${ORG_B}' and status='retired' limit 6000;`);
        const expired = await profileSearchStatus(pool, owner, ORG_B, { queryId: qid }); assert.equal(expired.status, 'expired'); assert.equal(expired.query, null); assert.deepEqual(expired.results, []);
        let remaining = Number(psql(container, `select count(*) from app.profile_search_results where query_id='${qid}'`).trim()); assert(remaining > 0);
        for (let i = 0; remaining && i < 3; i++) { const r = await maintain(); assert(r.queriesExpired <= 100); assert(r.queryResultRowsDeleted <= 5000); const next = Number(psql(container, `select count(*) from app.profile_search_results where query_id='${qid}'`).trim()); assert(next < remaining); remaining = next; }
        assert.equal(remaining, 0);
    });
    await t.test('maintenance role cannot read sources or call staff functions', async () => {
        const c = await maintenancePool.connect(); try { await c.query('set role app_telegram_maintenance'); await assert.rejects(c.query('select app.telegram_maintenance_v1(null)'), { code: '22023' }); await assert.rejects(c.query('select * from app.telegram_extraction_jobs'), { code: '42501' }); await assert.rejects(c.query("select app.telegram_extraction_action_v1('{}')"), { code: '42501' }); } finally { c.release(); }
    });
});
