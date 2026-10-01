import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import { POSTGRES_17_IMAGE, assertLocalTestEnvironment, psql, publishedPort, startPostgresContainer, stopAndRemoveContainer } from '../support/foundation-docker.js';
import { AUTHZ_ID, installStaffFixture, staffPoolOptions } from '../support/staff-authorization.js';
import { CJ_ID, CJ_SUBJECTS, clientJobFixtureSql } from '../support/client-job-workflows.js';
import { withStaffTransaction } from '../../src/lib/staff-authorization.js';
import { createTelegramDraft, updateTelegramDraft, decideTelegramDraft } from '../../src/lib/telegram-intake-operations.js';
import { profileSearchAction, profileSearchStatus, profileSearchWorkerOperation } from '../../src/lib/profile-search-operations.js';
const dir = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
const migrations = readdirSync(dir).filter(f => f >= '20260922090000_foundation_roles.sql' && f <= '20261002210000_cv_search.sql' && f.endsWith('.sql')).sort();
const identity = subject => ({ provider: 'google', issuer: 'https://accounts.google.com', subject });
const sha = s => createHash('sha256').update(s).digest('hex');
const vector = Array.from({ length: 384 }, (_, i) => i === 0 ? 1 : 0);

test('profile search current authorization, complete chunks and durable query ranking', async t => {
    assertLocalTestEnvironment(); const db = await startPostgresContainer('pgprofilesearch', POSTGRES_17_IMAGE, { publish: true });
    let pool; let workerPool; let admin; t.after(async () => { await Promise.all([pool?.end(), workerPool?.end(), admin?.end()]); await stopAndRemoveContainer(db); });
    for (const f of migrations) psql(db, readFileSync(join(dir, f), 'utf8'));
    const password = installStaffFixture(db); psql(db, clientJobFixtureSql); const { ORG_B } = AUTHZ_ID;
    psql(db, `insert into app.role_permissions(organization_id,role_id,permission_key) values('${ORG_B}','${CJ_ID.ROLE_B_RECRUITER}','candidates.write');`);
    pool = new pg.Pool(staffPoolOptions(db, password, 4));
    const wp = randomUUID(); psql(db, `create role search_test login noinherit nosuperuser nocreatedb nocreaterole nobypassrls password '${wp}'; grant app_telegram_worker to search_test;`);
    workerPool = new pg.Pool({ ...staffPoolOptions(db, wp, 3), user: 'search_test' });
    const ap = randomUUID(); psql(db, `create role search_fixture_admin login superuser password '${ap}'`);
    admin = new pg.Pool({ host: '127.0.0.1', port: publishedPort(db, 5432), database: 'postgres', user: 'search_fixture_admin', password: ap, max: 3 });
    const owner = identity(CJ_SUBJECTS.ADMIN); const other = identity(CJ_SUBJECTS.RECRUITER);
    const staff = (who, sql, args = []) => withStaffTransaction(pool, who, ORG_B, ['candidates.read', 'candidates.write'], async ({ client }) => (await client.query(sql, args)).rows[0]?.result);
    const token = randomBytes(48).toString('base64url'); await staff(owner, 'select app.telegram_register_worker_v1($1,$2) as result', ['Semantic worker', token]);
    const call = (a, b = {}) => profileSearchWorkerOperation(workerPool, token, a, a === 'claim' ? { capabilities: ['minilm-v1'] } : b);
    const complete = j => ({ jobId: j.id, leaseToken: j.leaseToken, kind: j.kind, indexVersion: j.indexVersion, projectionVersion: j.projectionVersion, chunkerVersion: j.chunkerVersion });
    const plan = j => {
        const b = Buffer.from(j.source.text); const text = j.source.text; const midpoint = Math.floor([...text].length / 2); const split = Buffer.byteLength([...text].slice(0, midpoint).join(''));
        const ranges = b.length > 400 ? [[0, split], [split, b.length]] : [[0, b.length]];
        return { byteLength: b.length, chunks: ranges.map(([startByte, endByte], ordinal) => ({ ordinal, startByte, endByte, sha256: sha(b.subarray(startByte, endByte)), tokenCount: 100 })) };
    };
    const finish = async j => {
        if (j.kind === 'plan') return call('complete', { ...complete(j), sourceRevision: j.source.revision, sourceSha256: j.source.sha256, result: plan(j) });
        if (j.kind === 'embed') return call('complete', { ...complete(j), sourceRevision: j.source.revision, sourceSha256: j.source.sha256, manifestSha256: j.manifestSha256, result: { embeddings: j.chunks.map(c => ({ ordinal: c.ordinal, embedding: vector })) } });
        return call('complete', { ...complete(j), querySha256: j.querySha256, result: { embedding: vector } });
    };
    const drain = async () => { for (let n = 0; n < 400; n++) { const { job } = await call('claim'); if (!job) return; await finish(job); } throw new Error('queue did not drain'); };
    const query = async (scope = 'all', readyOnly = false) => {
        const q = await profileSearchAction(pool, owner, ORG_B, { action: 'search', operationId: randomUUID(), query: 'engineer distributed systems', scope, readyOnly });
        const { job } = await call('claim'); assert.equal(job.kind, 'query'); const result = await finish(job); assert.equal(result.status, 'completed');
        assert.deepEqual(await finish(job), result, 'lost query acknowledgement replays'); return profileSearchStatus(pool, owner, ORG_B, { queryId: q.queryId });
    };
    let draft; let firstQuery;
    await t.test('workers are owner-scoped, long UTF-8 fields retain their tail, private drafts do not leak', async () => {
        assert.equal((await profileSearchStatus(pool, owner, ORG_B)).workerAvailable, false);
        draft = await createTelegramDraft(pool, owner, ORG_B, { sourceTitle: 'Private source should not be indexed', fields: { firstName: 'Owner', lastName: 'Engineer', professionalSummary: '分散型システム '.repeat(200) + 'Unique ending searchable' } });
        await createTelegramDraft(pool, other, ORG_B, { sourceTitle: 'Other private source', fields: { firstName: 'Other', lastName: 'Private' } });
        await drain(); assert.equal((await profileSearchStatus(pool, owner, ORG_B)).workerAvailable, true); assert.equal((await profileSearchStatus(pool, other, ORG_B)).workerAvailable, false);
        firstQuery = await query(); const own = firstQuery.results.find(r => r.sourceId === draft.id); assert(own); assert(!firstQuery.results.some(r => r.displayName === 'Other Private'));
        const text = psql(db, `select projection_text from app.profile_search_sources where source_id='${draft.id}'`).trim(); assert(text.endsWith('Unique ending searchable')); assert(!text.includes('Private source should'));
        await assert.rejects(profileSearchStatus(pool, other, ORG_B, { queryId: firstQuery.queryId }));
        assert.equal((await query('my_drafts', true)).results.length, 0);
    });
    await t.test('stale results disappear on edits; pending queries have priority over indexing', async () => {
        draft = await updateTelegramDraft(pool, owner, ORG_B, draft.id, { expectedVersion: draft.version, fields: { headline: 'New human headline' } });
        const stale = await profileSearchStatus(pool, owner, ORG_B, { queryId: firstQuery.queryId }); assert(!stale.results.some(r => r.sourceId === draft.id)); assert.equal(stale.coverage.corpusChanged, true);
        const q = await query('my_drafts'); assert.equal(q.results.length, 0); assert.equal(q.coverage.pending, 1);
        let j = (await call('claim')).job; assert.equal(j.kind, 'plan');
        draft = await updateTelegramDraft(pool, owner, ORG_B, draft.id, { expectedVersion: draft.version, fields: { location: 'Remote' } });
        await assert.rejects(finish(j), { code: '40001' }); await drain(); assert.equal((await query('my_drafts')).results.length, 1);
    });
    await t.test('canonical source invalidation works without actor context; full ranking paginates exactly25', async () => {
        const candidates = Array.from({ length: 52 }, () => randomUUID());
        psql(db, `insert into app.candidates(id,organization_id,full_name,professional_summary,identity_state,lifecycle) values ${candidates.map((id, i) => `('${id}','${ORG_B}','Engineer ${i}','Systems and databases','established','active')`).join(',')}`);
        await drain(); const response = await query('approved'); assert.equal(response.results.length, 25); assert(response.nextAfter);
        const all = [...response.results]; let cursor = response.nextAfter;
        while (cursor) { const page = await profileSearchStatus(pool, owner, ORG_B, { queryId: response.queryId, after: cursor }); all.push(...page.results); cursor = page.nextAfter; }
        assert.equal(new Set(all.map(r => r.sourceId)).size, all.length); assert(all.length >= 52);
        psql(db, `update app.candidates set lifecycle='restricted' where id='${candidates[0]}'`);
        const fresh = await profileSearchStatus(pool, owner, ORG_B, { queryId: response.queryId }); assert(!fresh.results.some(r => r.sourceId === candidates[0])); assert.equal(psql(db, `select count(*) from app.profile_search_chunks ch join app.profile_search_sources s on s.id=ch.source_id where s.source_id='${candidates[0]}'`).trim(), '0');
        const id = candidates[1]; const before = Number(psql(db, `select revision from app.profile_search_sources where source_id='${id}'`).trim());
        psql(db, `update app.candidates set compensation_preference='150000 EUR' where id='${id}'`); assert(Number(psql(db, `select revision from app.profile_search_sources where source_id='${id}'`).trim()) > before);
    });
    await t.test('canonical identifiers, merge retirement and draft decisions preserve lifecycle invariants', async () => {
        const id = randomUUID(); const target = randomUUID();
        psql(db, `insert into app.candidates(id,organization_id,full_name,identity_state,lifecycle) values('${id}','${ORG_B}','Merge Source','established','active'),('${target}','${ORG_B}','Merge Target','established','active');`);
        await drain();
        const identifier = randomUUID();
        psql(db, `insert into app.candidate_identifiers(id,organization_id,candidate_id,kind,raw_value,normalized_value,normalization_version,verification,received_at) values('${identifier}','${ORG_B}','${id}','provider_subject','telegram:user:123','telegram:user:123',1,'unverified',now())`);
        assert.equal(psql(db, `select status from app.profile_search_sources where source_id='${id}'`).trim(), 'queued'); await drain();
        assert(psql(db, `select projection_text from app.profile_search_sources where source_id='${id}'`).includes('telegram:user:123'));
        // Reproduce the exact protected row/identifier mutations used by merge;
        // both identities remain owned by the same organization.
        psql(db, `begin; update app.candidate_identifiers set candidate_id='${target}' where id='${identifier}'; update app.candidates set lifecycle='merged',merged_into_id='${target}' where id='${id}'; commit;`);
        assert.equal(psql(db, `select status from app.profile_search_sources where source_id='${id}'`).trim(), 'retired');
        assert.equal(psql(db, `select projection_text is null from app.profile_search_sources where source_id='${id}'`).trim(), 't');
        psql(db, `update app.candidates set lifecycle='restricted' where id='${target}'; update app.candidate_identifiers set raw_value='updated raw value' where id='${identifier}';`);
        assert.equal(psql(db, `select status from app.profile_search_sources where source_id='${target}'`).trim(), 'retired', 'identifier writes cannot resurrect restricted candidates');
        psql(db, `update app.telegram_drafts set status='discarded',fields='{}',document=null where id='${draft.id}'`);
        assert.equal(psql(db, `select status from app.profile_search_sources where source_id='${draft.id}'`).trim(), 'retired'); assert.equal((await query('my_drafts')).results.length, 0);
    });
    await t.test('concurrent identifier updates cannot resurrect a newly restricted canonical profile', async () => {
        const id = randomUUID(); const identifier = randomUUID();
        psql(db, `insert into app.candidates(id,organization_id,full_name,identity_state,lifecycle) values('${id}','${ORG_B}','Concurrent Restriction','established','active'); insert into app.candidate_identifiers(id,organization_id,candidate_id,kind,raw_value,normalized_value,normalization_version,verification,received_at) values('${identifier}','${ORG_B}','${id}','email','race@example.invalid','race@example.invalid',1,'unverified',now());`);
        await drain(); const a = await admin.connect(); const b = await admin.connect();
        try {
            await a.query('begin'); await a.query("update app.candidates set lifecycle='restricted' where id=$1", [id]);
            const writing = b.query("update app.candidate_identifiers set raw_value='race updated' where id=$1", [identifier]);
            let blocked = false;
            for (let i = 0; i < 100 && !blocked; i++) {
                const state = await admin.query("select exists(select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock') blocked", [b.processID]); blocked = state.rows[0].blocked;
                if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
            }
            assert(blocked, 'identifier mutation reaches a real database lock boundary'); await a.query('commit'); await writing;
            assert.equal(psql(db, `select status from app.profile_search_sources where source_id='${id}'`).trim(), 'retired');
            assert.equal(psql(db, `select projection_text is null from app.profile_search_sources where source_id='${id}'`).trim(), 't');
        } finally { await a.query('rollback').catch(() => {}); a.release(); b.release(); }
    });
    await t.test('approval atomically retires private vectors and indexes only reviewed canonical fields', async () => {
        let d = await createTelegramDraft(pool, owner, ORG_B, { fields: { firstName: 'Reviewed', lastName: 'Person', primaryEmail: 'reviewed@example.invalid', telegramUsername: 'abc', professionalSummary: 'Reviewed profile only' }, sourceTitle: 'Private conversation metadata excluded' });
        const target = await staff(owner, 'select app.telegram_cv_target_v1($1) as result', [d.id]);
        const document = { filename: 'Synthetic CV.pdf', sha256: 'a'.repeat(64), sizeBytes: 500, extension: 'pdf', mimeType: 'application/pdf', objectKey: `staff/${ORG_B}/${target}/${randomUUID()}.pdf` };
        await staff(owner, 'select app.telegram_reserve_upload_v1($1,$2,$3) as result', [d.id, d.version, document.objectKey]);
        d = await staff(owner, 'select app.telegram_attach_cv_v1($1,$2,$3::jsonb) as result', [d.id, d.version, JSON.stringify(document)]);
        await drain(); assert((await query('my_drafts', true)).results.some(r => r.sourceId === d.id));
        const approved = await decideTelegramDraft(pool, owner, ORG_B, d.id, { expectedVersion: d.version, action: 'approve', operationId: randomUUID() });
        assert.equal(psql(db, `select status from app.profile_search_sources where source_id='${d.id}'`).trim(), 'retired');
        assert.equal(psql(db, `select count(*) from app.profile_search_chunks ch join app.profile_search_sources s on s.id=ch.source_id where s.source_id='${d.id}'`).trim(), '0');
        assert.equal(psql(db, `select status from app.profile_search_sources where source_id='${approved.candidateId}'`).trim(), 'queued');
        await drain(); const found = (await query('approved')).results.find(r => r.sourceId === approved.candidateId);
        // All scores deliberately tie; use source storage to verify content even
        // when the canonical profile appears on a later result page.
        const text = psql(db, `select projection_text from app.profile_search_sources where source_id='${approved.candidateId}'`).trim();
        assert(text.includes('Reviewed profile only')); assert(text.includes('https://t.me/abc')); assert(!text.includes('Private conversation')); if (found) assert.equal(found.sourceType, 'candidate');
    });
    await t.test('direct restricted worker SQL rejects incomplete manifests; lost failure ACK and retry clear error', async () => {
        await createTelegramDraft(pool, owner, ORG_B, { fields: { firstName: 'Guard', lastName: 'Example' }, sourceTitle: 'Synthetic' });
        const j = (await call('claim')).job; assert.equal(j.kind, 'plan'); const result = plan(j); result.chunks[0].sha256 = 'f'.repeat(64);
        const client = await workerPool.connect();
        try {
            await client.query('begin; set local role app_telegram_worker');
            await assert.rejects(client.query('select app.profile_search_worker_complete_v1($1,$2::jsonb)', [token, JSON.stringify({ ...complete(j), sourceRevision: j.source.revision, sourceSha256: j.source.sha256, result })]), { code: '22023' });
            await client.query('rollback');
            await client.query('begin; set local role app_telegram_worker');
            await assert.rejects(client.query('select * from app.profile_search_sources'), { code: '42501' }); await client.query('rollback');
        } finally { await client.query('rollback').catch(() => {}); client.release(); }
        await finish(j); await drain();
        const q = await profileSearchAction(pool, owner, ORG_B, { action: 'search', operationId: randomUUID(), query: 'recoverable query', scope: 'all', readyOnly: false });
        const leased = (await call('claim')).job; const failure = { jobId: leased.id, leaseToken: leased.leaseToken, kind: 'query', code: 'EMBEDDING_UNAVAILABLE', retryAfterSeconds: 1 };
        await call('fail', failure); await assert.rejects(call('fail', failure), { code: '40001' });
        psql(db, `update app.profile_search_queries set available_at=now() where id='${q.queryId}'`); await finish((await call('claim')).job);
        assert.equal((await profileSearchStatus(pool, owner, ORG_B, { queryId: q.queryId })).errorCode, null);
    });
    await t.test('bounded recruiter retry resumes valid chunks and cannot touch other owners or structural failures', async () => {
        await drain();
        const partial = await createTelegramDraft(pool, owner, ORG_B, { fields: { firstName: 'Partial', lastName: 'Resume', professionalSummary: 'Searchable complete profile '.repeat(20) }, sourceTitle: 'Synthetic retry' });
        const j = (await call('claim')).job; assert.equal(j.source.sourceId, partial.id);
        const bytes = Buffer.from(j.source.text); const chunks = Array.from({ length: 10 }, (_, ordinal) => {
            const startByte = Math.floor(ordinal * bytes.length / 10); const endByte = Math.floor((ordinal + 1) * bytes.length / 10);
            return { ordinal, startByte, endByte, sha256: sha(bytes.subarray(startByte, endByte)), tokenCount: 40 };
        });
        await call('complete', { ...complete(j), sourceRevision: j.source.revision, sourceSha256: j.source.sha256, result: { byteLength: bytes.length, chunks } });
        const first = (await call('claim')).job; assert.equal(first.chunks.length, 8); await finish(first);
        let last;
        for (let n = 0; n < 5; n++) {
            last = (await call('claim')).job; assert.deepEqual(last.chunks.map(c => c.ordinal), [8, 9]);
            await call('fail', { jobId: last.id, leaseToken: last.leaseToken, kind: 'embed', code: 'WORKER_ERROR', retryAfterSeconds: 1 });
            psql(db, `update app.profile_search_sources set available_at=now() where id='${last.id}'`);
        }
        const privateOther = await createTelegramDraft(pool, other, ORG_B, { fields: { firstName: 'Private', lastName: 'OtherRetry' }, sourceTitle: 'Other owner' });
        const structural = await createTelegramDraft(pool, owner, ORG_B, { fields: { firstName: 'Structural', lastName: 'Failure' }, sourceTitle: 'Needs attention' });
        psql(db, `update app.profile_search_sources set status='failed',error_code='WORKER_ERROR' where source_id='${privateOther.id}'; update app.profile_search_sources set status='failed',error_code='INVALID_RESULT' where source_id='${structural.id}'`);
        const before = await query('my_drafts'); assert.equal(before.coverage.retryable, 1);
        assert.equal((await profileSearchAction(pool, owner, ORG_B, { action: 'retryIndex', scope: 'my_drafts', readyOnly: true })).retried, 0, 'readiness applies to retries too');
        assert.equal((await profileSearchAction(pool, owner, ORG_B, { action: 'retryIndex', scope: 'approved', readyOnly: false })).retried, 0);
        const receipt = await profileSearchAction(pool, owner, ORG_B, { action: 'retryIndex', scope: 'my_drafts', readyOnly: false }); assert.deepEqual(receipt, { ok: true, retried: 1, remainingFailed: 0 });
        assert.equal((await profileSearchStatus(pool, owner, ORG_B, { queryId: before.queryId })).coverage.retryable, 0, 'query snapshots expose a live retryable count');
        assert.equal(psql(db, `select count(*) from app.profile_search_chunks where source_id='${j.id}' and embedding is not null`).trim(), '8');
        const resumed = (await call('claim')).job; assert.equal(resumed.source.revision, j.source.revision); assert.deepEqual(resumed.chunks.map(c => c.ordinal), [8, 9]); await finish(resumed);
        assert.equal(psql(db, `select status from app.profile_search_sources where source_id='${privateOther.id}'`).trim(), 'failed');
        assert.equal(psql(db, `select status from app.profile_search_sources where source_id='${structural.id}'`).trim(), 'failed');
        assert((await query('my_drafts')).results.some(r => r.sourceId === partial.id));
        // Bounded batches remain usable for a large failure backlog.
        const ids = Array.from({ length: 103 }, () => randomUUID());
        psql(db, `insert into app.candidates(id,organization_id,full_name,identity_state,lifecycle) values ${ids.map(id => `('${id}','${ORG_B}','Retry volume','established','active')`).join(',')}; update app.profile_search_sources set status='failed',error_code='ATTEMPTS_EXHAUSTED' where source_id in(${ids.map(id => `'${id}'`).join(',')})`);
        assert.deepEqual(await profileSearchAction(pool, owner, ORG_B, { action: 'retryIndex', scope: 'approved', readyOnly: false }), { ok: true, retried: 100, remainingFailed: 3 });
        assert.deepEqual(await profileSearchAction(pool, owner, ORG_B, { action: 'retryIndex', scope: 'approved', readyOnly: false }), { ok: true, retried: 3, remainingFailed: 0 });
    });
    await t.test('private edit and index completion use consistent epoch-before-source locks', async () => {
        await drain(); const d = await createTelegramDraft(pool, owner, ORG_B, { fields: { firstName: 'Concurrent', lastName: 'IndexEdit' }, sourceTitle: 'Synthetic lock order' });
        await finish((await call('claim')).job); const j = (await call('claim')).job; assert.equal(j.kind, 'embed');
        const a = await admin.connect();
        try {
            await a.query('begin');
            await a.query('select e.* from app.profile_search_epochs e join app.telegram_drafts d on d.organization_id=e.organization_id and d.owner_user_id=e.owner_user_id where d.id=$1 for update of e', [d.id]);
            const writing = finish(j).then(value => ({ value }), error => ({ error }));
            let blocked = false;
            for (let i = 0; i < 100 && !blocked; i++) {
                const state = await admin.query("select exists(select 1 from pg_stat_activity where usename='search_test' and wait_event_type='Lock') blocked"); blocked = state.rows[0].blocked;
                if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
            }
            assert(blocked, 'index acknowledgement reaches a real epoch lock boundary');
            await a.query("set local statement_timeout='3s'");
            await a.query(`update app.telegram_drafts set fields=fields||'{"headline":"Edited concurrently"}'::jsonb where id=$1`, [d.id]);
            await a.query('commit'); const outcome = await writing; assert.equal(outcome.error?.code, '40001', 'stale result is fenced rather than deadlocked');
        } finally { await a.query('rollback').catch(() => {}); a.release(); }
    });
    await t.test('actual database scoring timeout rolls back every result and persists terminal acknowledgement', async () => {
        const q = await profileSearchAction(pool, owner, ORG_B, { action: 'search', operationId: randomUUID(), query: 'force bounded timeout', scope: 'approved', readyOnly: false });
        const j = (await call('claim')).job;
        psql(db, `create function public.synthetic_search_delay() returns trigger language plpgsql as $$ begin perform pg_sleep(11); return null; end $$; create trigger synthetic_search_delay before insert on app.profile_search_results for each statement execute function public.synthetic_search_delay();`);
        let receipt;
        try { receipt = await finish(j); } finally { psql(db, 'drop trigger synthetic_search_delay on app.profile_search_results; drop function public.synthetic_search_delay();'); }
        assert.deepEqual(receipt, { ok: true, status: 'failed', errorCode: 'SEARCH_TIMEOUT' }); assert.deepEqual(await finish(j), receipt);
        assert.equal(psql(db, `select count(*) from app.profile_search_results where query_id='${q.queryId}'`).trim(), '0');
        const snap = await profileSearchStatus(pool, owner, ORG_B, { queryId: q.queryId }); assert.equal(snap.status, 'failed'); assert.equal(snap.errorCode, 'SEARCH_TIMEOUT');
    });
    await t.test('cancel/expiry/revoked permission fence results and leases', async () => {
        const input = { action: 'search', operationId: randomUUID(), query: 'cancel me', scope: 'all', readyOnly: false };
        const q = await profileSearchAction(pool, owner, ORG_B, input); assert.deepEqual(await profileSearchAction(pool, owner, ORG_B, input), q);
        const j = (await call('claim')).job; await profileSearchAction(pool, owner, ORG_B, { action: 'cancel', queryId: q.queryId }); await assert.rejects(finish(j), { code: '40001' });
        psql(db, `update app.profile_search_queries set expires_at=now()-interval '1 second' where id='${q.queryId}'`); assert.equal((await profileSearchStatus(pool, owner, ORG_B, { queryId: q.queryId })).status, 'expired');
        assert.equal(psql(db, `select query_text is null from app.profile_search_queries where id='${q.queryId}'`).trim(), 't');
        psql(db, `delete from app.role_permissions where organization_id='${ORG_B}' and role_id='${CJ_ID.ROLE_B_ADMIN}' and permission_key='candidates.write'`); await assert.rejects(call('claim'), { code: '42501' });
        psql(db, `insert into app.role_permissions(organization_id,role_id,permission_key) values('${ORG_B}','${CJ_ID.ROLE_B_ADMIN}','candidates.write')`);
    });
});
