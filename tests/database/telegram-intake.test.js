import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import { POSTGRES_17_IMAGE, assertLocalTestEnvironment, psql, startPostgresContainer, stopAndRemoveContainer } from '../support/foundation-docker.js';
import { AUTHZ_ID, SUBJECTS, installStaffFixture, staffPoolOptions } from '../support/staff-authorization.js';
import { CJ_ID, CJ_SUBJECTS, clientJobFixtureSql } from '../support/client-job-workflows.js';
import { withStaffTransaction } from '../../src/lib/staff-authorization.js';
import { normalizeTelegramDraftFields } from '../../src/lib/telegram-intake-contracts.js';

const migrationsDir = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
const telegramMigration = '20261002130000_telegram_intake_foundation.sql';
// The legacy candidate-applications migration predates the portable foundation.
const migrations = readdirSync(migrationsDir).filter((file) => file >= '20260922090000_foundation_roles.sql'
    && file <= telegramMigration && file.endsWith('.sql')).sort();
const indexVersion = 'intfloat/multilingual-e5-small@614241f622f53c4eeff9890bdc4f31cfecc418b3:e5-prefix:l2:384:v1';
const identity = (subject) => ({ provider: 'google', issuer: 'https://accounts.google.com', subject });
const { ORG_A, ORG_B, USER_ADMIN2 } = AUTHZ_ID;
const workerRole = 'telegram_worker_test';
const token = () => randomBytes(48).toString('base64url');
const result = { indexVersion, embeddings: [Array.from({ length: 384 }, (_, i) => i === 0 ? 1 : 0)] };

