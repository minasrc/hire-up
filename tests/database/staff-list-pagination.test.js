import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import pg from 'pg';
import { POSTGRES_17_IMAGE, assertLocalTestEnvironment, psql,
    startPostgresContainer, stopAndRemoveContainer } from '../support/foundation-docker.js';
import { AUTHZ_ID, GOOGLE_ISSUER, installStaffFixture, staffPoolOptions } from '../support/staff-authorization.js';
import { CJ_ID, CJ_SUBJECTS, clientJobFixtureSql } from '../support/client-job-workflows.js';
import { getCandidateProfileOptions, listCandidateProfiles, listCandidateProfileDirectory } from '../../src/lib/candidate-profile-operations.js';
import { withStaffTransaction } from '../../src/lib/staff-authorization.js';
import { listApplicationDirectory } from '../../src/lib/pipeline-operations.js';
import { listClientDirectory, listJobDirectory } from '../../src/lib/client-job-operations.js';


const identity = (subject) => ({ provider: 'google', issuer: GOOGLE_ISSUER, subject });

test('staff directory pages filter all records and preserve authorization', async (t) => {
    assertLocalTestEnvironment();
    const container = await startPostgresContainer('pglistpages', POSTGRES_17_IMAGE, { publish: true });
    let pool;
    t.after(async () => { await pool?.end(); stopAndRemoveContainer(container); });
    const migrationRoot = new URL('../../supabase/migrations/', import.meta.url);
    for (const file of readdirSync(migrationRoot).filter((file) => file >= '20260922090000' && file.endsWith('.sql')).sort()) {
        psql(container, readFileSync(new URL(file, migrationRoot), 'utf8'));
    }
    const password = installStaffFixture(container);
    psql(container, clientJobFixtureSql);
    pool = new pg.Pool(staffPoolOptions(container, password, 2));
    psql(container, `
        insert into app.clients (id, organization_id, name, status, created_at)
        select ('91000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
            '${AUTHZ_ID.ORG_B}', 'Page client ' || lpad(i::text, 3, '0'),
            case when i % 2 = 0 then 'draft' else 'active' end,
            '2026-01-01'::timestamptz + i * interval '1 second'
        from generate_series(1, 120) i;
        insert into app.jobs (id, organization_id, client_id, pipeline_id, slug, title,
            description, location_display, employment_type, publication_state, application_state,
            owner_membership_id, created_at)
        select ('92000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
            '${AUTHZ_ID.ORG_B}',
            ('91000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
            '${CJ_ID.PIPELINE_B}', 'page-job-' || i, 'Page job ' || lpad(i::text, 3, '0'),
            'Synthetic description', 'Berlin', 'full_time', 'draft',
            case when i % 2 = 0 then 'open' else 'closed' end,
            case when i % 2 = 0 then '${CJ_ID.MEMBER_B_ADMIN}'::uuid else '${CJ_ID.MEMBER_B_REC}'::uuid end,
            '2026-01-01'::timestamptz + i * interval '1 second'
        from generate_series(1, 120) i;
        insert into app.clients (id, organization_id, name, status)
        values ('93000000-0000-4000-8000-000000000001', '${AUTHZ_ID.ORG_A}', 'Foreign page client', 'active');
    `);
    const admin = identity(CJ_SUBJECTS.ADMIN);
    const clients = (filters) => listClientDirectory(pool, admin, AUTHZ_ID.ORG_B, filters);
    const jobs = (filters) => listJobDirectory(pool, admin, AUTHZ_ID.ORG_B, filters);

    await t.test('pages are bounded, stable, disjoint and clamp an out-of-range page', async () => {
        const first = await clients({ q: 'Page client' });
        const second = await clients({ q: 'Page client', page: '2' });
        assert.equal(first.rows.length, 50);
        assert.equal(first.total, 120);
        assert.equal(second.rows.length, 50);
        assert.equal(second.page, 2);
        assert.equal(new Set([...first.rows, ...second.rows].map((row) => row.id)).size, 100);
        assert.deepEqual(await clients({ q: 'Page client', page: '2' }), second);
        const last = await clients({ q: 'Page client', page: '999' });
        assert.equal(last.page, 3);
        assert.equal(last.rows.length, 20);
        const empty = await clients({ q: 'not here', page: '2' });
        assert.equal(empty.page, 1);
        assert.equal(empty.total, 0);
        assert.deepEqual(empty.rows, []);
    });
    await t.test('search reaches off-page rows and literal wildcard characters are not SQL patterns', async () => {
        const result = await clients({ q: 'Page client 001' });
        assert.equal(result.total, 1);
        assert.equal(result.rows[0].name, 'Page client 001');
        assert.equal(result.rows[0].jobCount, 1);
        assert.equal((await clients({ q: '%' })).total, 0);
        assert.equal((await clients({ status: 'draft', q: 'Page client' })).total, 60);
        assert.equal((await clients({ q: 'Foreign page client' })).total, 0);
    });
    await t.test('jobs apply owner, client, intake and sorting before paging', async () => {
        const first = await jobs({ q: 'Page job' });
        const second = await jobs({ q: 'Page job', page: '2' });
        assert.equal(first.rows[0].title, 'Page job 001');
        assert.equal(second.rows[0].title, 'Page job 051');
        assert.equal(second.total, 120);
        assert.equal(first.clients.length, 121, 'client options include off-page records');
        const descending = await jobs({ q: 'Page job', dir: 'desc' });
        assert.equal(descending.rows[0].title, 'Page job 120');
        const owned = await jobs({ q: 'Page job', mine: '1', intake: 'open' });
        assert.equal(owned.total, 60);
        assert.ok(owned.rows.every((row) => row.ownerMembershipId === CJ_ID.MEMBER_B_ADMIN));
        const result = await jobs({ q: 'Page job 120', client: '91000000-0000-4000-8000-000000000120' });
        assert.equal(result.total, 1);
        assert.equal((await jobs({ state: 'listed' })).total, 0);
        assert.equal((await jobs({ state: 'unlisted' })).total, 0);
        assert.equal((await jobs({ client: '93000000-0000-4000-8000-000000000001' })).total, 0);
    });
    await t.test('base tables are authorized once instead of rescanned for every join row', async () => {
        const migration = readFileSync(new URL('20261002120000_staff_list_pagination.sql', migrationRoot), 'utf8');
        let sql = migration.split('create function app.list_job_directory_v1')[1].split('    return (')[1].split('    );')[0];
        const values = { v_org: `'${AUTHZ_ID.ORG_B}'::uuid`, v_member: `'${CJ_ID.MEMBER_B_ADMIN}'::uuid`,
            p_query: "'Page job'", p_client: 'null::uuid', p_state: "'all'", p_intake: "'all'",
            p_mine: 'false', p_sort: "'title'", p_direction: "'asc'", p_page: '1' };
        for (const [key, value] of Object.entries(values)) sql = sql.replace(new RegExp(`\\b${key}\\b`, 'g'), value);
        const plan = psql(container, `set role app_executor;
            select set_config('app.actor_id', '${AUTHZ_ID.USER_ADMIN2}', false),
                set_config('app.organization_id', '${AUTHZ_ID.ORG_B}', false);
            explain (analyze, buffers, format json) ${sql}`);
        const explanation = JSON.parse(plan.slice(plan.indexOf('[')))[0];
        const scans = [];
        const visit = (node) => {
            if (['jobs', 'clients'].includes(node['Relation Name'])) scans.push(node);
            for (const child of node.Plans ?? []) visit(child);
        };
        visit(explanation.Plan);
        assert.equal(scans.length, 2);
        for (const scan of scans) assert.equal(scan['Actual Loops'], 1);
        t.diagnostic(`Job directory EXPLAIN execution: ${explanation['Execution Time']} ms (121 jobs/clients).`);

    });
    await t.test('candidate pages search beyond the former cap and exclude restricted/foreign data', async () => {
        psql(container, `
            insert into app.candidates (id, organization_id, full_name, identity_state,
                lifecycle, profile_contact_set, contact_email, created_at)
            select ('94000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
                '${AUTHZ_ID.ORG_B}', 'Page candidate ' || lpad(i::text, 3, '0'),
                'established', 'active', true, 'page-' || i || '@example.test',
                '2026-01-01'::timestamptz + i * interval '1 second'
            from generate_series(1, 620) i;
            insert into app.candidates (id, organization_id, full_name, identity_state, lifecycle)
            values ('94000000-0000-4000-8000-000000000621', '${AUTHZ_ID.ORG_B}',
                'Page candidate restricted', 'established', 'restricted'),
                ('94000000-0000-4000-8000-000000000622', '${AUTHZ_ID.ORG_A}',
                'Page candidate foreign', 'established', 'active');
        `);
        const candidates = (input) => listCandidateProfileDirectory(pool, admin, AUTHZ_ID.ORG_B, input);
        let exchanges = 0;
        const countedPool = { async connect() {
            const client = await pool.connect();
            return { query(...args) { exchanges += 1; return client.query(...args); },
                release(error) { client.release(error); } };
        } };
        const oldList = await listCandidateProfiles(countedPool, admin, AUTHZ_ID.ORG_B,
            { query: 'Page candidate', limit: 500 });
        await getCandidateProfileOptions(countedPool, admin, AUTHZ_ID.ORG_B);
        assert.equal(exchanges, 10);
        exchanges = 0;
        const first = await listCandidateProfileDirectory(countedPool, admin, AUTHZ_ID.ORG_B,
            { q: 'Page candidate' });
        assert.equal(exchanges, 5);
        assert.equal(oldList.candidates.length, 500);
        assert.ok(JSON.stringify(first).length < JSON.stringify(oldList).length / 5);
        t.diagnostic(`Candidate rows: ${oldList.candidates.length} → ${first.rows.length}; ` +
            `list + options exchanges: 10 → ${exchanges}; ` +
            `result bytes: ${Buffer.byteLength(JSON.stringify(oldList))} → ${Buffer.byteLength(JSON.stringify(first))}.`);

        const second = await candidates({ q: 'Page candidate', page: '2' });
        assert.equal(first.total, 620);
        assert.equal(first.rows.length, 50);
        assert.equal(first.rows[0].fullName, 'Page candidate 620');
        assert.equal(first.profileOptions.canWrite, true);
        assert.equal(new Set([...first.rows, ...second.rows].map((r) => r.candidateId)).size, 100);
        assert.deepEqual(await candidates({ q: 'Page candidate', page: '2' }), second);
        const last = await candidates({ q: 'Page candidate', page: '999' });
        assert.equal(last.page, 13);
        assert.equal(last.rows.length, 20);
        const email = await candidates({ q: 'page-1@example.test' });
        assert.equal(email.total, 1);
        assert.equal(email.rows[0].fullName, 'Page candidate 001');
        assert.equal(email.rows[0].email, 'page-1@example.test');
        assert.equal((await candidates({ q: '%' })).total, 0);
        assert.equal((await candidates({ q: 'Page candidate restricted' })).total, 0);
        assert.equal((await candidates({ q: 'Page candidate foreign' })).total, 0);
        const empty = await candidates({ q: 'missing', page: '9' });
        assert.equal(empty.page, 1);
        assert.deepEqual(empty.rows, []);
        await assert.rejects(listCandidateProfileDirectory(pool,
            identity(CJ_SUBJECTS.VIEWER), AUTHZ_ID.ORG_B), (e) => e.code === 'FORBIDDEN');
        await assert.rejects(listCandidateProfileDirectory(pool,
            identity(CJ_SUBJECTS.RECRUITER), AUTHZ_ID.ORG_A), (e) => e.code === 'UNAUTHORIZED');
    });
    await t.test('application paging retains whole-directory facets and secure filter options', async () => {
        psql(container, `
            insert into app.applications (id, organization_id, candidate_id, job_id, pipeline_id,
                stage_id, public_reference, reference_version, received_at)
            select ('95000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
                '${AUTHZ_ID.ORG_B}',
                ('94000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
                case when i <= 500 then '${CJ_ID.JOB_LEGACY_B}'::uuid
                    else '92000000-0000-4000-8000-000000000120'::uuid end,
                '${CJ_ID.PIPELINE_B}',
                case when i % 2 = 0 then '${CJ_ID.STAGE_B_1}'::uuid else '${CJ_ID.STAGE_B_2}'::uuid end,
                'AG-BBBB' || lpad(upper(to_hex(i)), 8, '0'), 1,
                '2026-01-01'::timestamptz + i * interval '1 second'
            from generate_series(1, 621) i;
        `);
        const applications = (filters) => listApplicationDirectory(pool, admin, AUTHZ_ID.ORG_B, filters);
        let exchanges = 0;
        const countedPool = { async connect() {
            const client = await pool.connect();
            return { query(...args) { exchanges += 1; return client.query(...args); },
                release(error) { client.release(error); } };
        } };
        const started = performance.now();
        const first = await listApplicationDirectory(countedPool, admin, AUTHZ_ID.ORG_B, { q: 'Page candidate' });
        const directoryMs = performance.now() - started;
        assert.equal(exchanges, 5);
        assert.equal(first.total, 620);
        assert.equal(first.scopeTotal, 620);
        assert.equal(first.rows.length, 50);
        assert.equal(first.rows[0].candidateName, 'Page candidate 620');
        assert.equal(first.stages.reduce((sum, stage) => sum + stage.count, 0), 620);
        assert.equal(first.stages.find((stage) => stage.key === 'review').count, 310);
        assert.equal(first.stages.find((stage) => stage.key === 'interview').count, 310);
        assert.equal(first.jobs.length, 121);
        assert.ok(first.clients.some((client) => client.name === 'Page client 001'));
        assert.ok(first.clients.every((client) => client.name !== 'Foreign page client'));
        const second = await applications({ q: 'Page candidate', page: '2' });
        assert.equal(new Set([...first.rows, ...second.rows].map((r) => r.applicationId)).size, 100);
        assert.deepEqual(await applications({ q: 'Page candidate', page: '2' }), second);
        const stage = await applications({ q: 'Page candidate', stage: 'interview', page: '2' });
        assert.equal(stage.total, 310);
        assert.equal(stage.scopeTotal, 620);
        assert.deepEqual(stage.stages, first.stages);
        assert.ok(stage.rows.every((row) => row.stageKey === 'interview'));
        const review = await applications({ q: 'Page candidate', review: '1' });
        assert.equal(review.total, 310);
        assert.ok(review.rows.every((row) => row.stageIsInitial));
        assert.equal(review.stages.find((row) => row.key === 'interview').count, 0);
        assert.equal((await applications({ q: 'Page candidate', stage: 'active' })).total, 620);
        const toReview = await applications({ q: 'Page candidate', stage: 'to_review' });
        assert.equal(toReview.total, 310);
        assert.ok(toReview.rows.every(row => row.stageIsInitial));
        assert.equal(toReview.stages.find(row => row.key === 'review').isInitial, true);
        assert.equal((await applications({ q: 'Page candidate', stage: 'closed' })).total, 0);
        const job = await applications({ q: 'Page candidate', job: CJ_ID.JOB_LEGACY_B });
        assert.equal(job.total, 500);
        const client = await applications({ q: 'Page candidate', client: '91000000-0000-4000-8000-000000000120' });
        assert.equal(client.total, 120);
        const offPage = await applications({ q: 'Page candidate 001' });
        assert.equal(offPage.total, 1);
        const reference = await applications({ q: 'AG-BBBB00000001' });
        assert.equal(reference.total, 1);
        assert.equal((await applications({ q: '%' })).total, 0);
        assert.equal((await applications({ q: 'Page candidate restricted' })).total, 0);
        assert.equal((await applications({ client: '93000000-0000-4000-8000-000000000001' })).total, 0);
        const stageId = await applications({ q: 'Page candidate', stage: CJ_ID.STAGE_B_1 });
        assert.equal(stageId.total, 310);
        const last = await applications({ q: 'Page candidate', page: '999' });
        assert.equal(last.page, 13);
        assert.equal(last.rows.length, 20);
        const empty = await applications({ q: 'Page candidate', stage: 'unavailable', page: '5' });
        assert.equal(empty.total, 0);
        assert.equal(empty.scopeTotal, 620);
        assert.equal(empty.page, 1);
        assert.deepEqual(empty.rows, []);
        const baselineStarted = performance.now();
        // Only the old-query comparison in this throwaway database gets more
        // time. The new operation must pass the normal production timeout.
        const old = await withStaffTransaction(pool, admin, AUTHZ_ID.ORG_B,
            ['applications.read'], async ({ client }) => {
                await client.query("set local statement_timeout = '60s'");
                const { rows } = await client.query(
                    'select app.list_applications_v1(null, $1, 500) as result', ['Page candidate']);
                return rows[0].result;
            });
        t.diagnostic(`Application query: old ${(performance.now() - baselineStarted).toFixed(1)} ms; ` +
            `bounded directory ${directoryMs.toFixed(1)} ms (single synthetic sample).`);
        assert.ok(JSON.stringify(first).length < JSON.stringify(old).length / 4);
        t.diagnostic(`Application result bytes: ${Buffer.byteLength(JSON.stringify(old))} → ` +
            `${Buffer.byteLength(JSON.stringify(first))} (including all filter labels and stage counts).`);
        await assert.rejects(listApplicationDirectory(pool,
            identity(CJ_SUBJECTS.VIEWER), AUTHZ_ID.ORG_B), (e) => e.code === 'FORBIDDEN');
        await assert.rejects(listApplicationDirectory(pool,
            identity(CJ_SUBJECTS.RECRUITER), AUTHZ_ID.ORG_A), (e) => e.code === 'UNAUTHORIZED');
    });
    await t.test('application joins scan each authorized table scope once', async () => {
        const migration = readFileSync(new URL('20261004110000_staff_application_directory.sql', migrationRoot), 'utf8');
        let sql = migration.split('    return (')[1].split('    );')[0];
        const values = { v_org: `'${AUTHZ_ID.ORG_B}'::uuid`, p_query: "'Page candidate'",
            p_job: 'null::uuid', p_client: 'null::uuid', p_stage: "'all'", p_review: 'false', p_page: '1' };
        for (const [key, value] of Object.entries(values)) sql = sql.replace(new RegExp(`\\b${key}\\b`, 'g'), value);
        const plan = psql(container, `set role app_executor;
            select set_config('app.actor_id', '${AUTHZ_ID.USER_ADMIN2}', false),
                set_config('app.organization_id', '${AUTHZ_ID.ORG_B}', false);
            explain (analyze, buffers, format json) ${sql}`);
        const explanation = JSON.parse(plan.slice(plan.indexOf('[')))[0];
        const scans = [];
        const visit = (node) => {
            if (['applications', 'candidates', 'jobs', 'clients', 'pipeline_stages'].includes(node['Relation Name'])) scans.push(node);
            for (const child of node.Plans ?? []) visit(child);
        };
        visit(explanation.Plan);
        assert.equal(scans.length, 5);
        for (const scan of scans) assert.equal(scan['Actual Loops'], 1);
        t.diagnostic(`Application directory EXPLAIN: ${explanation['Execution Time']} ms (622 applications).`);
    });
    await t.test('both operations deny unauthorized users and foreign memberships', async () => {
        for (const operation of [listClientDirectory, listJobDirectory]) {
            await assert.rejects(operation(pool, identity(CJ_SUBJECTS.VIEWER), AUTHZ_ID.ORG_B),
                (error) => error.code === 'FORBIDDEN');
            await assert.rejects(operation(pool, identity(CJ_SUBJECTS.RECRUITER), AUTHZ_ID.ORG_A),
                (error) => ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.code));
        }
    });
});
