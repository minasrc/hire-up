import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import { POSTGRES_17_IMAGE, assertLocalTestEnvironment, psql, startPostgresContainer, stopAndRemoveContainer } from '../support/foundation-docker.js';
import { AUTHZ_ID, installStaffFixture, staffPoolOptions } from '../support/staff-authorization.js';
import { CJ_SUBJECTS, clientJobFixtureSql } from '../support/client-job-workflows.js';
import { createSyntheticPdf } from '../support/cv-fixtures.js';
import { withStaffTransaction } from '../../src/lib/staff-authorization.js';
import { createTelegramDraft, getTelegramDraft, decideTelegramDraft, updateTelegramDraft, listTelegramDrafts } from '../../src/lib/telegram-intake-operations.js';
import { cvAnalysisStatus, cvAnalysisAction, cvAnalysisWorkerOperation, readCvAnalysisContent } from '../../src/lib/cv-analysis-operations.js';
import { profileSearchAction, profileSearchStatus } from '../../src/lib/profile-search-operations.js';
import { createPrivacyRequest, reviewPrivacySubject, verifyPrivacyRequest, restrictPrivacySubject } from '../../src/lib/privacy-operations.js';
import { CV_ANALYSIS_PARSER_VERSION, CV_ANALYSIS_PROMPT_VERSION } from '../../src/lib/cv-analysis-contracts.js';
const dir = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
const migrations = readdirSync(dir).filter(f => f >= '20260922090000_foundation_roles.sql' && f <= '20261002210000_cv_search.sql' && f.endsWith('.sql')).sort();
const identity = subject => ({ provider: 'google', issuer: 'https://accounts.google.com', subject });
const hash = b => createHash('sha256').update(b).digest('hex');
const bytes = createSyntheticPdf();
const blocks = text => [{ ordinal: 0, kind: 'pdf_page', page: 1, text, sha256: hash(text) }];
const parse = (job, text) => ({ jobId: job.id, leaseToken: job.leaseToken, sourceDigest: job.sourceDigest, stage: 'parse', result: { parserVersion: CV_ANALYSIS_PARSER_VERSION, documentSha256: hash(bytes), textSha256: hash(text), blocks: blocks(text) } });
const facts = (job, fields) => ({ jobId: job.id, leaseToken: job.leaseToken, sourceDigest: job.sourceDigest, stage: 'facts', result: { facts: Object.entries(fields).map(([field, value]) => ({ field, value, evidence: [{ blockOrdinal: 0, startByte: 0, endByte: Buffer.byteLength(job.source.blocks[0].text), quote: job.source.blocks[0].text }] })), issues: [] }, metadata: { model: 'synthetic-model', promptVersion: CV_ANALYSIS_PROMPT_VERSION, reportedModel: null } });