test('Telegram private drafts and scoped embedding worker PostgreSQL boundaries', async (t) => {
    assertLocalTestEnvironment();
    const container = await startPostgresContainer('pgtelegram', POSTGRES_17_IMAGE, { publish: true });
    let pool;
    let workerPool;
    t.after(async () => { await Promise.all([pool?.end(), workerPool?.end()]); await stopAndRemoveContainer(container); });
    assert.ok(migrations.includes(telegramMigration), 'Telegram migration must be installed');
    for (const file of migrations) psql(container, readFileSync(join(migrationsDir, file), 'utf8'));
    const password = installStaffFixture(container);
    psql(container, clientJobFixtureSql);
    psql(container, `insert into app.role_permissions(organization_id,role_id,permission_key)
        values('${ORG_B}','${CJ_ID.ROLE_B_RECRUITER}','candidates.write'),
            ('${ORG_B}','${CJ_ID.ROLE_B_RECRUITER}','documents.write');`);
    pool = new pg.Pool(staffPoolOptions(container, password, 4));
    const workerPassword = randomUUID();
    psql(container, `create role ${workerRole} login noinherit nosuperuser nocreatedb nocreaterole nobypassrls password '${workerPassword}';
        grant app_telegram_worker to ${workerRole};`);
    workerPool = new pg.Pool({ ...staffPoolOptions(container, workerPassword, 2), user: workerRole });
    const scalar = (sql) => psql(container, sql).trim();
    const staff = (sql, args = [], { subject = CJ_SUBJECTS.ADMIN, organizationId = ORG_B } = {}) =>
        withStaffTransaction(pool, identity(subject), organizationId, ['candidates.read', 'candidates.write'], async ({ client }) =>
            (await client.query(sql, args)).rows[0]?.result);
    const worker = async (sql, args = []) => {
        const client = await workerPool.connect();
        try {
            await client.query('begin isolation level read committed');
            await client.query('set local role app_telegram_worker');
            const { rows: [role] } = await client.query(`select current_user as role, r.rolsuper, r.rolbypassrls
                from pg_roles r where r.rolname=current_user`);
            assert.deepEqual(role, { role: 'app_telegram_worker', rolsuper: false, rolbypassrls: false });
            const value = (await client.query(sql, args)).rows[0]?.result;
            await client.query('commit');
            return value;
        } catch (error) {
            await client.query('rollback');
            throw error;
        } finally { client.release(); }
    };
    const create = (fields = {}, context) => staff('select app.telegram_create_draft_v1($1,$2::jsonb,$3) as result',
        [randomUUID(), JSON.stringify(normalizeTelegramDraftFields(fields)), 'Synthetic manual draft'], context);
    const get = (draft, context) => staff('select app.telegram_get_draft_v1($1) as result', [draft.id], context);
    const update = (draft, fields) => staff('select app.telegram_update_draft_v1($1,$2,$3::jsonb) as result',
        [draft.id, draft.version, JSON.stringify(normalizeTelegramDraftFields(fields))]);
    const list = (context) => staff('select app.telegram_list_drafts_v1($1,$2,$3,$4) as result', ['all', null, '', 1], context);
    const decide = (draft, action, operation = randomUUID()) => staff('select app.telegram_decide_draft_v1($1,$2,$3,$4) as result',
        [draft.id, draft.version, action, operation]);
    const reserve = (draft, objectKey, context) => staff('select app.telegram_reserve_upload_v1($1,$2,$3) as result',
        [draft.id, draft.version, objectKey], context);
    const attachReserved = (draft, document) => staff('select app.telegram_attach_cv_v1($1,$2,$3::jsonb) as result',
        [draft.id, draft.version, JSON.stringify(document)]);
    const attach = async (draft, document) => {
        await reserve(draft, document.objectKey);
        return attachReserved(draft, document);
    };
    const pendingCleanup = (context) => staff('select app.telegram_pending_cleanup_v1() as result', [], context);
    const claimCleanup = (key, context) => staff('select app.telegram_claim_cleanup_v1($1) as result', [key], context);
    const finishCleanup = (key, context) => staff('select app.telegram_finish_cleanup_v1($1) as result', [key], context);
    const makeEligible = (key) => psql(container, `update app.telegram_upload_cleanup set available_at=clock_timestamp()-interval '1 second' where object_key='${key}'`);
    const documentFor = async (draft) => {
        const candidateId = await staff('select app.telegram_cv_target_v1($1) as result', [draft.id]);
        return { filename: 'Synthetic CV.pdf', sha256: 'a'.repeat(64), sizeBytes: 500, extension: 'pdf', mimeType: 'application/pdf',
            objectKey: `staff/${ORG_B}/${candidateId}/${randomUUID()}.pdf` };
    };
    const register = (credential = token(), context) => staff('select app.telegram_register_worker_v1($1,$2) as result', ['Synthetic worker', credential], context);
    const enqueue = (draft, context) => staff('select app.telegram_enqueue_embedding_v1($1,$2,$3,$4) as result',
        [draft.id, draft.version, 'Name: Synthetic candidate', indexVersion], context);
    const claim = (credential) => worker('select app.telegram_claim_job_v1($1) as result', [credential]);
    const complete = (credential, lease, value = result) => worker('select app.telegram_complete_job_v1($1,$2,$3,$4::jsonb) as result',
        [credential, lease.id, lease.leaseToken, JSON.stringify(value)]);

    await t.test('draft create, private list/get/update, optimistic version and incomplete approval', async () => {
        let draft = await create({ telegramUsername: 'sample_user' });
        assert.equal(draft.status, 'pending');
        assert.deepEqual(draft.missingFields, ['firstName', 'lastName', 'primaryEmail', 'cv']);
        assert.equal((await get(draft)).fields.firstName, '');
        assert.ok((await list()).drafts.some((item) => item.id === draft.id));
        const previous = draft;
        draft = await update(draft, { ...draft.fields, firstName: 'Ada', compensationPreference: 'EUR 100k' });
        assert.equal(draft.version, previous.version + 1);
        assert.equal(draft.fields.compensationPreference, 'EUR 100k');
        await assert.rejects(update(previous, previous.fields), { code: '40001' });
        await assert.rejects(decide(draft, 'approve'), { code: '23514' });
        for (const context of [{ subject: CJ_SUBJECTS.RECRUITER }, { subject: SUBJECTS.ADMIN2, organizationId: ORG_A }]) {
            assert.ok(!(await list(context)).drafts.some((item) => item.id === draft.id));
            await assert.rejects(get(draft, context), { code: 'P0002' });
            await assert.rejects(staff('select app.telegram_update_draft_v1($1,$2,$3::jsonb) as result',
                [draft.id, draft.version, '{}'], context), { code: '40001' });
        }
        const other = await create({}, { subject: CJ_SUBJECTS.RECRUITER });
        await assert.rejects(get(other), { code: 'P0002' });
        await assert.rejects(create({}, { subject: CJ_SUBJECTS.VIEWER }), { code: 'FORBIDDEN' });
    });

    await t.test('validated CV approval creates candidate and Telegram identifiers exactly once', async () => {
        let draft = await create({ firstName: 'Ada', lastName: 'Lovelace', primaryEmail: 'telegram@example.test',
            secondaryEmails: ['secondary@example.test'], compensationPreference: 'EUR 100k', telegramUsername: 'Sample_User', telegramUserId: '9007199254740993123456789' });
        const candidateId = await staff('select app.telegram_cv_target_v1($1) as result', [draft.id]);
        const document = await documentFor(draft);
        draft = await attach(draft, document);
        assert.deepEqual(draft.cv, { filename: document.filename, status: 'validated' });
        assert.deepEqual(draft.missingFields, []);
        const operation = randomUUID();
        const approved = await decide(draft, 'approve', operation);
        assert.deepEqual(approved, { status: 'approved', candidateId });
        assert.deepEqual(await decide(draft, 'approve', operation), { ...approved, replayed: true });
        assert.equal(scalar(`select count(*) from app.candidates where id='${candidateId}'`), '1');
        assert.equal(scalar(`select count(*) from app.documents where candidate_id='${candidateId}'`), '1');
        const identifiers = JSON.parse(scalar(`select jsonb_agg(jsonb_build_object('kind',kind,'value',normalized_value))
            from app.candidate_identifiers where candidate_id='${candidateId}'`));
        assert.ok(identifiers.some((entry) => entry.kind === 'professional_url' && entry.value === 'https://t.me/sample_user'));
        assert.ok(identifiers.some((entry) => entry.kind === 'provider_subject' && entry.value === 'telegram:user:9007199254740993123456789'));
        const cleared = await get(draft);
        assert.deepEqual(cleared.fields, {});
        assert.equal(cleared.cv, null);
        assert.equal(cleared.candidateId, candidateId);
    });

    await t.test('abandoned upload reservations honor grace, owner scope, retries and late-attachment fencing', async () => {
        const draft = await create();
        const document = await documentFor(draft);
        const key = document.objectKey;
        await assert.rejects(attachReserved(draft, document), { code: '40001' });
        assert.equal(await reserve(draft, key), true);
        assert.equal(scalar(`select available_at>created_at+interval '59 minutes' from app.telegram_upload_cleanup where object_key='${key}'`), 't');
        assert.ok(!(await pendingCleanup()).includes(key));
        assert.equal(await claimCleanup(key), false);
        assert.equal(await finishCleanup(key), false, 'pending reservations cannot be acknowledged as deleted');
        makeEligible(key);
        assert.ok((await pendingCleanup()).includes(key));
        for (const context of [{ subject: CJ_SUBJECTS.RECRUITER }, { subject: SUBJECTS.ADMIN2, organizationId: ORG_A }]) {
            assert.ok(!(await pendingCleanup(context)).includes(key));
            assert.equal(await claimCleanup(key, context), false);
            assert.equal(await finishCleanup(key, context), false);
        }
        assert.equal(await claimCleanup(key), true);
        assert.equal(scalar(`select state from app.telegram_upload_cleanup where object_key='${key}'`), 'deleting');
        assert.ok((await pendingCleanup()).includes(key), 'interrupted object deletion remains discoverable');
        assert.equal(await claimCleanup(key), true, 'cleanup retry can reclaim the deleting key');
        await assert.rejects(attachReserved(draft, document), { code: '40001' });
        assert.equal(await finishCleanup(key), true);
        assert.equal(await finishCleanup(key), false);
        assert.ok(!(await pendingCleanup()).includes(key));
        await assert.rejects(attachReserved(draft, document), { code: '40001' });
        assert.equal((await get(draft)).cv, null);
    });

    await t.test('cleanup preserves draft and canonical references and queues replaced CVs', async () => {
        let draft = await create({ firstName: 'Grace', lastName: 'Hopper', primaryEmail: 'cleanup-approved@example.test' });
        const firstDocument = await documentFor(draft);
        draft = await attach(draft, firstDocument);
        assert.equal(scalar(`select count(*) from app.telegram_upload_cleanup where object_key='${firstDocument.objectKey}'`), '0', 'attachment consumes reservation');
        const credential = token();
        await register(credential);
        await enqueue(draft);
        const lease = await claim(credential);
        await complete(credential, lease);
        const secondDocument = await documentFor(draft);
        draft = await attach(draft, secondDocument);
        assert.equal(scalar(`select count(*) from app.telegram_draft_embeddings where draft_id='${draft.id}'`), '0', 'CV change invalidates embedding');
        assert.ok((await pendingCleanup()).includes(firstDocument.objectKey));
        assert.equal(await claimCleanup(firstDocument.objectKey), true);
        assert.equal(await finishCleanup(firstDocument.objectKey), true);
        psql(container, `insert into app.telegram_upload_cleanup(organization_id,owner_user_id,object_key)
            values('${ORG_B}','${USER_ADMIN2}','${secondDocument.objectKey}')`);
        assert.equal(await claimCleanup(secondDocument.objectKey), false, 'live private draft owns the bytes');
        assert.equal(await finishCleanup(secondDocument.objectKey), false);
        assert.equal(scalar(`select state from app.telegram_upload_cleanup where object_key='${secondDocument.objectKey}'`), 'pending');
        const approved = await decide(draft, 'approve');
        assert.equal(approved.status, 'approved');
        assert.equal(await claimCleanup(secondDocument.objectKey), false, 'canonical blob reference survives approval and draft clearing');
        assert.equal(await finishCleanup(secondDocument.objectKey), false);
        assert.equal(scalar(`select count(*) from app.blob_locations where object_key='${secondDocument.objectKey}' and state='available'`), '1');
    });

    await t.test('cleanup claim racing attachment cannot delete an attached CV', async () => {
        const draft = await create();
        const document = await documentFor(draft);
        await reserve(draft, document.objectKey);
        makeEligible(document.objectKey);
        const [attached, claimed] = await Promise.allSettled([attachReserved(draft, document), claimCleanup(document.objectKey)]);
        assert.equal(claimed.status, 'fulfilled');
        if (attached.status === 'fulfilled') {
            assert.equal(claimed.value, false);
            assert.equal((await get(draft)).cv.filename, document.filename);
        } else {
            assert.equal(attached.reason.code, '40001');
            assert.equal(claimed.value, true);
            assert.equal((await get(draft)).cv, null);
            assert.equal(await finishCleanup(document.objectKey), true);
        }
    });

    await t.test('shared evidence survives one decision and is removed after the last reference', async () => {
        const drafts = [await create(), await create()];
        const evidenceId = randomUUID();
        psql(container, `insert into app.telegram_evidence(id,organization_id,owner_user_id,source_key,text)
            values('${evidenceId}','${ORG_B}','${USER_ADMIN2}','synthetic:shared','Synthetic shared source');
            insert into app.telegram_draft_evidence(organization_id,owner_user_id,draft_id,evidence_id) values
            ${drafts.map((draft) => `('${ORG_B}','${USER_ADMIN2}','${draft.id}','${evidenceId}')`).join(',')};`);
        assert.equal((await get(drafts[0])).evidence[0].text, 'Synthetic shared source');
        await decide(drafts[0], 'discard');
        assert.equal(scalar(`select count(*) from app.telegram_evidence where id='${evidenceId}'`), '1');
        assert.equal((await get(drafts[1])).evidence.length, 1);
        await decide(drafts[1], 'discard');
        assert.equal(scalar(`select count(*) from app.telegram_evidence where id='${evidenceId}'`), '0');
        assert.equal(scalar(`select count(*) from app.telegram_draft_evidence where evidence_id='${evidenceId}'`), '0');
    });

    await t.test('worker credentials and job claims are scoped to owner and organization', async () => {
        for (const credential of ['short', 'a'.repeat(63), 'a'.repeat(65), '+'.repeat(64)]) {
            await assert.rejects(register(credential), { code: '22023' });
        }
        const credential = token();
        const registered = await register(credential);
        assert.ok(registered.id && registered.expiresAt);
        assert.equal(scalar(`select octet_length(token_sha256) from app.telegram_workers where id='${registered.id}'`), '32');
        const otherContext = { subject: CJ_SUBJECTS.RECRUITER };
        const orgContext = { subject: SUBJECTS.ADMIN2, organizationId: ORG_A };
        const otherCredential = token();
        const orgCredential = token();
        await register(otherCredential, otherContext);
        await register(orgCredential, orgContext);
        const otherDraft = await create({}, otherContext);
        const orgDraft = await create({}, orgContext);
        const otherJob = await enqueue(otherDraft, otherContext);
        const orgJob = await enqueue(orgDraft, orgContext);
        assert.equal(await claim(credential), null, 'cannot claim another owner or organization job');
        const otherLease = await claim(otherCredential);
        const orgLease = await claim(orgCredential);
        assert.equal(otherLease.id, otherJob.jobId);
        assert.equal(orgLease.id, orgJob.jobId);
        await assert.rejects(complete(credential, otherLease), { code: '40001' });
        assert.deepEqual(await complete(otherCredential, otherLease), { status: 'completed' });
        assert.deepEqual(await complete(orgCredential, orgLease), { status: 'completed' });
        await assert.rejects(claim(token()), { code: '42501' });
    });

    await t.test('expired leases are reclaimed and old workers cannot complete or fail them', async () => {
        const credential = token();
        await register(credential);
        const draft = await create();
        const { jobId } = await enqueue(draft);
        assert.equal((await enqueue(draft)).jobId, jobId, 'enqueue is idempotent per source version');
        const first = await claim(credential);
        assert.equal(first.id, jobId);
        assert.equal(first.payload.indexVersion, indexVersion);
        psql(container, `update app.telegram_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id='${jobId}'`);
        await assert.rejects(complete(credential, first), { code: '40001' });
        const reclaimed = await claim(credential);
        assert.equal(reclaimed.id, jobId);
        assert.notEqual(reclaimed.leaseToken, first.leaseToken);
        await assert.rejects(complete(credential, first), { code: '40001' });
        await assert.rejects(worker('select app.telegram_fail_job_v1($1,$2,$3,$4) as result',
            [credential, first.id, first.leaseToken, 'WORKER_ERROR']), { code: '40001' });
        for (const invalid of [{ ...result, embeddings: [[1, 0]] }, { ...result, embeddings: [Array(384).fill(1)] }, { ...result, indexVersion: 'wrong-model' }]) {
            await assert.rejects(complete(credential, reclaimed, invalid), { code: '22023' });
        }
        assert.deepEqual(await complete(credential, reclaimed), { status: 'completed' });
        assert.deepEqual(await complete(credential, reclaimed), { status: 'completed', replayed: true });
        assert.equal(scalar(`select cardinality(embedding) from app.telegram_draft_embeddings where draft_id='${draft.id}'`), '384');
        assert.equal(scalar(`select payload::text from app.telegram_jobs where id='${jobId}'`), '{}');
        assert.equal(scalar(`select attempts from app.telegram_jobs where id='${jobId}'`), '2');
        await update(draft, { firstName: 'Edited' });
        assert.equal(scalar(`select count(*) from app.telegram_draft_embeddings where draft_id='${draft.id}'`), '0');
    });

    await t.test('explicit re-enqueue retries terminal jobs with a fresh payload and lease', async () => {
        const credential = token();
        await register(credential);
        const draft = await create();
        const { jobId } = await enqueue(draft);
        const oldLease = await claim(credential);
        await worker('select app.telegram_fail_job_v1($1,$2,$3,$4) as result',
            [credential, oldLease.id, oldLease.leaseToken, 'INVALID_JOB']);
        assert.equal(scalar(`select status from app.telegram_jobs where id='${jobId}'`), 'failed');
        assert.equal(scalar(`select payload::text from app.telegram_jobs where id='${jobId}'`), '{}');
        assert.equal((await enqueue(draft)).jobId, jobId);
        assert.equal(scalar(`select attempts from app.telegram_jobs where id='${jobId}'`), '0');
        const newLease = await claim(credential);
        assert.equal(newLease.id, jobId);
        assert.notEqual(newLease.leaseToken, oldLease.leaseToken);
        assert.equal(newLease.payload.indexVersion, indexVersion);
        await assert.rejects(complete(credential, oldLease), { code: '40001' });
        assert.deepEqual(await complete(credential, newLease), { status: 'completed' });
    });

    await t.test('editing a draft fences an in-flight embedding result', async () => {
        const credential = token();
        await register(credential);
        const draft = await create();
        await enqueue(draft);
        const lease = await claim(credential);
        await update(draft, { firstName: 'Edited while leased' });
        assert.deepEqual(await complete(credential, lease), { status: 'cancelled' });
        assert.equal(scalar(`select count(*) from app.telegram_draft_embeddings where draft_id='${draft.id}'`), '0');
        assert.equal(scalar(`select payload::text from app.telegram_jobs where id='${lease.id}'`), '{}');
    });

    await t.test('worker and staff runtime roles have no direct private-table access', async () => {
        for (const table of ['telegram_drafts', 'telegram_evidence', 'telegram_draft_evidence', 'telegram_upload_cleanup', 'telegram_workers', 'telegram_jobs', 'telegram_draft_embeddings']) {
            await assert.rejects(worker(`select * from app.${table}`), { code: '42501' });
            await assert.rejects(staff(`select * from app.${table}`), { code: '42501' });
        }
        await assert.rejects(worker('select app.telegram_create_draft_v1($1,$2::jsonb,$3) as result', [randomUUID(), '{}', 'Forbidden']), { code: '42501' });
        await assert.rejects(worker('select app.telegram_worker_context_v1($1) as result', [token()]), { code: '42501' });
        await assert.rejects(staff('select app.telegram_claim_job_v1($1) as result', [token()]), { code: '42501' });
    });

    await t.test('worker and owner membership revocations immediately deny work', async () => {
        const credential = token();
        const registered = await register(credential);
        const draft = await create();
        await enqueue(draft);
        const lease = await claim(credential);
        assert.equal(await staff('select app.telegram_revoke_worker_v1($1) as result', [registered.id], { subject: CJ_SUBJECTS.RECRUITER }), false);
        assert.equal(await staff('select app.telegram_revoke_worker_v1($1) as result', [registered.id]), true);
        await assert.rejects(claim(credential), { code: '42501' });
        await assert.rejects(complete(credential, lease), { code: '42501' });
        const activeCredential = token();
        await register(activeCredential);
        psql(container, `update app.organization_memberships set status='revoked',revoked_at=clock_timestamp() where id='${AUTHZ_ID.MEMBER_B_ADMIN}'`);
        await assert.rejects(claim(activeCredential), { code: '42501' });
        await assert.rejects(get(draft), { code: 'UNAUTHORIZED' });
    });
});
