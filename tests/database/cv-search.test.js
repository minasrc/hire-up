import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import { POSTGRES_17_IMAGE, assertLocalTestEnvironment, psql, publishedPort, startPostgresContainer, stopAndRemoveContainer } from '../support/foundation-docker.js';
import { AUTHZ_ID, installStaffFixture, staffPoolOptions } from '../support/staff-authorization.js';
import { CJ_SUBJECTS, clientJobFixtureSql } from '../support/client-job-workflows.js';
import { withStaffTransaction } from '../../src/lib/staff-authorization.js';
import { mergeCandidateDuplicates } from '../../src/lib/duplicate-review-operations.js';
import { profileSearchAction, profileSearchStatus, profileSearchWorkerOperation } from '../../src/lib/profile-search-operations.js';
const dir = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
const migrations = readdirSync(dir).filter(f => f >= '20260922090000_foundation_roles.sql' && f <= '20261002210000_cv_search.sql' && f.endsWith('.sql')).sort();
const sha = x => createHash('sha256').update(x).digest('hex');
const vector = n => Array.from({ length: 384 }, (_, i) => i === n ? 1 : 0);
test('approved CV search preserves profile parity, document access and cached safety', async t => {
    assertLocalTestEnvironment(); const db = await startPostgresContainer('pgcvsearch', POSTGRES_17_IMAGE, { publish: true }); let pool, workerPool, adminPool;
    t.after(async () => { await Promise.all([pool?.end(), workerPool?.end(), adminPool?.end()]); await stopAndRemoveContainer(db); });
    for (const f of migrations) {
        if (f === '20261002210000_cv_search.sql') {
            psql(db, 'create role cv_search_migration_operator login inherit nosuperuser createrole bypassrls;grant app_owner,app_executor to cv_search_migration_operator;');
            psql(db, `set session authorization cv_search_migration_operator;${readFileSync(join(dir, f), 'utf8')}reset session authorization;`);
        } else psql(db, readFileSync(join(dir, f), 'utf8'));
    }
    const password = installStaffFixture(db); psql(db, clientJobFixtureSql); const org = AUTHZ_ID.ORG_B;
    pool = new pg.Pool(staffPoolOptions(db, password, 4)); const wp = randomUUID();
    psql(db, `create role cv_search_test login noinherit password '${wp}';grant app_telegram_worker to cv_search_test;`);
    workerPool = new pg.Pool({ ...staffPoolOptions(db, wp, 3), user: 'cv_search_test' });
    const ap = randomUUID(); psql(db, `create role cv_search_admin login superuser password '${ap}'`);
    adminPool = new pg.Pool({ host: '127.0.0.1', port: publishedPort(db, 5432), database: 'postgres', user: 'cv_search_admin', password: ap, max: 2 });
    const identity = { provider: 'google', issuer: 'https://accounts.google.com', subject: CJ_SUBJECTS.ADMIN };
    const staff = (sql, args = []) => withStaffTransaction(pool, identity, org, ['candidates.read', 'candidates.write'], async ({ client }) => (await client.query(sql, args)).rows[0]?.result);
    const actor = await staff("select app.context_uuid_v1('app.actor_id') result");
    const token = randomBytes(48).toString('base64url'); await staff('select app.telegram_register_worker_v1($1,$2) result', ['CV search', token]);
    const call = (action, body = {}) => profileSearchWorkerOperation(workerPool, token, action, body);
    const finish = j => {
        const body = { jobId: j.id, leaseToken: j.leaseToken, kind: j.kind, indexVersion: j.indexVersion, projectionVersion: j.projectionVersion, chunkerVersion: j.chunkerVersion };
        if (j.kind === 'query') return call('complete', { ...body, querySha256: j.querySha256, result: { embedding: vector(1) } });
        Object.assign(body, { sourceRevision: j.source.revision, sourceSha256: j.source.sha256 });
        if (j.kind === 'plan') return call('complete', { ...body, result: { byteLength: Buffer.byteLength(j.source.text), chunks: [{ ordinal: 0, startByte: 0, endByte: Buffer.byteLength(j.source.text), sha256: sha(j.source.text), tokenCount: 100 }] } });
        return call('complete', { ...body, manifestSha256: j.manifestSha256, result: { embeddings: j.chunks.map(c => ({ ordinal: c.ordinal, embedding: vector(j.source.component === 'cv' ? 1 : 0) })) } });
    };
    const drain = async cv => { for (let i = 0; i < 80; i++) { const { job } = await call('claim', cv ? { capabilities: ['minilm-v1', 'approved-cv-v1'] } : { capabilities: ['minilm-v1'] }); if (!job) return; if (!cv) assert.notEqual(job.source?.component, 'cv'); await finish(job); } throw new Error('queue did not drain'); };
    const query = async includeCv => {
        const q = await profileSearchAction(pool, identity, org, { action: 'search', operationId: randomUUID(), query: 'uncommon specialist', scope: 'approved', readyOnly: false, includeCv });
        const { job } = await call('claim', { capabilities: ['minilm-v1'] }); assert.equal(job.kind, 'query'); await finish(job); return profileSearchStatus(pool, identity, org, { queryId: q.queryId });
    };
    const seed = text => {
        const id = randomUUID(), document = randomUUID(), blob = randomUUID(), artifact = randomUUID();
        psql(db, `insert into app.candidates(id,organization_id,full_name,identity_state,lifecycle) values('${id}','${org}','Synthetic Candidate','established','active');
        insert into app.file_blobs(id,organization_id,candidate_id,sha256,size_bytes,mime_type,extension,lifecycle,scan_state) values('${blob}','${org}','${id}',decode('${sha(id)}','hex'),1024,'application/pdf','pdf','live','unscanned');
        insert into app.documents(id,organization_id,candidate_id,blob_id,purpose,original_filename,received_at,lifecycle) values('${document}','${org}','${id}','${blob}','cv','Synthetic CV.pdf',now(),'active');
        update app.candidates set current_document_id='${document}' where id='${id}';
        insert into app.candidate_reviewed_cv_text(id,organization_id,candidate_id,document_id,document_sha256,parser_version,text_sha256,blocks,text_content,reviewed_by) values('${artifact}','${org}','${id}','${document}','${sha(id)}','synthetic-parser','${sha(text)}','[]', '${text.replaceAll("'", "''")}','${actor}');`);
        return { id, document, artifact };
    };
    let candidate, profile, mixed;
    await t.test('old worker skips CV; exact retained text adds one grouped hit without changing profile rankings', async () => {
        assert.equal((await call('claim')).job, null);assert.equal((await profileSearchStatus(pool, identity, org)).workerAvailable, false);
        candidate = seed('Full original retained CV. Unique ending specialist.'); await drain(false); profile = await query(false);
        const initial = await profileSearchStatus(pool, identity, org, { includeCv: true }); assert.equal(initial.coverage.cv.pending, 1);
        await drain(true); mixed = await query(true); assert.equal(mixed.status, 'completed'); assert.equal(mixed.results.filter(r => r.sourceId === candidate.id).length, 1);
        assert.equal(mixed.results[0].matchedComponent, 'cv'); assert.equal(mixed.results[0].matchedDocument.id, candidate.document); assert(mixed.results[0].matchedText.endsWith('Unique ending specialist.'));
        assert.deepEqual((await query(false)).results, profile.results); assert.equal((await profileSearchStatus(pool, identity, org)).coverage.cv, null);
    });
    await t.test('benign new CV publication warns without invalidating existing cached ranking', async () => {
        seed('Newly approved CV specialist'); await drain(true); const current = await profileSearchStatus(pool, identity, org, { queryId: mixed.queryId });
        assert.equal(current.status, 'completed'); assert.deepEqual(current.results, mixed.results); assert.equal(current.coverage.corpusChanged, true);
    });
    await t.test('document permission revocation fences cached CV scores but leaves profile mode intact', async () => {
        const baseline = await query(false);
        const role = psql(db, `select role_id from app.organization_memberships where organization_id='${org}' and user_id='${actor}'`).trim();
        psql(db, `delete from app.role_permissions where organization_id='${org}' and role_id='${role}' and permission_key='documents.download'`);
        try {
            const r = await profileSearchStatus(pool, identity, org, { queryId: mixed.queryId }); assert.equal(r.errorCode, 'CV_ACCESS_CHANGED'); assert.deepEqual(r.results, []); assert.equal(r.nextAfter, null); assert.equal(r.coverage.cv, null);
            await assert.rejects(profileSearchStatus(pool, identity, org, { includeCv: true }), { code: '42501' });
            assert.deepEqual((await query(false)).results, baseline.results);
        } finally { psql(db, `insert into app.role_permissions values('${org}','${role}','documents.download')`); }
    });
    await t.test('current document removal invalidates old score and retires exact CV vectors', async () => {
        const before = await query(true); psql(db, `update app.documents set lifecycle='restricted' where id='${candidate.document}'`);
        const after = await profileSearchStatus(pool, identity, org, { queryId: before.queryId }); assert.equal(after.errorCode, 'CV_RESULTS_CHANGED'); assert.deepEqual(after.results, []);
        assert.equal(psql(db, `select count(*) from app.profile_search_chunks c join app.profile_search_sources s on s.id=c.source_id where s.source_id='${candidate.id}' and s.component='cv'`).trim(), '0');
    });
    await t.test('new SQL entrypoints are explicitly granted and CV stage replay rechecks document permission', async () => {
        assert.equal(psql(db, `select count(*) from pg_proc p where pronamespace='app'::regnamespace and proname like 'cv_search_%' and exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE')`).trim(), '0');
        assert.equal(psql(db, "select has_function_privilege('app_telegram_worker','app.cv_search_status_v1(text,boolean,uuid,jsonb,boolean)','EXECUTE')").trim(), 'f');
        seed('Permission fenced staged CV'); await drain(false); const j = (await call('claim', { capabilities: ['minilm-v1', 'approved-cv-v1'] })).job; assert.equal(j.source.component, 'cv');
        const role = psql(db, `select role_id from app.organization_memberships where organization_id='${org}' and user_id='${actor}'`).trim();
        psql(db, `delete from app.role_permissions where organization_id='${org}' and role_id='${role}' and permission_key='documents.download'`);
        try { await assert.rejects(finish(j), { code: '42501' }); assert.equal((await call('claim', { capabilities: ['minilm-v1', 'approved-cv-v1'] })).job, null); }
        finally { psql(db, `insert into app.role_permissions values('${org}','${role}','documents.download')`); }
        await finish(j); await finish(j);
        const embed = (await call('claim', { capabilities: ['minilm-v1', 'approved-cv-v1'] })).job;
        assert.equal(embed.kind, 'embed'); assert.equal(embed.chunkerVersion, 'minilm-cv-lines-128-v1');
        await assert.rejects(call('complete', { jobId: embed.id, leaseToken: embed.leaseToken, kind: 'embed', indexVersion: embed.indexVersion, projectionVersion: 'candidate-profile-v1', chunkerVersion: 'minilm-utf8-128-v1', sourceRevision: embed.source.revision, sourceSha256: embed.source.sha256, manifestSha256: embed.manifestSha256, result: { embeddings: embed.chunks.map(c => ({ ordinal: c.ordinal, embedding: vector(1) })) } }), { code: '40001' });
        await finish(embed); await drain(true);
    });
    await t.test('a full 256-chunk CV manifest and eight-vector batches are atomic and replayable', async () => {
        await drain(true); const text = 'Exact reviewed CV paragraph. '.padEnd(128, 'x').repeat(256); const item = seed(text); await drain(false);
        const plan = (await call('claim', { capabilities: ['minilm-v1', 'approved-cv-v1'] })).job;
        assert.equal(plan.source.component, 'cv');
        const chunks = Array.from({ length: 256 }, (_, ordinal) => ({ ordinal, startByte: ordinal * 128, endByte: (ordinal + 1) * 128, sha256: sha(text.slice(ordinal * 128, (ordinal + 1) * 128)), tokenCount: 100 }));
        const body = { jobId: plan.id, leaseToken: plan.leaseToken, kind: 'plan', indexVersion: plan.indexVersion, projectionVersion: plan.projectionVersion, chunkerVersion: plan.chunkerVersion, sourceRevision: plan.source.revision, sourceSha256: plan.source.sha256, result: { byteLength: Buffer.byteLength(text), chunks } };
        await assert.rejects(call('complete', { ...body, result: { ...body.result, chunks: chunks.map((c, i) => i === 255 ? { ...c, sha256: 'a'.repeat(64) } : c) } }));
        assert.equal(psql(db, `select count(*) from app.profile_search_chunks where source_id='${plan.id}'`).trim(), '0');
        const accepted = await call('complete', body); assert.deepEqual(await call('complete', body), accepted);
        assert.equal(psql(db, `select count(*) from app.profile_search_chunks where source_id='${plan.id}'`).trim(), '256');
        const embed = (await call('claim', { capabilities: ['minilm-v1', 'approved-cv-v1'] })).job;
        assert.equal(embed.chunks.length, 8); await finish(embed); await finish(embed);
        assert.equal(psql(db, `select count(*) from app.profile_search_chunks where source_id='${plan.id}' and embedding is not null`).trim(), '8');
        await drain(true);
        assert.equal(psql(db, `select count(*) from app.profile_search_chunks where source_id='${plan.id}' and embedding is not null`).trim(), '256');
        assert.equal(psql(db, `select status from app.profile_search_sources where source_id='${item.id}' and component='cv'`).trim(), 'ready');
    });
    await t.test('infected CVs invalidate results and late embed acknowledgements are definitive conflicts', async () => {
        const item = seed('Infection safety fixture'); await drain(false);
        let j = (await call('claim', { capabilities: ['minilm-v1', 'approved-cv-v1'] })).job; await finish(j);
        j = (await call('claim', { capabilities: ['minilm-v1', 'approved-cv-v1'] })).job; assert.equal(j.kind, 'embed');
        psql(db, `update app.file_blobs set scan_state='infected' where id=(select blob_id from app.documents where id='${item.document}')`);
        await assert.rejects(finish(j), { code: '40001' });
        psql(db, `update app.file_blobs set scan_state='unscanned' where id=(select blob_id from app.documents where id='${item.document}')`);
        await drain(true); const q = await query(true);
        psql(db, `update app.file_blobs set scan_state='infected' where id=(select blob_id from app.documents where id='${item.document}')`);
        assert.equal((await profileSearchStatus(pool, identity, org, { queryId: q.queryId })).errorCode, 'CV_RESULTS_CHANGED');
    });
    await t.test('requested expired query is hidden beyond the bounded background expiry prefix', async () => {
        const q = await query(false);
        psql(db, `insert into app.profile_search_queries(organization_id,owner_user_id,operation_id,request_digest,query_text,query_sha256,scope,ready_only,status,expires_at)
        select '${org}','${actor}',gen_random_uuid(),sha256(i::text::bytea),'synthetic expired','${'a'.repeat(64)}','approved',false,'completed',now()-interval '2 hours' from generate_series(1,110)i;
        update app.profile_search_queries set expires_at=now()-interval '1 hour' where id='${q.queryId}'`);
        const r = await profileSearchStatus(pool, identity, org, { queryId: q.queryId }); assert.equal(r.status, 'expired'); assert.equal(r.query, null); assert.deepEqual(r.results, []);
    });
    await t.test('capacity is explicit and its cached CV counts are fenced after removal', async () => {
        psql(db, 'create or replace function app.cv_search_limit_v1() returns integer language sql immutable as $$ select 1 $$;');
        const q = await query(true); assert.equal(q.status, 'failed'); assert.equal(q.errorCode, 'SEARCH_CAPACITY'); assert.deepEqual(q.results, []);
        const doc = psql(db, `select document_id from app.profile_search_sources where component='cv' and status='ready' limit 1`).trim();
        psql(db, `update app.documents set lifecycle='restricted' where id='${doc}'`);
        const stale = await profileSearchStatus(pool, identity, org, { queryId: q.queryId }); assert.equal(stale.errorCode, 'CV_RESULTS_CHANGED'); assert.equal(stale.capacity, null);
        psql(db, 'create or replace function app.cv_search_limit_v1() returns integer language sql immutable as $$ select 100000 $$;');
    });
    await t.test('index retry locking cannot deadlock a concurrent document restriction', async () => {
        const item = seed('Concurrent failure fixture'); await drain(false); const j = (await call('claim', { capabilities: ['minilm-v1', 'approved-cv-v1'] })).job;
        const a = await adminPool.connect(), b = await adminPool.connect();
        try {
            await a.query("begin;set local role app_executor;set local statement_timeout='5s'");
            await a.query("select set_config('app.organization_id',$1,true),set_config('app.actor_id',$2,true)", [org, actor]);
            await a.query('select app.profile_search_lock_v1()'); await a.query('select id from app.profile_search_sources where id=$1 for update', [j.id]);
            const restricted = b.query("update app.documents set lifecycle='restricted' where id=$1", [item.document]);
            await new Promise(resolve => setTimeout(resolve, 30));
            await a.query('select app.profile_search_worker_fail_v1($1,$2::jsonb)', [token, JSON.stringify({ jobId: j.id, leaseToken: j.leaseToken, kind: j.kind, code: 'WORKER_ERROR', retryAfterSeconds: 1 })]);
            await a.query('commit'); await restricted;
            assert.equal(psql(db, `select status from app.profile_search_sources where id='${j.id}'`).trim(), 'retired');
        } finally { await a.query('rollback'); a.release(); b.release(); }
    });
    await t.test('actual merge preserves only the reviewed text of an adopted current CV', async () => {
        psql(db, `insert into app.role_permissions select organization_id,role_id,p from app.organization_memberships cross join unnest(array['duplicates.review','candidates.merge'])p where organization_id='${org}' and user_id='${actor}' on conflict do nothing`);
        for (const keepTarget of [false, true]) {
            const source = seed('Exact source reviewed text'); const target = keepTarget ? seed('Target retained reviewed text') : { id: randomUUID() };
            if (!keepTarget) psql(db, `insert into app.candidates(id,organization_id,full_name,identity_state,lifecycle) values('${target.id}','${org}','Target','established','active')`);
            const pair = [source.id, target.id].sort(), reviewId = randomUUID();
            psql(db, `insert into app.candidate_duplicate_reviews(id,organization_id,candidate_a_id,candidate_b_id) values('${reviewId}','${org}','${pair[0]}','${pair[1]}')`);
            const request = { reviewId, expectedVersion: 1, targetCandidateId: target.id, expectedTargetVersion: Number(psql(db, `select version from app.candidates where id='${target.id}'`).trim()), expectedSourceVersion: Number(psql(db, `select version from app.candidates where id='${source.id}'`).trim()), primaryEmail: null };
            await mergeCandidateDuplicates(pool, identity, org, request); await mergeCandidateDuplicates(pool, identity, org, request);
            assert.equal(psql(db, `select candidate_id from app.candidate_reviewed_cv_text where id='${source.artifact}'`).trim(), keepTarget ? source.id : target.id);
            assert.equal(psql(db, `select current_document_id from app.candidates where id='${target.id}'`).trim(), keepTarget ? target.document : source.document);
            await drain(true); const r = await query(true); assert(!r.results.some(row => row.sourceId === source.id)); assert.equal(r.results.filter(row => row.sourceId === target.id).length, 1);
        }
    });

});