test('CV analysis preserves document evidence, human review and private lifecycle', async t => {
    assertLocalTestEnvironment(); const container = await startPostgresContainer('pgcvanalysis', POSTGRES_17_IMAGE, { publish: true });
    let pool; let workerPool; let maintenancePool; t.after(async () => { await Promise.all([pool?.end(), workerPool?.end(), maintenancePool?.end()]); await stopAndRemoveContainer(container); });
    for (const f of migrations) {
        if (f === '20261002200000_cv_analysis.sql') {
            psql(container, 'create role cv_migration_operator login inherit nosuperuser createrole bypassrls; grant app_owner,app_executor to cv_migration_operator;');
            psql(container, `set session authorization cv_migration_operator; ${readFileSync(join(dir, f), 'utf8')} reset session authorization;`);
        } else psql(container, readFileSync(join(dir, f), 'utf8'));
    }
    const password = installStaffFixture(container); psql(container, clientJobFixtureSql); const { ORG_B } = AUTHZ_ID;
    pool = new pg.Pool(staffPoolOptions(container, password, 4));
    const workerPassword = randomUUID(); psql(container, `create role analysis_test login noinherit nosuperuser nocreatedb nocreaterole nobypassrls password '${workerPassword}'; grant app_telegram_worker to analysis_test;`);
    workerPool = new pg.Pool({ ...staffPoolOptions(container, workerPassword, 3), user: 'analysis_test' });
    const owner = identity(CJ_SUBJECTS.ADMIN), other = identity(CJ_SUBJECTS.RECRUITER);
    const staff = (sql, args = [], who = owner) => withStaffTransaction(pool, who, ORG_B, ['candidates.read', 'candidates.write'], async ({ client }) => (await client.query(sql, args)).rows[0]?.result);
    const user = await staff("select app.context_uuid_v1('app.actor_id') result");
    const token = randomBytes(48).toString('base64url'); await staff('select app.telegram_register_worker_v1($1,$2) result', ['CV test', token]);
    const call = (action, input = {}) => cvAnalysisWorkerOperation(workerPool, token, action, input);
    const action = input => cvAnalysisAction(pool, owner, ORG_B, input);
    const status = filters => cvAnalysisStatus(pool, owner, ORG_B, filters);
    const draft = id => getTelegramDraft(pool, owner, ORG_B, id);
    const attach = async d => {
        const target = await staff('select app.telegram_cv_target_v1($1) result', [d.id]);
        const document = { filename: 'Synthetic CV.pdf', sha256: hash(bytes), sizeBytes: bytes.length, extension: 'pdf', mimeType: 'application/pdf', objectKey: `staff/${ORG_B}/${target}/${randomUUID()}.pdf` };
        await staff('select app.telegram_reserve_upload_v1($1,$2,$3) result', [d.id, d.version, document.objectKey]);
        return staff('select app.telegram_attach_cv_v1($1,$2,$3::jsonb) result', [d.id, d.version, JSON.stringify(document)]);
    };
    const fresh = async (fields = {}) => attach(await createTelegramDraft(pool, owner, ORG_B, { fields }));
    const analyze = d => action({ action: 'analyze', draftId: d.id, expectedDocumentRevision: d.documentRevision, operationId: randomUUID() });
    const mp = randomUUID(); psql(container, `create role analysis_maintenance login noinherit password '${mp}'; grant app_telegram_maintenance to analysis_maintenance;`);
    maintenancePool = new pg.Pool({ ...staffPoolOptions(container, mp, 2), user: 'analysis_maintenance' });
    const maintain = async () => { const c = await maintenancePool.connect(); try { await c.query('begin; set local role app_telegram_maintenance'); const out = (await c.query('select app.telegram_maintenance_v1() result')).rows[0].result; await c.query('commit'); return out; } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); } };
    await t.test('replacement wrappers are not executable by worker or maintenance roles', async () => {
        for (const role of ['app_telegram_worker', 'app_telegram_maintenance']) {
            for (const sig of ['app.telegram_cv_action_v1(jsonb)', 'app.telegram_draft_json_v1(app.telegram_drafts)']) {
                assert.equal(psql(container, `select has_function_privilege('${role}','${sig}','EXECUTE')`).trim(), 'f');
            }
        }
        for (const [restrictedPool, restrictedRole] of [[workerPool, 'app_telegram_worker'], [maintenancePool, 'app_telegram_maintenance']]) {
        const c = await restrictedPool.connect();
        try {
            await c.query(`begin;set local role ${restrictedRole}`);
            await c.query("select set_config('app.organization_id',$1,true),set_config('app.actor_id',$2,true)", [ORG_B, user]);
            await assert.rejects(c.query("select app.telegram_cv_action_v1('{}'::jsonb)"), { code: '42501' });
            await c.query('rollback');
        } finally { c.release(); }
        }
        assert.equal(psql(container, `select count(*) from pg_proc p where pronamespace='app'::regnamespace and (proname like 'cv_analysis_%' or proname like 'cv_bootstrap_%' or proname in('cv_reviewed_text_v1','telegram_cv_action_v1','telegram_draft_json_v1')) and exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE')`).trim(), '0');
        assert.equal(psql(container, "select has_function_privilege('app_staff','app.cv_analysis_claim_v1(text)','EXECUTE')").trim(), 'f');
        assert.equal(psql(container, "select has_function_privilege('app_telegram_worker','app.telegram_maintenance_v1(integer)','EXECUTE')").trim(), 'f');
    });
    let first; let parsed; let completed; let candidate;
    await t.test('manual CV works without Telegram connection, with exact stage receipts and as-is approval', async () => {
        first = await fresh(); const r = await analyze(first); assert.equal(r.analysis.stage, 'parse');
        assert.equal((await status({ draftId: first.id })).analysisReviewRequired, true);
        await assert.rejects(cvAnalysisStatus(pool, other, ORG_B, { draftId: first.id }));
        let j = (await call('claim')).job; assert.equal(j.source.documentSha256, hash(bytes)); assert.equal(j.source.objectKey, undefined);
        const proof = { jobId: j.id, leaseToken: j.leaseToken, sourceDigest: j.sourceDigest };
        const storage = { storage: { from: () => ({ download: () => ({ asStream: async () => ({ data: new Blob([bytes]).stream() }) }) }) } };
        assert.deepEqual(await readCvAnalysisContent(workerPool, token, proof, storage), new Uint8Array(bytes));
        parsed = parse(j, 'Alice Smith alice@example.test wants Remote roles.');
        const malformed = structuredClone(parsed); delete malformed.result.blocks[0].ordinal;
        const c = await workerPool.connect(); try { await c.query('begin;set local role app_telegram_worker'); await assert.rejects(c.query('select app.cv_analysis_complete_v1($1,$2::jsonb)', [token, JSON.stringify(malformed)]), { code: '22023' }); await c.query('rollback');
            await c.query('begin;set local role app_telegram_worker');
            await assert.rejects(c.query('select app.cv_analysis_complete_v1($1,$2::jsonb)', [token, JSON.stringify({ ...parsed, result: { ...parsed.result, textSha256: null } })]), { code: '22023' }); await c.query('rollback');
        } finally { c.release(); }
        await call('complete', parsed); assert.equal((await call('complete', parsed)).nextStage, 'facts');
        j = (await call('claim')).job; completed = facts(j, { firstName: 'Alice', lastName: 'Smith', primaryEmail: 'alice@example.test', location: 'Remote' }); await call('complete', completed);
        first = await draft(first.id); assert.equal(first.analysisReviewRequired, false); assert.equal((await status({ draftId: first.id })).current.textDecision, 'include');
        assert((await listTelegramDrafts(pool, owner, ORG_B, { view: 'ready' })).drafts.some(d => d.id === first.id));
        const approved = await decideTelegramDraft(pool, owner, ORG_B, first.id, { expectedVersion: first.version, action: 'approve', operationId: randomUUID() }); candidate = approved.candidateId;
        const artifact = await staff('select app.cv_reviewed_text_v1($1) result', [candidate]); assert.equal(artifact.text, parsed.result.blocks[0].text); assert.equal(artifact.documentSha256, hash(bytes));
        assert.equal((await maintain()).analysesPurged, 1); assert.equal((await status({ analysisId: j.id })).textAvailable, false);
        assert.equal((await call('complete', parsed)).stage, 'parse'); assert.equal((await call('complete', completed)).stage, 'facts');
        await assert.rejects(call('complete', { ...completed, result: { facts: [], issues: [] } }), { code: '40001' });
        assert.equal((await staff('select app.cv_reviewed_text_v1($1) result', [candidate])).text, artifact.text);
    });
    await t.test('human changes become suggestions; optional exclusion retains no canonical raw text', async () => {
        let d = await fresh({ firstName: 'Human', lastName: 'Jones', primaryEmail: 'human@example.test' }); await analyze(d);
        let j = (await call('claim')).job; await call('complete', parse(j, 'Other Jones other@example.test wants Paris.')); j = (await call('claim')).job;
        d = await updateTelegramDraft(pool, owner, ORG_B, d.id, { expectedVersion: d.version, fields: { location: 'London' } });
        await call('complete', facts(j, { location: 'Paris' })); d = await draft(d.id); assert.equal(d.fields.location, 'London'); assert.equal(d.pendingCvProposalCount, 1);
        await assert.rejects(decideTelegramDraft(pool, owner, ORG_B, d.id, { expectedVersion: d.version, action: 'approve', operationId: randomUUID() }), e => e.code === 'DRAFT_INCOMPLETE');
        const s = await status({ draftId: d.id }); await action({ action: 'resolve', analysisId: j.id, proposalId: s.proposals[0].id, expectedDraftVersion: d.version, decision: 'dismiss' });
        const a = (await status({ draftId: d.id })).current; await action({ action: 'reviewText', analysisId: a.id, expectedAnalysisVersion: a.version, decision: 'exclude' });
        d = await draft(d.id); const approved = await decideTelegramDraft(pool, owner, ORG_B, d.id, { expectedVersion: d.version, action: 'approve', operationId: randomUUID() });
        await assert.rejects(staff('select app.cv_reviewed_text_v1($1) result', [approved.candidateId]), { code: 'P0002' });
    });
    await t.test('replacement fences analysis and bounds cleanup while preserving current file and profile edits', async () => {
        let d = await fresh({ firstName: 'Keep' }); await analyze(d); const old = (await call('claim')).job; await call('complete', parse(old, 'Keep Source keep@example.test')); const factsJob = (await call('claim')).job;
        d = await draft(d.id); d = await attach(d); assert.equal(d.fields.firstName, 'Keep');
        await assert.rejects(call('complete', facts(factsJob, { firstName: 'Keep' })), { code: '40001' });
        assert((await maintain()).analysesPurged >= 1); assert.equal((await status({ analysisId: old.id })).textAvailable, false);
        const current = await analyze(d); assert.notEqual(current.analysis.id, old.id);
        await action({ action: 'cancel', analysisId: current.analysis.id, expectedAnalysisVersion: current.analysis.version });
    });
    await t.test('download permission revocation fences content after I/O and all completion receipts', async () => {
        const d = await fresh(); await analyze(d); const j = (await call('claim')).job;
        const role = psql(container, `select role_id from app.organization_memberships where organization_id='${ORG_B}' and user_id='${user}'`).trim();
        const revoke = () => psql(container, `delete from app.role_permissions where organization_id='${ORG_B}' and role_id='${role}' and permission_key='documents.download'`);
        const restore = () => psql(container, `insert into app.role_permissions values('${ORG_B}','${role}','documents.download') on conflict do nothing`);
        const storage = { storage: { from: () => ({ download: () => ({ asStream: async () => { revoke(); return { data: new Blob([bytes]).stream() }; } }) }) } };
        try {
            await assert.rejects(readCvAnalysisContent(workerPool, token, { jobId: j.id, leaseToken: j.leaseToken, sourceDigest: j.sourceDigest }, storage), { code: '42501' });
            await assert.rejects(call('complete', parsed), { code: '42501' });
            await assert.rejects(staff('select app.cv_reviewed_text_v1($1) result', [candidate]), { code: '42501' });
        } finally { restore(); }
    });
    await t.test('ready-only search and cached results recheck live analysis readiness', async () => {
        let d = await fresh({ firstName: 'Ready', lastName: 'Person', primaryEmail: 'ready@example.test' });
        psql(container, `update app.telegram_drafts set document=document||'{"filename":"Renamed CV.pdf"}'::jsonb where id='${d.id}'`);
        d = await draft(d.id);
        const sid = psql(container, `select id from app.profile_search_sources where source_id='${d.id}'`).trim();
        psql(container, `select set_config('app.organization_id','${ORG_B}',false),set_config('app.actor_id','${user}',false);update app.profile_search_sources set status='ready',projection_text='Ready Person',source_sha256=encode(sha256('Ready Person'),'hex') where id='${sid}';
          insert into app.profile_search_chunks(source_id,organization_id,owner_user_id,revision,ordinal,start_byte,end_byte,sha256,token_count,embedding) select id,organization_id,owner_user_id,revision,0,0,12,encode(sha256('Ready Person'),'hex'),3,array[1::real]||array_fill(0::real,array[383]) from app.profile_search_sources where id='${sid}';`);
        const q = await profileSearchAction(pool, owner, ORG_B, { action: 'search', operationId: randomUUID(), query: 'Ready', scope: 'my_drafts', readyOnly: true });
        psql(container, `update app.profile_search_queries set status='completed' where id='${q.queryId}';insert into app.profile_search_results(query_id,source_id,organization_id,owner_user_id,source_revision,score,ordinal,source_type,public_source_id) select '${q.queryId}',id,organization_id,owner_user_id,revision,1,0,source_type,source_id from app.profile_search_sources where id='${sid}';`);
        assert((await profileSearchStatus(pool, owner, ORG_B, { queryId: q.queryId })).results.some(r => r.sourceId === d.id));
        const a = (await analyze(d)).analysis;
        assert(!(await profileSearchStatus(pool, owner, ORG_B, { queryId: q.queryId })).results.some(r => r.sourceId === d.id));
        assert((await listTelegramDrafts(pool, owner, ORG_B, { missing: 'cvAnalysis', view: 'needs_information' })).drafts.some(r => r.id === d.id));
        await action({ action: 'cancel', analysisId: a.id, expectedAnalysisVersion: a.version });
        assert((await profileSearchStatus(pool, owner, ORG_B, { queryId: q.queryId })).results.some(r => r.sourceId === d.id));
    });
    await t.test('cross-email conflicts remain pending rather than making the draft invalid', async () => {
        for (const [initial, suggested] of [[{ secondaryEmails: ['duplicate@example.test'] }, { primaryEmail: 'duplicate@example.test' }], [{ primaryEmail: 'duplicate@example.test' }, { secondaryEmails: ['duplicate@example.test'] }]]) {
            const d = await fresh(initial); await analyze(d); let j = (await call('claim')).job;
            await call('complete', parse(j, 'Duplicate Person duplicate@example.test')); j = (await call('claim')).job;
            await call('complete', facts(j, suggested)); const updated = await draft(d.id);
            assert.deepEqual(updated.fields, d.fields); assert.equal(updated.pendingCvProposalCount, 1);
            const proposal = (await status({ draftId: d.id })).proposals[0];
            await assert.rejects(action({ action: 'resolve', analysisId: j.id, proposalId: proposal.id, expectedDraftVersion: updated.version, decision: 'apply' }));
            await action({ action: 'resolve', analysisId: j.id, proposalId: proposal.id, expectedDraftVersion: updated.version, decision: 'dismiss' });
        }
    });
    await t.test('five transient failures remain recoverable and retry reuses exact parsed evidence', async () => {
        const d = await fresh(); await analyze(d); let j = (await call('claim')).job;
        await call('complete', parse(j, 'Retry Person retry@example.test'));
        for (let attempt = 1; attempt <= 5; attempt++) {
            j = (await call('claim')).job; assert.equal(j.stage, 'facts');
            const failure = { jobId: j.id, leaseToken: j.leaseToken, sourceDigest: j.sourceDigest, stage: 'facts', code: 'PROVIDER_UNAVAILABLE', retryAfterSeconds: 1 };
            await call('fail', failure); await call('fail', failure);
            psql(container, `update app.cv_analyses set available_at=now() where id='${j.id}'`);
        }
        let a = (await status({ draftId: d.id })).current; assert.equal(a.status, 'failed'); assert.equal(a.errorCode, 'ATTEMPTS_EXHAUSTED');
        await action({ action: 'retry', analysisId: a.id, expectedAnalysisVersion: a.version });
        a = (await status({ draftId: d.id })).current; assert.equal(a.textDecision, 'pending'); assert.equal(a.attempts, 0);
        j = (await call('claim')).job; assert.equal(j.stage, 'facts'); assert.equal(j.source.blocks[0].text, 'Retry Person retry@example.test');
        await call('complete', facts(j, { firstName: 'Retry', lastName: 'Person', primaryEmail: 'retry@example.test' }));
        assert.equal((await draft(d.id)).pendingCvProposalCount, 0); assert.equal((await status({ draftId: d.id })).current.textDecision, 'include');
    });
    await t.test('existing privacy restriction makes reviewed document text inaccessible', async () => {
        psql(container, `insert into app.role_permissions(organization_id,role_id,permission_key) select organization_id,role_id,'privacy.manage' from app.organization_memberships where organization_id='${ORG_B}' and user_id='${user}' on conflict do nothing`);
        const requestId = randomUUID(), subjectId = randomUUID();
        const version = Number(psql(container, `select version from app.candidates where id='${candidate}'`).trim());
        await createPrivacyRequest(pool, owner, ORG_B, { requestId, kind: 'restriction', receivedAt: new Date(Date.now() - 1000).toISOString() });
        await reviewPrivacySubject(pool, owner, ORG_B, { requestId, expectedRequestVersion: 1, subjectId, candidateId: candidate, expectedTargetVersion: version });
        await verifyPrivacyRequest(pool, owner, ORG_B, { requestId, expectedRequestVersion: 2, verificationMethod: 'synthetic-staff-review' });
        await restrictPrivacySubject(pool, owner, ORG_B, { requestId, expectedRequestVersion: 3, subjectId, expectedTargetVersion: version });
        await assert.rejects(staff('select app.cv_reviewed_text_v1($1) result', [candidate]), { code: 'P0002' });
        assert.equal((await status({ analysisId: parsed.jobId })).textAvailable, false);
    });
    await t.test('scheduled private cleanup has a global twenty-analysis bound without Telegram', async () => {
        psql(container, `insert into app.cv_analyses(organization_id,owner_user_id,draft_id,document_revision,document_sha256,size_bytes,filename,extension,object_key,status,blocks,text_sha256,text_byte_length,block_count,cleanup_due_at)
        select '${ORG_B}','${user}','${first.id}',100+i,'${hash(bytes)}',${bytes.length},'Synthetic.pdf','pdf','synthetic-unused','cancelled','[{"ordinal":0,"kind":"pdf_page","page":1,"text":"private retained context","sha256":"${hash('private retained context')}"}]','${hash('private retained context')}',24,1,now() from generate_series(1,21) i;
        insert into app.telegram_maintenance_owners values('${ORG_B}','${user}',now()) on conflict(organization_id,owner_user_id) do update set due_at=now();`);
        const firstRun = await maintain(); assert.equal(firstRun.analysesPurged, 20); assert.equal(firstRun.remainingWork, true);
        assert(Number(psql(container, `select count(*) from app.cv_analyses where draft_id='${first.id}' and document_revision>100 and blocks is not null`).trim()) > 0);
        for (let i = 0; i < 3; i++) await maintain();
        assert.equal(psql(container, `select count(*) from app.cv_analyses where draft_id='${first.id}' and document_revision>100 and blocks is not null`).trim(), '0');
    });

});
