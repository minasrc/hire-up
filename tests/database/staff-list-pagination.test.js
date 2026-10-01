import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import pg from 'pg';
import { POSTGRES_17_IMAGE, assertLocalTestEnvironment, psql,
    startPostgresContainer, stopAndRemoveContainer } from '../support/foundation-docker.js';
import { AUTHZ_ID, GOOGLE_ISSUER, installStaffFixture, staffPoolOptions } from '../support/staff-authorization.js';
import { CJ_ID, CJ_SUBJECTS, clientJobFixtureSql } from '../support/client-job-workflows.js';
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
    await t.test('both operations deny unauthorized users and foreign memberships', async () => {
        for (const operation of [listClientDirectory, listJobDirectory]) {
            await assert.rejects(operation(pool, identity(CJ_SUBJECTS.VIEWER), AUTHZ_ID.ORG_B),
                (error) => error.code === 'FORBIDDEN');
            await assert.rejects(operation(pool, identity(CJ_SUBJECTS.RECRUITER), AUTHZ_ID.ORG_A),
                (error) => ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.code));
        }
    });
});