test('model namespace migration retires every old vector and receipt before compatible workers resume', async t => {
    assertLocalTestEnvironment(); const db = await startPostgresContainer('pgcvmodelreset', POSTGRES_17_IMAGE, { publish: false });
    t.after(() => stopAndRemoveContainer(db));
    for (const f of migrations.filter(f => f < '20261002210000_cv_search.sql')) psql(db, readFileSync(join(dir, f), 'utf8'));
    installStaffFixture(db); psql(db, clientJobFixtureSql);
    const org = AUTHZ_ID.ORG_B, candidate = randomUUID(), source = randomUUID(), query = randomUUID();
    const actor = psql(db, `select user_id from app.organization_memberships where organization_id='${org}' order by user_id limit 1`).trim();
    psql(db, `insert into app.candidates(id,organization_id,full_name,identity_state,lifecycle) values('${candidate}','${org}','Preserved model fixture','established','active');
      delete from app.profile_search_sources where source_id='${candidate}';
      insert into app.profile_search_sources(id,organization_id,source_type,source_id,revision,status,projection_text,source_sha256,manifest_sha256,receipt_token,receipt_digest,receipt)
      values('${source}','${org}','candidate','${candidate}',7,'ready','Old derived E5 text','${'a'.repeat(64)}','${'b'.repeat(64)}',gen_random_uuid(),decode('aa','hex'),'{"old":true}');
      insert into app.profile_search_chunks(source_id,ordinal,organization_id,revision,start_byte,end_byte,sha256,token_count,embedding)
      values('${source}',0,'${org}',7,0,19,'${'a'.repeat(64)}',448,array_fill(0::real,array[384]));
      insert into app.profile_search_queries(id,organization_id,owner_user_id,operation_id,request_digest,query_text,query_sha256,scope,ready_only,status,embedding,receipt_digest,receipt)
      values('${query}','${org}','${actor}',gen_random_uuid(),decode('bb','hex'),'Retained rerun query','${'c'.repeat(64)}','approved',false,'completed',array_fill(0::real,array[384]),decode('cc','hex'),'{"old":true}');
      insert into app.profile_search_results(query_id,source_id,organization_id,owner_user_id,source_revision,score,ordinal,source_type,public_source_id)
      values('${query}','${source}','${org}','${actor}',7,0.5,0,'candidate','${candidate}');`);
    psql(db, readFileSync(join(dir, '20261002210000_cv_search.sql'), 'utf8'));
    const state = JSON.parse(psql(db, `select json_build_object('chunks',(select count(*) from app.profile_search_chunks),'ranks',(select count(*) from app.profile_search_results),'query',(select json_build_object('status',status,'error',error_code,'text',query_text,'embedding',embedding,'receipt',receipt) from app.profile_search_queries where id='${query}'),'source',(select json_build_object('revision',revision,'status',status,'text',projection_text,'manifest',manifest_sha256,'receipt',receipt) from app.profile_search_sources where id='${source}'),'candidate',(select full_name from app.candidates where id='${candidate}'),'versions',app.profile_search_versions_v1())`).trim());
    assert.equal(state.chunks, 0); assert.equal(state.ranks, 0);
    assert.deepEqual(state.query, { status: 'failed', error: 'INDEX_CHANGED', text: 'Retained rerun query', embedding: null, receipt: null });
    assert.deepEqual(state.source, { revision: 8, status: 'queued', text: null, manifest: null, receipt: null });
    assert.equal(state.candidate, 'Preserved model fixture'); assert.equal(state.versions.chunkerVersion, 'minilm-utf8-128-v1');
    assert.match(state.versions.indexVersion, /paraphrase-multilingual-MiniLM-L12-v2@e8f8c211/);
});
