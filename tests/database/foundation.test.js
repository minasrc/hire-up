import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
    copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
    POSTGRES_16_IMAGE,
    POSTGRES_17_IMAGE,
    RUN_ID,
    SUPABASE_PROJECT_LABEL,
    assertLocalTestEnvironment,
    assertSqlstate,
    awaitProcessExit,
    dockerExecInput,
    findFreePort,
    hasProjectLabel,
    holdExclusiveLock,
    inspectDockerResource,
    isPortFree,
    listContainersWithLabel,
    listDockerResourceNames,
    psql,
    psqlExpectError,
    startPostgresContainer,
    stopAndRemoveContainer,
    tryDockerCommand,
} from '../support/foundation-docker.js';
import {
    AUTHZ_ID,
    AUTHZ_MIGRATION,
    GITHUB_ISSUER,
    GOOGLE_ISSUER,
    GOOGLE_MIGRATION,
    SUBJECTS,
    staffFixtureSql,
} from '../support/staff-authorization.js';
import {
    AUTH_ROUTINE_SNAPSHOT_SQL,
    HASH,
    PRIVACY_ID,
    PRIVACY_MIGRATIONS,
    assertPrivacyFoundation,
    privacyFixtureSql,
} from '../support/privacy-foundation.js';
import {
    PRIVACY_FUNCTIONS,
    PRIVACY_HELPER_FUNCTIONS,
    PRIVACY_OPS_MIGRATION,
    privacyOpsFixtureSql,
} from '../support/privacy-operations.js';
import {
    WORKFLOW_FUNCTIONS,
    WORKFLOW_MIGRATION,
} from '../support/client-job-workflows.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const migrationsDir = join(repoRoot, 'supabase', 'migrations');
const supabaseBin = join(repoRoot, 'node_modules', '.bin', 'supabase');
const playwrightBin = join(repoRoot, 'node_modules', '.bin', 'playwright');

const LEGACY_MIGRATION = '20260911120000_candidate_applications.sql';
const TOTP_MIGRATION = '20260925100000_staff_totp.sql';
const LISTING_MIGRATION = '20260925110000_staff_listing.sql';
const INVITES_MIGRATION = '20260925120000_staff_invites.sql';
const INVITE_DOMAINS_MIGRATION = '20260925130000_staff_invite_domains.sql';
const PIPELINE_MIGRATION = '20260925140000_application_pipeline.sql';
const INTAKE_MIGRATION = '20260926140000_public_intake.sql';
const WORKSPACE_MIGRATION = '20260928100000_staff_workspace.sql';
const VISIBILITY_MIGRATION = '20260928220000_job_visibility.sql';
const FOUNDATION_MIGRATIONS = [
    '20260922090000_foundation_roles.sql',
    '20260922090100_foundation_schema.sql',
    '20260922090200_foundation_seed.sql',
];

const mode = process.env.FOUNDATION_TEST_MODE ?? 'postgres';
if (!['postgres', 'supabase'].includes(mode)) {
    throw new Error("FOUNDATION_TEST_MODE must be 'postgres' or 'supabase'.");
}

const readMigration = (name) => readFileSync(join(migrationsDir, name), 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const ID = {
    ORG_A: '9c4edd11-2571-490b-a87c-ef30b9e0a001',
    ROLE_A_ADMIN: '9c4edd11-2571-490b-a87c-ef30b9e0a011',
    ROLE_A_RECRUITER: '9c4edd11-2571-490b-a87c-ef30b9e0a012',
    ROLE_A_VIEWER: '9c4edd11-2571-490b-a87c-ef30b9e0a013',
    PIPELINE_A: '9c4edd11-2571-490b-a87c-ef30b9e0a020',
    STAGE_A_REVIEW: '9c4edd11-2571-490b-a87c-ef30b9e0a021',
    STAGE_A_SCREEN: '9c4edd11-2571-490b-a87c-ef30b9e0a022',
    STAGE_A_REJECTED: '9c4edd11-2571-490b-a87c-ef30b9e0a026',
    ORG_B: uuid(2),
    USER_1: uuid(10),
    USER_2: uuid(11),
    ROLE_B_ADMIN: uuid(20),
    ROLE_B_RECRUITER: uuid(21),
    MEMBER_A_ADMIN: uuid(30),
    MEMBER_B_RECRUITER: uuid(31),
    CLIENT_A: uuid(40),
    CLIENT_B: uuid(41),
    PIPELINE_B: uuid(50),
    STAGE_B_REVIEW: uuid(51),
    STAGE_B_SECOND: uuid(52),
    PIPELINE_A_SECOND: uuid(53),
    STAGE_A_SECOND: uuid(54),
    JOB_A: uuid(60),
    JOB_B: uuid(61),
    CAND_A: uuid(70),
    CAND_A2: uuid(71),
    CAND_B: uuid(72),
    SOURCE_A: uuid(80),
    SOURCE_A2: uuid(81),
    SOURCE_B: uuid(82),
    APP_A1: uuid(100),
    APP_A2: uuid(101),
    APP_A3: uuid(104),
    IDENTITY_REVOKED: uuid(110),
};

const fixtureSql = `
insert into app.users (id, display_name, status) values
    ('${ID.USER_1}', 'Shared User', 'active'),
    ('${ID.USER_2}', 'Second User', 'active');
insert into app.organizations (id, key, name, status) values
    ('${ID.ORG_B}', 'acme', 'Acme', 'active');
insert into app.roles (id, organization_id, key, name, status) values
    ('${ID.ROLE_B_ADMIN}', '${ID.ORG_B}', 'admin', 'Admin', 'active'),
    ('${ID.ROLE_B_RECRUITER}', '${ID.ORG_B}', 'recruiter', 'Recruiter', 'active');
insert into app.organization_memberships (id, organization_id, user_id, role_id, status, activated_at) values
    ('${ID.MEMBER_A_ADMIN}', '${ID.ORG_A}', '${ID.USER_1}', '${ID.ROLE_A_ADMIN}', 'active', now()),
    ('${ID.MEMBER_B_RECRUITER}', '${ID.ORG_B}', '${ID.USER_1}', '${ID.ROLE_B_RECRUITER}', 'active', now());
insert into app.clients (id, organization_id, name, status) values
    ('${ID.CLIENT_A}', '${ID.ORG_A}', 'Client A', 'active'),
    ('${ID.CLIENT_B}', '${ID.ORG_B}', 'Client B', 'active');
insert into app.pipelines (id, organization_id, key, name, status) values
    ('${ID.PIPELINE_B}', '${ID.ORG_B}', 'main', 'Main', 'active'),
    ('${ID.PIPELINE_A_SECOND}', '${ID.ORG_A}', 'secondary', 'Secondary', 'active');
insert into app.pipeline_stages (id, organization_id, pipeline_id, key, label, kind, position, is_initial) values
    ('${ID.STAGE_B_REVIEW}', '${ID.ORG_B}', '${ID.PIPELINE_B}', 'review', 'Review', 'active', 0, true),
    ('${ID.STAGE_B_SECOND}', '${ID.ORG_B}', '${ID.PIPELINE_B}', 'screen', 'Screen', 'active', 1, false),
    ('${ID.STAGE_A_SECOND}', '${ID.ORG_A}', '${ID.PIPELINE_A_SECOND}', 'screen', 'Screen', 'active', 0, true);
insert into app.jobs (id, organization_id, client_id, pipeline_id, slug, title, description,
        location_display, employment_type, publication_state, application_state) values
    ('${ID.JOB_A}', '${ID.ORG_A}', '${ID.CLIENT_A}', '${ID.PIPELINE_A}', 'foundation-test-job-a',
        'Engineer', 'Description', 'Remote', 'full_time', 'draft', 'open'),
    ('${ID.JOB_B}', '${ID.ORG_B}', '${ID.CLIENT_B}', '${ID.PIPELINE_B}', 'foundation-test-job-b',
        'Engineer B', 'Description', 'Remote', 'contract', 'draft', 'open');
insert into app.candidates (id, organization_id, full_name, owner_membership_id, identity_state, lifecycle) values
    ('${ID.CAND_A}', '${ID.ORG_A}', 'Candidate A', '${ID.MEMBER_A_ADMIN}', 'established', 'active'),
    ('${ID.CAND_A2}', '${ID.ORG_A}', 'Candidate A2', null, 'provisional', 'active'),
    ('${ID.CAND_B}', '${ID.ORG_B}', 'Candidate B', null, 'established', 'active');
insert into app.candidate_sources (id, organization_id, candidate_id, kind, received_at) values
    ('${ID.SOURCE_A}', '${ID.ORG_A}', '${ID.CAND_A}', 'manual', now()),
    ('${ID.SOURCE_A2}', '${ID.ORG_A}', '${ID.CAND_A2}', 'referral', now()),
    ('${ID.SOURCE_B}', '${ID.ORG_B}', '${ID.CAND_B}', 'public_application', now());
insert into app.candidate_identifiers (id, organization_id, candidate_id, kind, raw_value,
        normalized_value, normalization_version, verification, received_at) values
    ('${uuid(90)}', '${ID.ORG_A}', '${ID.CAND_A}', 'email', 'Dup@Example.com', 'dup@example.com', 1, 'unverified', now()),
    ('${uuid(91)}', '${ID.ORG_B}', '${ID.CAND_B}', 'email', 'Dup@Example.com', 'dup@example.com', 1, 'unverified', now()),
    ('${uuid(92)}', '${ID.ORG_A}', '${ID.CAND_A2}', 'email', 'dup@example.com', 'dup@example.com', 1, 'unverified', now());
insert into app.applications (id, organization_id, candidate_id, job_id, pipeline_id, stage_id,
        public_reference, reference_version, source_id, received_at) values
    ('${ID.APP_A1}', '${ID.ORG_A}', '${ID.CAND_A}', '${ID.JOB_A}', '${ID.PIPELINE_A}',
        '${ID.STAGE_A_REVIEW}', 'AG-0000AAAABBBB', 1, '${ID.SOURCE_A}', now()),
    ('${ID.APP_A2}', '${ID.ORG_A}', '${ID.CAND_A}', '${ID.JOB_A}', '${ID.PIPELINE_A}',
        '${ID.STAGE_A_REVIEW}', 'AG-0000AAAABBBD', 1, null, now()),
    ('${ID.APP_A3}', '${ID.ORG_A}', '${ID.CAND_A}', '${ID.JOB_A}', '${ID.PIPELINE_A}',
        '${ID.STAGE_A_REVIEW}', 'AG-0000AAAABBBB0000AAAABBBD', 2, null, now());
insert into app.application_stage_history (id, organization_id, application_id, sequence,
        to_pipeline_id, to_stage_id, actor_kind, occurred_at) values
    ('${uuid(102)}', '${ID.ORG_A}', '${ID.APP_A1}', 1,
        '${ID.PIPELINE_A}', '${ID.STAGE_A_REVIEW}', 'intake', now());
insert into app.application_stage_history (id, organization_id, application_id, sequence,
        from_pipeline_id, from_stage_id, to_pipeline_id, to_stage_id,
        actor_membership_id, actor_kind, reason, occurred_at) values
    ('${uuid(103)}', '${ID.ORG_A}', '${ID.APP_A1}', 2,
        '${ID.PIPELINE_A}', '${ID.STAGE_A_REVIEW}', '${ID.PIPELINE_A}', '${ID.STAGE_A_SCREEN}',
        '${ID.MEMBER_A_ADMIN}', 'staff', 'progressed', now());
insert into app.auth_identities (id, user_id, provider, issuer, provider_subject, verified_at, revoked_at) values
    ('${ID.IDENTITY_REVOKED}', '${ID.USER_1}', 'github', 'https://github.com', 'subject-1', now(), now());
`;

const SHAPE_QUERIES = [
    `select c.relname, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     join pg_attribute a on a.attrelid = c.oid
     where n.nspname = 'app' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
     order by c.relname, a.attnum`,
    `select con.conname, con.contype, pg_get_constraintdef(con.oid)
     from pg_constraint con
     join pg_class c on c.oid = con.conrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'app'
     order by con.conname`,
    `select indexname, indexdef from pg_indexes where schemaname = 'app' order by indexname`,
];

const NO_NON_OWNER_GRANTEE_SQL = `
    select coalesce(bool_or(g.grantee_name is distinct from 'app_owner'), false)
    from (
        select grantee_role.rolname as grantee_name
        from pg_catalog.pg_namespace n
        cross join lateral aclexplode(n.nspacl) acl
        left join pg_catalog.pg_roles grantee_role on grantee_role.oid = acl.grantee
        where n.nspname = 'app'
        union all
        select grantee_role.rolname
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        cross join lateral aclexplode(
            coalesce(c.relacl, acldefault(
                (case when c.relkind = 'S' then 's' else 'r' end)::"char", c.relowner
            ))
        ) acl
        left join pg_catalog.pg_roles grantee_role on grantee_role.oid = acl.grantee
        where n.nspname = 'app' and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
    ) g
`;

const FORCED_RLS_COUNT_SQL = `
    select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app' and c.relkind = 'r'
        and (not c.relrowsecurity or not c.relforcerowsecurity)
`;

const APP_TABLE_OWNER_SQL = `
    select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app' and c.relkind = 'r' and c.relowner <> 'app_owner'::regrole
`;

const EXPECTED_ROLE_GRANTS = {
    admin: [
        'applications.read', 'applications.stage', 'audit.read', 'candidates.merge',
        'candidates.read', 'candidates.write', 'clients.read', 'clients.write',
        'collaboration.read', 'collaboration.write', 'data.export', 'documents.download',
        'documents.write', 'duplicates.review', 'jobs.read', 'jobs.write',
        'organization.manage', 'pipelines.manage', 'privacy.manage', 'roles.manage',
        'staff.manage',
    ],
    recruiter: [
        'applications.read', 'applications.stage', 'candidates.read', 'candidates.write',
        'clients.read', 'clients.write', 'collaboration.read', 'collaboration.write',
        'documents.download', 'documents.write', 'duplicates.review', 'jobs.read',
        'jobs.write',
    ],
    viewer: [
        'applications.read', 'candidates.read', 'clients.read', 'collaboration.read',
        'jobs.read',
    ],
};

const scalar = (container, sql, options) => psql(container, sql, options).trim();
const lastLine = (container, sql, options) => scalar(container, sql, options).split('\n').pop();

const lockCountSql = (table, applicationName) => `
    select count(*)
    from pg_locks lock_entry
    join pg_stat_activity backend on backend.pid = lock_entry.pid
    where lock_entry.relation = '${table}'::regclass
        and lock_entry.mode = 'AccessExclusiveLock'
        and lock_entry.granted
        and backend.application_name = '${applicationName}'
`;

async function waitForTableLock(container, table, applicationName) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        if (scalar(container, lockCountSql(table, applicationName)) === '1') {
            return;
        }
        await sleep(100);
    }
    throw new Error(`Access exclusive lock on ${table} was not acquired.`);
}

async function releaseLock(container, holder) {
    scalar(container, `
        select count(*)
        from (
            select pg_terminate_backend(pid)
            from pg_stat_activity
            where application_name = '${holder.applicationName}'
        ) terminated
    `);
    await awaitProcessExit(holder.child);
}

function applyMigration(container, fileName, timings, options = {}) {
    const startedAt = performance.now();
    psql(container, readMigration(fileName), options);
    timings[fileName] = Math.round(performance.now() - startedAt);
}

test('foundation migrations on plain PostgreSQL', { skip: mode !== 'postgres' }, async (t) => {
    assertLocalTestEnvironment();

    await t.test('PostgreSQL 17 foundation lifecycle', async (t) => {
        const pg = await startPostgresContainer('pg17', POSTGRES_17_IMAGE);
        t.after(() => stopAndRemoveContainer(pg));
        const pgSecond = await startPostgresContainer('pg17b', POSTGRES_17_IMAGE);
        t.after(() => stopAndRemoveContainer(pgSecond));
        const timings = {};

        psql(pg, `
            create table public.applicants (id bigint primary key, note text);
            insert into public.applicants values (1, 'legacy row');
        `);
        const legacyLocker = holdExclusiveLock(pg, 'public.applicants', 60);
        await waitForTableLock(pg, 'public.applicants', legacyLocker.applicationName);

        try {
            await t.test('migrations apply while a legacy table lock is held', () => {
                for (const fileName of FOUNDATION_MIGRATIONS) {
                    applyMigration(pg, fileName, timings);
                }
                t.diagnostic(`migration timings ms: ${JSON.stringify(timings)}`);
            });
            assert.equal(
                scalar(pg, lockCountSql('public.applicants', legacyLocker.applicationName)),
                '1',
            );
        } finally {
            await releaseLock(pg, legacyLocker);
        }

        await t.test('seeded catalog and defaults match the approved matrix', () => {
            assert.equal(scalar(pg, `select count(*) from app.organizations`), '1');
            assert.equal(scalar(pg, `select count(*) from app.permissions`), '21');
            assert.equal(scalar(pg, `select count(*) from app.roles`), '3');
            assert.equal(scalar(pg, `select count(*) from app.role_permissions`), '39');
            assert.equal(scalar(pg, `select count(*) from app.pipelines`), '1');
            assert.equal(scalar(pg, `select count(*) from app.pipeline_stages`), '6');
            assert.equal(scalar(pg, `select status from app.roles where id = '${ID.ROLE_A_VIEWER}'`), 'inactive');
            assert.equal(
                scalar(pg, `select string_agg(key || ':' || status || ':' || coalesce(system_kind, ''), ','
                    order by key) from app.roles`),
                'admin:active:admin,recruiter:active:recruiter,viewer:inactive:viewer',
            );
            assert.equal(
                scalar(pg, `select count(*) from app.pipeline_stages
                    where is_initial and archived_at is null`),
                '1',
            );
            for (const [roleKey, grantKeys] of Object.entries(EXPECTED_ROLE_GRANTS)) {
                assert.equal(
                    scalar(pg, `
                        select string_agg(rp.permission_key, ',' order by rp.permission_key)
                        from app.role_permissions rp
                        join app.roles r
                            on r.organization_id = rp.organization_id and r.id = rp.role_id
                        where r.organization_id = '${ID.ORG_A}' and r.key = '${roleKey}'
                    `),
                    [...grantKeys].sort().join(','),
                    `grant matrix mismatch for role ${roleKey}`,
                );
            }
        });

        await t.test('legacy data is untouched and still writable', () => {
            assert.equal(scalar(pg, `select note from public.applicants where id = 1`), 'legacy row');
            psql(pg, `insert into public.applicants values (2, 'still works');`);
            assert.equal(scalar(pg, `select count(*) from public.applicants`), '2');
        });

        await t.test('schema DDL is versioned and cannot be reapplied', () => {
            assertSqlstate(pg, readMigration(FOUNDATION_MIGRATIONS[1]), '42P06');
        });

        await t.test('identical ordered migrations produce identical schema on a clean instance', () => {
            for (const fileName of FOUNDATION_MIGRATIONS) {
                applyMigration(pgSecond, fileName, {});
            }
            for (const query of SHAPE_QUERIES) {
                assert.equal(psql(pgSecond, query), psql(pg, query));
            }
        });

        await t.test('seed rerun preserves counts and administrator edits', () => {
            psql(pg, `
                update app.organizations set name = 'Agora Renamed' where key = 'agora';
                update app.roles set name = 'Admin Renamed' where id = '${ID.ROLE_A_ADMIN}';
                update app.roles set status = 'inactive' where id = '${ID.ROLE_A_RECRUITER}';
                update app.pipelines set name = 'Renamed pipeline' where id = '${ID.PIPELINE_A}';
                update app.pipeline_stages set label = 'Renamed review' where id = '${ID.STAGE_A_REVIEW}';
                delete from app.pipeline_stages where id = '${ID.STAGE_A_REJECTED}';
                delete from app.role_permissions
                    where role_id = '${ID.ROLE_A_RECRUITER}' and permission_key = 'jobs.write';
            `);
            psql(pg, readMigration(FOUNDATION_MIGRATIONS[2]));
            assert.equal(scalar(pg, `select name from app.organizations where key = 'agora'`), 'Agora Renamed');
            assert.equal(scalar(pg, `select name from app.roles where id = '${ID.ROLE_A_ADMIN}'`), 'Admin Renamed');
            assert.equal(scalar(pg, `select status from app.roles where id = '${ID.ROLE_A_RECRUITER}'`), 'inactive');
            assert.equal(scalar(pg, `select name from app.pipelines where id = '${ID.PIPELINE_A}'`), 'Renamed pipeline');
            assert.equal(scalar(pg, `select label from app.pipeline_stages where id = '${ID.STAGE_A_REVIEW}'`), 'Renamed review');
            assert.equal(scalar(pg, `select count(*) from app.pipeline_stages where id = '${ID.STAGE_A_REJECTED}'`), '0');
            assert.equal(
                scalar(pg, `select count(*) from app.role_permissions
                    where role_id = '${ID.ROLE_A_RECRUITER}' and permission_key = 'jobs.write'`),
                '0',
            );
            assert.equal(scalar(pg, `select count(*) from app.roles`), '3');
            assert.equal(scalar(pg, `select count(*) from app.pipeline_stages`), '5');
            assert.equal(scalar(pg, `select count(*) from app.role_permissions`), '38');
            assert.equal(scalar(pg, `select count(*) from app.permissions`), '21');
        });

        await t.test('valid cross-org fixture: one user Admin in A, Recruiter in B', () => {
            psql(pg, fixtureSql);
            assert.equal(
                scalar(pg, `select string_agg(r.key, ',' order by r.key)
                    from app.organization_memberships m
                    join app.roles r on r.organization_id = m.organization_id and r.id = m.role_id
                    where m.user_id = '${ID.USER_1}'`),
                'admin,recruiter',
            );
            assert.equal(scalar(pg, `select count(*) from app.candidate_identifiers
                where kind = 'email' and normalized_value = 'dup@example.com'`), '3');
            assert.equal(scalar(pg, `select count(distinct candidate_id) from app.candidate_identifiers
                where organization_id = '${ID.ORG_A}' and kind = 'email'
                    and normalized_value = 'dup@example.com'`), '2');
            assert.equal(scalar(pg, `select count(*) from app.applications
                where candidate_id = '${ID.CAND_A}' and job_id = '${ID.JOB_A}'`), '3');
        });

        await t.test('cross-organization foreign keys are rejected (23503)', () => {
            const cases = [
                `insert into app.organization_memberships (id, organization_id, user_id, role_id, status)
                 values ('${uuid(200)}', '${ID.ORG_A}', '${ID.USER_2}', '${ID.ROLE_B_RECRUITER}', 'invited')`,
                `insert into app.role_permissions (organization_id, role_id, permission_key)
                 values ('${ID.ORG_A}', '${ID.ROLE_B_RECRUITER}', 'clients.read')`,
                `insert into app.jobs (id, organization_id, client_id, pipeline_id, slug, title, description,
                    location_display, employment_type, publication_state, application_state)
                 values ('${uuid(201)}', '${ID.ORG_A}', '${ID.CLIENT_B}', '${ID.PIPELINE_A}',
                    'cross-client', 'T', 'D', 'L', 'E', 'draft', 'open')`,
                `insert into app.jobs (id, organization_id, client_id, pipeline_id, slug, title, description,
                    location_display, employment_type, publication_state, application_state)
                 values ('${uuid(202)}', '${ID.ORG_A}', '${ID.CLIENT_A}', '${ID.PIPELINE_B}',
                    'cross-pipeline', 'T', 'D', 'L', 'E', 'draft', 'open')`,
                `insert into app.jobs (id, organization_id, client_id, pipeline_id, owner_membership_id, slug,
                    title, description, location_display, employment_type, publication_state, application_state)
                 values ('${uuid(203)}', '${ID.ORG_A}', '${ID.CLIENT_A}', '${ID.PIPELINE_A}', '${ID.MEMBER_B_RECRUITER}',
                    'cross-owner', 'T', 'D', 'L', 'E', 'draft', 'open')`,
                `insert into app.jobs (id, organization_id, client_id, pipeline_id, publication_reviewed_by, slug,
                    title, description, location_display, employment_type, publication_state, application_state)
                 values ('${uuid(204)}', '${ID.ORG_A}', '${ID.CLIENT_A}', '${ID.PIPELINE_A}', '${ID.MEMBER_B_RECRUITER}',
                    'cross-reviewer', 'T', 'D', 'L', 'E', 'draft', 'open')`,
                `insert into app.candidates (id, organization_id, owner_membership_id, identity_state, lifecycle)
                 values ('${uuid(205)}', '${ID.ORG_A}', '${ID.MEMBER_B_RECRUITER}', 'provisional', 'active')`,
                `insert into app.candidates (id, organization_id, identity_state, lifecycle, merged_into_id)
                 values ('${uuid(206)}', '${ID.ORG_A}', 'provisional', 'merged', '${ID.CAND_B}')`,
                `insert into app.candidate_identifiers (id, organization_id, candidate_id, kind, raw_value,
                    normalization_version, verification, source_id, received_at)
                 values ('${uuid(207)}', '${ID.ORG_A}', '${ID.CAND_A}', 'email', 'x@example.invalid', 1,
                    'unverified', '${ID.SOURCE_A2}', now())`,
                `insert into app.candidate_sources (id, organization_id, candidate_id, kind, received_at,
                    created_by_membership_id)
                 values ('${uuid(208)}', '${ID.ORG_A}', '${ID.CAND_A}', 'manual', now(), '${ID.MEMBER_B_RECRUITER}')`,
                `insert into app.candidate_sources (id, organization_id, candidate_id, kind, received_at)
                 values ('${uuid(217)}', '${ID.ORG_A}', '${ID.CAND_B}', 'manual', now())`,
                `insert into app.candidate_identifiers (id, organization_id, candidate_id, kind, raw_value,
                    normalization_version, verification, received_at)
                 values ('${uuid(218)}', '${ID.ORG_A}', '${ID.CAND_B}', 'email', 'y@example.invalid', 1,
                    'unverified', now())`,
                `insert into app.pipeline_stages (id, organization_id, pipeline_id, key, label, kind, position)
                 values ('${uuid(209)}', '${ID.ORG_A}', '${ID.PIPELINE_B}', 'x', 'X', 'active', 9)`,
                `insert into app.applications (id, organization_id, candidate_id, job_id, pipeline_id, stage_id,
                    public_reference, reference_version, received_at)
                 values ('${uuid(210)}', '${ID.ORG_A}', '${ID.CAND_B}', '${ID.JOB_A}', '${ID.PIPELINE_A}',
                    '${ID.STAGE_A_REVIEW}', 'AG-1000AAAABBBB', 1, now())`,
                `insert into app.applications (id, organization_id, candidate_id, job_id, pipeline_id, stage_id,
                    public_reference, reference_version, received_at)
                 values ('${uuid(211)}', '${ID.ORG_A}', '${ID.CAND_A}', '${ID.JOB_B}', '${ID.PIPELINE_A}',
                    '${ID.STAGE_A_REVIEW}', 'AG-2000AAAABBBB', 1, now())`,
                `insert into app.applications (id, organization_id, candidate_id, job_id, pipeline_id, stage_id,
                    public_reference, reference_version, received_at)
                 values ('${uuid(212)}', '${ID.ORG_A}', '${ID.CAND_A}', '${ID.JOB_A}', '${ID.PIPELINE_A}',
                    '${ID.STAGE_A_SECOND}', 'AG-3000AAAABBBB', 1, now())`,
                `insert into app.applications (id, organization_id, candidate_id, job_id, pipeline_id, stage_id,
                    public_reference, reference_version, source_id, received_at)
                 values ('${uuid(213)}', '${ID.ORG_A}', '${ID.CAND_A}', '${ID.JOB_A}', '${ID.PIPELINE_A}',
                    '${ID.STAGE_A_REVIEW}', 'AG-4000AAAABBBB', 1, '${ID.SOURCE_A2}', now())`,
                `insert into app.application_stage_history (id, organization_id, application_id, sequence,
                    from_pipeline_id, from_stage_id, to_pipeline_id, to_stage_id, actor_kind, occurred_at)
                 values ('${uuid(214)}', '${ID.ORG_A}', '${ID.APP_A2}', 2,
                    '${ID.PIPELINE_A}', '${ID.STAGE_A_SECOND}', '${ID.PIPELINE_A}', '${ID.STAGE_A_SCREEN}',
                    'migration', now())`,
                `insert into app.application_stage_history (id, organization_id, application_id, sequence,
                    from_pipeline_id, from_stage_id, to_pipeline_id, to_stage_id, actor_kind, occurred_at)
                 values ('${uuid(215)}', '${ID.ORG_A}', '${ID.APP_A2}', 2,
                    '${ID.PIPELINE_A}', '${ID.STAGE_A_REVIEW}', '${ID.PIPELINE_A}', '${ID.STAGE_A_SECOND}',
                    'migration', now())`,
                `insert into app.application_stage_history (id, organization_id, application_id, sequence,
                    from_pipeline_id, from_stage_id, to_pipeline_id, to_stage_id,
                    actor_membership_id, actor_kind, occurred_at)
                 values ('${uuid(216)}', '${ID.ORG_A}', '${ID.APP_A2}', 2,
                    '${ID.PIPELINE_A}', '${ID.STAGE_A_REVIEW}', '${ID.PIPELINE_A}', '${ID.STAGE_A_SCREEN}',
                    '${ID.MEMBER_B_RECRUITER}', 'staff', now())`,
            ];
            for (const sql of cases) {
                assertSqlstate(pg, sql, '23503');
            }
        });

        await t.test('uniqueness is enforced (23505)', () => {
            const cases = [
                `insert into app.jobs (id, organization_id, client_id, pipeline_id, slug, title, description,
                    location_display, employment_type, publication_state, application_state)
                 values ('${uuid(300)}', '${ID.ORG_B}', '${ID.CLIENT_B}', '${ID.PIPELINE_B}',
                    'foundation-test-job-a', 'T', 'D', 'L', 'E', 'draft', 'open')`,
                `insert into app.applications (id, organization_id, candidate_id, job_id, pipeline_id, stage_id,
                    public_reference, reference_version, received_at)
                 values ('${uuid(301)}', '${ID.ORG_A}', '${ID.CAND_A}', '${ID.JOB_A}', '${ID.PIPELINE_A}',
                    '${ID.STAGE_A_REVIEW}', 'AG-0000AAAABBBB', 1, now())`,
                `insert into app.auth_identities (id, user_id, provider, issuer, provider_subject, verified_at)
                 values ('${uuid(302)}', '${ID.USER_2}', 'github', 'https://github.com', 'subject-1', now())`,
                `insert into app.roles (id, organization_id, key, name, status)
                 values ('${uuid(303)}', '${ID.ORG_A}', 'admin', 'Another Admin', 'active')`,
                `insert into app.pipeline_stages (id, organization_id, pipeline_id, key, label, kind, position, is_initial)
                 values ('${uuid(304)}', '${ID.ORG_A}', '${ID.PIPELINE_A}', 'second-initial', 'Second', 'active', 9, true)`,
                `insert into app.roles (id, organization_id, key, name, status, system_kind)
                 values ('${uuid(305)}', '${ID.ORG_A}', 'second-admin', 'Second Admin', 'active', 'admin')`,
            ];
            for (const sql of cases) {
                assertSqlstate(pg, sql, '23505');
            }
        });

        await t.test('check constraints reject invalid values (23514)', () => {
            const cases = [
                `insert into app.organizations (id, key, name, status, version)
                 values ('${uuid(400)}', 'zero-version', 'X', 'active', 0)`,
                `insert into app.organizations (id, key, name, status)
                 values ('${uuid(401)}', 'bad-status', 'X', 'bogus')`,
                `insert into app.applications (id, organization_id, candidate_id, job_id, pipeline_id, stage_id,
                    public_reference, reference_version, received_at)
                 values ('${uuid(402)}', '${ID.ORG_A}', '${ID.CAND_A}', '${ID.JOB_A}', '${ID.PIPELINE_A}',
                    '${ID.STAGE_A_REVIEW}', 'AG-5000AAAABBBB', 3, now())`,
                `insert into app.applications (id, organization_id, candidate_id, job_id, pipeline_id, stage_id,
                    public_reference, reference_version, received_at)
                 values ('${uuid(403)}', '${ID.ORG_A}', '${ID.CAND_A}', '${ID.JOB_A}', '${ID.PIPELINE_A}',
                    '${ID.STAGE_A_REVIEW}', 'AG-xyz', 1, now())`,
                `insert into app.applications (id, organization_id, candidate_id, job_id, pipeline_id, stage_id,
                    public_reference, reference_version, received_at)
                 values ('${uuid(404)}', '${ID.ORG_A}', '${ID.CAND_A}', '${ID.JOB_A}', '${ID.PIPELINE_A}',
                    '${ID.STAGE_A_REVIEW}', 'AG-0000AAAABBBC', 2, now())`,
                `insert into app.organization_memberships (id, organization_id, user_id, role_id, status)
                 values ('${uuid(405)}', '${ID.ORG_A}', '${ID.USER_2}', '${ID.ROLE_A_RECRUITER}', 'active')`,
                `insert into app.organization_memberships (id, organization_id, user_id, role_id, status, activated_at)
                 values ('${uuid(406)}', '${ID.ORG_A}', '${ID.USER_2}', '${ID.ROLE_A_RECRUITER}', 'revoked', now())`,
                `insert into app.candidate_identifiers (id, organization_id, candidate_id, kind, raw_value,
                    normalization_version, verification, received_at)
                 values ('${uuid(407)}', '${ID.ORG_A}', '${ID.CAND_A}', 'email', 'v@example.invalid', 1,
                    'verified', now())`,
                `insert into app.candidate_identifiers (id, organization_id, candidate_id, kind, raw_value,
                    normalization_version, verification, received_at)
                 values ('${uuid(408)}', '${ID.ORG_A}', '${ID.CAND_A}', 'email', 'w@example.invalid', 0,
                    'unverified', now())`,
                `insert into app.pipeline_stages (id, organization_id, pipeline_id, key, label, kind, position)
                 values ('${uuid(409)}', '${ID.ORG_A}', '${ID.PIPELINE_A}', 'neg', 'Neg', 'active', -1)`,
                `insert into app.jobs (id, organization_id, client_id, pipeline_id, slug, title, description,
                    location_display, employment_type, publication_state, application_state, published_at)
                 values ('${uuid(410)}', '${ID.ORG_A}', '${ID.CLIENT_A}', '${ID.PIPELINE_A}',
                    'bad-published', 'T', 'D', 'L', 'E', 'published', 'open', now())`,
                `insert into app.candidates (id, organization_id, identity_state, lifecycle)
                 values ('${uuid(411)}', '${ID.ORG_A}', 'provisional', 'merged')`,
                `insert into app.candidates (id, organization_id, identity_state, lifecycle, merged_into_id)
                 values ('${uuid(412)}', '${ID.ORG_A}', 'provisional', 'active', '${ID.CAND_A}')`,
                `insert into app.candidates (id, organization_id, identity_state, lifecycle, merged_into_id)
                 values ('${uuid(413)}', '${ID.ORG_A}', 'provisional', 'merged', '${uuid(413)}')`,
                `insert into app.candidates (id, organization_id, identity_state, lifecycle)
                 values ('${uuid(414)}', '${ID.ORG_A}', 'provisional', 'bogus')`,
                `insert into app.application_stage_history (id, organization_id, application_id, sequence,
                    to_pipeline_id, to_stage_id, actor_kind, occurred_at)
                 values ('${uuid(415)}', '${ID.ORG_A}', '${ID.APP_A2}', 0,
                    '${ID.PIPELINE_A}', '${ID.STAGE_A_REVIEW}', 'intake', now())`,
                `insert into app.application_stage_history (id, organization_id, application_id, sequence,
                    to_pipeline_id, to_stage_id, actor_kind, occurred_at)
                 values ('${uuid(416)}', '${ID.ORG_A}', '${ID.APP_A2}', 2,
                    '${ID.PIPELINE_A}', '${ID.STAGE_A_SCREEN}', 'migration', now())`,
                `insert into app.application_stage_history (id, organization_id, application_id, sequence,
                    from_pipeline_id, from_stage_id, to_pipeline_id, to_stage_id, actor_kind, occurred_at)
                 values ('${uuid(417)}', '${ID.ORG_A}', '${ID.APP_A2}', 1,
                    '${ID.PIPELINE_A}', '${ID.STAGE_A_REVIEW}', '${ID.PIPELINE_A}', '${ID.STAGE_A_SCREEN}',
                    'intake', now())`,
                `insert into app.application_stage_history (id, organization_id, application_id, sequence,
                    from_pipeline_id, from_stage_id, to_pipeline_id, to_stage_id, actor_kind, occurred_at)
                 values ('${uuid(418)}', '${ID.ORG_A}', '${ID.APP_A2}', 2,
                    '${ID.PIPELINE_A}', '${ID.STAGE_A_REVIEW}', '${ID.PIPELINE_A}', '${ID.STAGE_A_SCREEN}',
                    'staff', now())`,
                `insert into app.application_stage_history (id, organization_id, application_id, sequence,
                    from_pipeline_id, to_pipeline_id, to_stage_id, actor_kind, occurred_at)
                 values ('${uuid(419)}', '${ID.ORG_A}', '${ID.APP_A2}', 2,
                    '${ID.PIPELINE_A}', '${ID.PIPELINE_A}', '${ID.STAGE_A_SCREEN}',
                    'migration', now())`,
            ];
            for (const sql of cases) {
                assertSqlstate(pg, sql, '23514');
            }
        });

        await t.test('deferrable same-candidate source FK commits only when satisfied', () => {
            const plannedSource = uuid(500);
            psql(pg, `
                begin;
                set constraints all deferred;
                insert into app.applications (id, organization_id, candidate_id, job_id, pipeline_id, stage_id,
                    public_reference, reference_version, source_id, received_at)
                values ('${uuid(501)}', '${ID.ORG_A}', '${ID.CAND_A}', '${ID.JOB_A}', '${ID.PIPELINE_A}',
                    '${ID.STAGE_A_REVIEW}', 'AG-6000AAAABBBB', 1, '${plannedSource}', now());
                insert into app.candidate_sources (id, organization_id, candidate_id, kind, received_at)
                values ('${plannedSource}', '${ID.ORG_A}', '${ID.CAND_A}', 'manual', now());
                commit;
            `);
            assertSqlstate(pg, `
                begin;
                set constraints all deferred;
                insert into app.applications (id, organization_id, candidate_id, job_id, pipeline_id, stage_id,
                    public_reference, reference_version, source_id, received_at)
                values ('${uuid(502)}', '${ID.ORG_A}', '${ID.CAND_A}', '${ID.JOB_A}', '${ID.PIPELINE_A}',
                    '${ID.STAGE_A_REVIEW}', 'AG-7000AAAABBBB', 1, '${uuid(503)}', now());
                commit;
            `, '23503');
        });

        await t.test('runtime and internal roles cannot reach the app schema', () => {
            const roles = ['app_staff', 'app_intake', 'app_worker', 'app_executor', 'app_authz_reader'];
            const statements = [
                'select count(*) from app.candidates',
                `insert into app.candidates (id, organization_id, identity_state, lifecycle)
                 values ('${uuid(600)}', '${ID.ORG_A}', 'provisional', 'active')`,
                `update app.candidates set full_name = 'x' where id = '${ID.CAND_A}'`,
                `delete from app.candidates where id = '${ID.CAND_A}'`,
            ];
            for (const role of roles) {
                for (const statement of statements) {
                    assertSqlstate(pg, `set role ${role}; ${statement};`, '42501');
                }
            }
        });

        await t.test('catalog: forced RLS, app_owner ownership and no public or runtime grants', () => {
            assert.equal(scalar(pg, `
                select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'app' and c.relkind = 'r'
            `), '16');
            assert.equal(scalar(pg, `
                select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'app' and c.relkind = 'r'
                    and (not c.relrowsecurity or not c.relforcerowsecurity)
            `), '0');
            assert.equal(scalar(pg, `
                select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'app' and c.relkind = 'r' and c.relowner <> 'app_owner'::regrole
            `), '0');
            assert.equal(scalar(pg, `
                select coalesce(bool_or(a.grantee = 0), false)
                from pg_catalog.pg_namespace n
                cross join lateral aclexplode(n.nspacl) a
                where n.nspname = 'app'
            `), 'f');
            assert.equal(scalar(pg, NO_NON_OWNER_GRANTEE_SQL), 'f');
            assert.equal(scalar(pg, `select has_schema_privilege('app_staff', 'app', 'usage')`), 'f');
            assert.equal(scalar(pg, `select has_table_privilege('app_staff', 'app.candidates', 'select')`), 'f');
            assert.equal(scalar(pg, `
                select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'app'
            `), '0');
            assert.equal(scalar(pg, `
                select count(*) from pg_namespace
                where nspname = any(array['auth', 'storage', 'realtime', 'graphql', 'graphql_public',
                    'vault', 'supabase_functions', 'extensions'])
            `), '0');
            assert.equal(scalar(pg, `
                select count(*) from pg_roles
                where rolname = any(array['app_owner', 'app_staff', 'app_intake', 'app_worker',
                    'app_executor', 'app_authz_reader'])
                    and (rolsuper or rolcreaterole or rolcreatedb or rolcanlogin
                        or rolreplication or rolbypassrls)
            `), '0');
            assert.equal(scalar(pg, `
                select count(*) from pg_auth_members m
                join pg_roles member_role on member_role.oid = m.member
                where member_role.rolname = any(array['app_owner', 'app_staff', 'app_intake',
                    'app_worker', 'app_executor', 'app_authz_reader'])
            `), '0');
            assert.equal(scalar(pg, `
                select count(*) from pg_auth_members m
                join pg_roles parent_role on parent_role.oid = m.roleid
                join pg_roles member_role on member_role.oid = m.member
                where parent_role.rolname in ('app_owner', 'app_executor', 'app_authz_reader')
                    and member_role.rolname <> 'postgres'
            `), '0');
        });

        await t.test('new app functions grant no PUBLIC or runtime EXECUTE by default', () => {
            assert.equal(lastLine(pg, `
                begin;
                set local role app_owner;
                create function app.foundation_acl_probe() returns integer language sql as 'select 1';
                select
                    coalesce(bool_or(acl.grantee = 0 and acl.privilege_type = 'EXECUTE'), false)
                    or coalesce(bool_or(has_function_privilege(runtime_role.rolname,
                        'app.foundation_acl_probe()', 'EXECUTE')), false)
                from pg_proc p
                cross join lateral aclexplode(
                    coalesce(p.proacl, acldefault('f', p.proowner))
                ) acl
                cross join (
                    values ('app_staff'), ('app_intake'), ('app_worker'),
                        ('app_executor'), ('app_authz_reader')
                ) runtime_role(rolname)
                where p.oid = 'app.foundation_acl_probe()'::regprocedure
                group by p.oid;
                rollback;
            `), 'f');
            assert.equal(scalar(pg, `
                select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'app'
            `), '0');
        });

        await t.test('lock_timeout bounds a blocked statement and rolls back atomically', async () => {
            psql(pg, `create table public.lock_target (id integer);`);
            const locker = holdExclusiveLock(pg, 'public.lock_target', 15);
            await waitForTableLock(pg, 'public.lock_target', locker.applicationName);
            try {
                const stderr = psqlExpectError(pg, `
                    begin;
                    set local lock_timeout = '1s';
                    create table public.rollback_probe (id integer);
                    lock table public.lock_target in access exclusive mode;
                    commit;
                `);
                assert.match(stderr, /55P03/);
                assert.equal(scalar(pg, `select to_regclass('public.rollback_probe')`), '');
            } finally {
                await releaseLock(pg, locker);
            }
        });
    });

    await t.test('PostgreSQL 16 is rejected before any change', async (t) => {
        const pg16 = await startPostgresContainer('pg16', POSTGRES_16_IMAGE);
        t.after(() => stopAndRemoveContainer(pg16));
        const stderr = psqlExpectError(pg16, readMigration(FOUNDATION_MIGRATIONS[0]));
        assert.match(stderr, /PostgreSQL 17/);
        assert.equal(scalar(pg16, `select count(*) from pg_roles where rolname like 'app\\_%'`), '0');
        assert.equal(
            scalar(pg16, `select count(*) from information_schema.schemata where schema_name = 'app'`),
            '0',
        );
    });

    await t.test('pre-existing foundation role membership is rejected and rolls back', async (t) => {
        const pgMember = await startPostgresContainer('pgmember', POSTGRES_17_IMAGE);
        t.after(() => stopAndRemoveContainer(pgMember));
        psql(pgMember, `
            create role intermediary_parent nologin;
            create role app_staff nologin;
            grant intermediary_parent to app_staff;
        `);
        const stderr = psqlExpectError(pgMember, readMigration(FOUNDATION_MIGRATIONS[0]));
        assert.match(stderr, /must not hold membership/);
        assert.equal(scalar(pgMember, `select count(*) from pg_roles where rolname = 'app_worker'`), '0');
        assert.equal(scalar(pgMember, `select count(*) from pg_roles where rolname = 'app_staff'`), '1');
    });

    await t.test('pre-existing dangerous role attributes are rejected without alteration', async (t) => {
        const pgDanger = await startPostgresContainer('pgdanger', POSTGRES_17_IMAGE);
        t.after(() => stopAndRemoveContainer(pgDanger));
        psql(pgDanger, `create role app_worker bypassrls;`);
        const stderr = psqlExpectError(pgDanger, readMigration(FOUNDATION_MIGRATIONS[0]));
        assert.match(stderr, /unexpected attributes/);
        assert.equal(
            scalar(pgDanger, `select rolbypassrls from pg_roles where rolname = 'app_worker'`),
            't',
        );
        assert.equal(scalar(pgDanger, `select count(*) from pg_roles where rolname = 'app_owner'`), '0');
    });

    await t.test('non-superuser migration operator provisions via app_owner grant', async (t) => {
        const pgOperator = await startPostgresContainer('pgop', POSTGRES_17_IMAGE);
        t.after(() => stopAndRemoveContainer(pgOperator));
        psql(pgOperator, `
            create role foundation_operator nologin nosuperuser createrole bypassrls;
            grant create on database postgres to foundation_operator with grant option;
        `);
        for (const fileName of FOUNDATION_MIGRATIONS) {
            psql(pgOperator, `set session authorization foundation_operator;\n${readMigration(fileName)}`);
        }
        assert.equal(scalar(pgOperator, `select count(*) from app.organizations`), '1');
        assert.equal(scalar(pgOperator, `select count(*) from app.role_permissions`), '39');
        assert.equal(scalar(pgOperator, `select count(*) from app.pipeline_stages`), '6');
        assert.equal(
            lastLine(pgOperator, `
                set session authorization foundation_operator;
                set role app_owner;
                select current_user;
            `),
            'app_owner',
        );
        assert.equal(scalar(pgOperator, APP_TABLE_OWNER_SQL), '0');
        for (const role of ['app_staff', 'app_intake', 'app_worker', 'app_executor', 'app_authz_reader']) {
            assertSqlstate(
                pgOperator,
                `set role ${role}; select count(*) from app.candidates;`,
                '42501',
            );
        }
    });

    await t.test('seed fails closed on identity collisions', async (t) => {
        const pgCollide = await startPostgresContainer('pgcollide', POSTGRES_17_IMAGE);
        t.after(() => stopAndRemoveContainer(pgCollide));
        applyMigration(pgCollide, FOUNDATION_MIGRATIONS[0], {});
        applyMigration(pgCollide, FOUNDATION_MIGRATIONS[1], {});

        psql(pgCollide, `
            insert into app.organizations (id, key, name, status)
            values ('${uuid(800)}', 'agora', 'Impostor', 'active');
        `);
        let stderr = psqlExpectError(pgCollide, readMigration(FOUNDATION_MIGRATIONS[2]));
        assert.match(stderr, /Organization key agora is bound/);
        assert.equal(scalar(pgCollide, `select count(*) from app.permissions`), '0');
        psql(pgCollide, `delete from app.organizations where id = '${uuid(800)}';`);

        psql(pgCollide, `
            insert into app.organizations (id, key, name, status)
            values ('${ID.ORG_A}', 'agora', 'Agora', 'active');
            insert into app.roles (id, organization_id, key, name, status)
            values ('${uuid(801)}', '${ID.ORG_A}', 'admin', 'Admin', 'active');
        `);
        stderr = psqlExpectError(pgCollide, readMigration(FOUNDATION_MIGRATIONS[2]));
        assert.match(stderr, /Seeded role key is bound/);
        assert.equal(scalar(pgCollide, `select count(*) from app.permissions`), '0');
        psql(pgCollide, `delete from app.roles;`);

        psql(pgCollide, `
            insert into app.roles (id, organization_id, key, name, status, system_kind)
            values ('${ID.ROLE_A_ADMIN}', '${ID.ORG_A}', 'admin', 'Admin', 'active', null);
        `);
        stderr = psqlExpectError(pgCollide, readMigration(FOUNDATION_MIGRATIONS[2]));
        assert.match(stderr, /Seeded role key is bound/);
        assert.equal(scalar(pgCollide, `select count(*) from app.permissions`), '0');
        psql(pgCollide, `delete from app.roles;`);

        psql(pgCollide, `
            insert into app.roles (id, organization_id, key, name, status, system_kind) values
                ('${ID.ROLE_A_ADMIN}', '${ID.ORG_A}', 'admin', 'Admin', 'active', 'admin'),
                ('${ID.ROLE_A_RECRUITER}', '${ID.ORG_A}', 'recruiter', 'Recruiter', 'active', 'recruiter'),
                ('${ID.ROLE_A_VIEWER}', '${ID.ORG_A}', 'viewer', 'Viewer', 'inactive', 'viewer');
            insert into app.pipelines (id, organization_id, key, name, status)
            values ('${uuid(802)}', '${ID.ORG_A}', 'default', 'Default recruitment', 'active');
        `);
        stderr = psqlExpectError(pgCollide, readMigration(FOUNDATION_MIGRATIONS[2]));
        assert.match(stderr, /Default pipeline key is bound/);
        assert.equal(scalar(pgCollide, `select count(*) from app.permissions`), '0');
        assert.equal(scalar(pgCollide, `select count(*) from app.pipeline_stages`), '0');
    });
});

const SUPABASE_FIXED_PORTS = [54321, 3000];
const SUPABASE_REMAPPABLE = [
    ['port', 54322],
    ['shadow_port', 54320],
    ['port', 54323],
    ['port', 54324],
    ['port', 54327],
    ['port', 54329],
    ['inspector_port', 8083],
];

const redactCredentials = (text) => text
    .replace(/([A-Za-z_]*(?:KEY|TOKEN|SECRET|PASSWORD|JWT|ANON)[A-Za-z_]*)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi, '$1=<redacted>')
    .replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://<redacted>');

test('supabase legacy upgrade without reset', { skip: mode !== 'supabase' }, async (t) => {
    assertLocalTestEnvironment();
    if (!existsSync(supabaseBin)) {
        throw new Error('Supabase CLI is not installed (npm ci provides node_modules/.bin/supabase).');
    }
    for (const port of SUPABASE_FIXED_PORTS) {
        if (!(await isPortFree(port))) {
            throw new Error(
                `Port ${port} is occupied; refusing to reuse or disturb an existing local stack.`,
            );
        }
    }

    const projectId = `agorafnd${RUN_ID}`;
    const workdir = mkdtempSync(join(tmpdir(), `agora-foundation-${RUN_ID}-`));
    const supabaseDir = join(workdir, 'supabase');
    const tempMigrations = join(supabaseDir, 'migrations');
    mkdirSync(tempMigrations, { recursive: true });

    let configText = readFileSync(join(repoRoot, 'supabase', 'config.toml'), 'utf8');
    configText = configText.replace(
        'project_id = "agora-web3-app"',
        `project_id = "${projectId}"`,
    );
    for (const [key, port] of SUPABASE_REMAPPABLE) {
        if (!(await isPortFree(port))) {
            configText = configText.replace(`${key} = ${port}`, `${key} = ${await findFreePort()}`);
        }
    }
    writeFileSync(join(supabaseDir, 'config.toml'), configText);
    copyFileSync(join(repoRoot, 'supabase', 'seed.sql'), join(supabaseDir, 'seed.sql'));
    copyFileSync(join(migrationsDir, LEGACY_MIGRATION), join(tempMigrations, LEGACY_MIGRATION));

    const nameSuffix = `_${projectId}`;
    const configPath = join(supabaseDir, 'config.toml');
    const verifyWorkdirConfig = () => {
        if (!readFileSync(configPath, 'utf8').includes(`project_id = "${projectId}"`)) {
            throw new Error('Isolated Supabase workdir config does not belong to this run.');
        }
    };

    const projectResourceNames = (kind) => listDockerResourceNames(kind)
        .filter((name) => name.endsWith(nameSuffix));
    const projectContainerIds = () => listContainersWithLabel(SUPABASE_PROJECT_LABEL, projectId);
    const preexistingResources = [
        ...projectResourceNames('container'),
        ...projectResourceNames('volume'),
        ...projectResourceNames('network'),
        ...projectContainerIds(),
    ];
    if (preexistingResources.length > 0) {
        throw new Error(`Supabase project resources for ${projectId} already exist; refusing to proceed.`);
    }

    const dbContainer = `supabase_db_${projectId}`;
    const captured = {
        containers: new Map(),
        volumes: new Map(),
        networks: new Map(),
    };
    const safeInspect = (kind, name) => {
        try {
            return inspectDockerResource(kind, name);
        } catch {
            return null;
        }
    };
    const safeList = (fn) => {
        try {
            return fn();
        } catch {
            return [];
        }
    };
    const captureResources = () => {
        for (const shortId of safeList(() => projectContainerIds())) {
            const entry = safeInspect('container', shortId);
            if (entry && hasProjectLabel(entry, projectId)) {
                captured.containers.set(entry.Id, entry.Name.replace(/^\//, ''));
            }
        }
        for (const name of safeList(() => projectResourceNames('volume'))) {
            const entry = safeInspect('volume', name);
            if (entry && hasProjectLabel(entry, projectId)) {
                captured.volumes.set(name, entry.CreatedAt ?? '');
            }
        }
        for (const name of safeList(() => projectResourceNames('network'))) {
            const entry = safeInspect('network', name);
            if (entry && hasProjectLabel(entry, projectId)) {
                captured.networks.set(name, entry.Id ?? '');
            }
        }
    };
    const verifyDbContainer = () => {
        const entry = inspectDockerResource('container', dbContainer);
        if (!hasProjectLabel(entry, projectId) || !captured.containers.has(entry.Id)) {
            throw new Error(`Container ${dbContainer} is not a captured resource of this run.`);
        }
    };
    const supabasePsql = (sql) => {
        verifyDbContainer();
        return dockerExecInput(dbContainer, [
            'psql', '-U', 'postgres', '-d', 'postgres',
            '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
        ], sql);
    };
    const supabasePsqlError = (sql) => {
        try {
            supabasePsql(sql);
        } catch (error) {
            return String(error.stderr ?? '');
        }
        throw new Error('Expected SQL to fail but it succeeded.');
    };

    const runCli = (args, { verifyDb = false, ...options } = {}) => {
        verifyWorkdirConfig();
        if (verifyDb) {
            verifyDbContainer();
        }
        try {
            return execFileSync(supabaseBin, [...args, '--workdir', workdir], {
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe'],
                maxBuffer: 32 * 1024 * 1024,
                ...options,
            });
        } catch (error) {
            if (args[0] === 'migration') {
                const detail = redactCredentials(String(error.stderr ?? '')).slice(-2000);
                throw new Error(`supabase ${args.join(' ')} failed: ${detail}`);
            }
            throw new Error(
                `supabase ${args.join(' ')} failed with exit code ${error.status ?? 'unknown'}.`,
            );
        }
    };

    const cleanup = () => {
        const failures = [];
        for (const [id, name] of captured.containers) {
            const entry = safeInspect('container', name);
            if (!entry) {
                failures.push(`container ${name} could not be reinspected`);
            } else if (entry.Id === id && hasProjectLabel(entry, projectId)) {
                if (!tryDockerCommand(['rm', '--force', '--volumes', name])) {
                    failures.push(`container ${name}`);
                }
            } else {
                failures.push(`container ${name} identity changed; left in place`);
            }
        }
        for (const [name, createdAt] of captured.volumes) {
            const entry = safeInspect('volume', name);
            if (!entry) {
                failures.push(`volume ${name} could not be reinspected`);
            } else if ((entry.CreatedAt ?? '') === createdAt && hasProjectLabel(entry, projectId)) {
                if (!tryDockerCommand(['volume', 'rm', name])) {
                    failures.push(`volume ${name}`);
                }
            } else {
                failures.push(`volume ${name} identity changed; left in place`);
            }
        }
        for (const [name, id] of captured.networks) {
            const entry = safeInspect('network', name);
            if (!entry) {
                failures.push(`network ${name} could not be reinspected`);
            } else if ((entry.Id ?? '') === id && hasProjectLabel(entry, projectId)) {
                if (!tryDockerCommand(['network', 'rm', name])) {
                    failures.push(`network ${name}`);
                }
            } else {
                failures.push(`network ${name} identity changed; left in place`);
            }
        }
        const capturedNames = new Set([
            ...captured.containers.values(),
            ...captured.volumes.keys(),
            ...captured.networks.keys(),
        ]);
        const leftovers = ['container', 'volume', 'network']
            .flatMap((kind) => safeList(() => projectResourceNames(kind)))
            .filter((name) => !capturedNames.has(name));
        if (leftovers.length > 0) {
            failures.push(`unverified project-suffixed resources left in place: ${leftovers.join(', ')}`);
        }
        if (failures.length > 0) {
            console.warn(`Supabase cleanup incomplete: ${failures.join('; ')}`);
        }
        if (workdir.startsWith(tmpdir()) && workdir.includes(RUN_ID)) {
            rmSync(workdir, { recursive: true, force: true });
        }
    };
    t.after(cleanup);

    try {
        runCli(['start'], { timeout: 15 * 60 * 1000 });
    } finally {
        captureResources();
    }
    if (captured.containers.size === 0) {
        throw new Error('supabase start produced no containers labeled with this run project id.');
    }
    verifyDbContainer();
    runCli(['migration', 'up', '--local'], { timeout: 120_000, verifyDb: true });

    const dumpApplicants = `select row_to_json(t)::text from (select * from public.applicants order by id) t`;
    const dumpBucket = `select row_to_json(b)::text from (select * from storage.buckets where id = 'cv-submissions') b`;

    supabasePsql(`
        insert into public.applicants (full_name, email, cv_url, ref_id, status,
            job_id, job_title, professional_url, technical_achievement)
        values ('Synthetic Legacy', 'legacy@example.invalid', 'cvs/legacy-job/AG-111111111111.pdf',
            'AG-111111111111', 'pending', 'legacy-job', 'Legacy Job',
            'https://example.invalid/legacy', 'synthetic achievement');
    `);
    const applicantsBefore = supabasePsql(dumpApplicants);
    const bucketBefore = supabasePsql(dumpBucket);

    for (const fileName of FOUNDATION_MIGRATIONS) {
        copyFileSync(join(migrationsDir, fileName), join(tempMigrations, fileName));
    }
    const migrateStarted = performance.now();
    runCli(['migration', 'up', '--local'], { timeout: 120_000, verifyDb: true });
    t.diagnostic(`supabase migration up elapsed ms: ${Math.round(performance.now() - migrateStarted)}`);

    await t.test('legacy rows and bucket config survive upgrade exactly', () => {
        assert.equal(supabasePsql(dumpApplicants), applicantsBefore);
        assert.equal(supabasePsql(dumpBucket), bucketBefore);
        supabasePsql(`
            insert into public.applicants (full_name, email, cv_url, ref_id, status)
            values ('Post Upgrade', 'post@example.invalid', 'cvs/x/AG-222222222222.pdf',
                'AG-222222222222', 'pending');
        `);
        assert.equal(supabasePsql(`select count(*) from public.applicants`).trim(), '2');
    });

    await t.test('app schema is not exposed through the API or provider roles', () => {
        assert.ok(
            configText.includes('schemas = ["public", "graphql_public"]')
                && !configText.includes('"app"'),
            'app must not appear in api schemas',
        );
        const deniedRoles = [
            'anon', 'authenticated', 'service_role',
            'app_staff', 'app_intake', 'app_worker', 'app_executor', 'app_authz_reader',
        ];
        for (const role of deniedRoles) {
            const stderr = supabasePsqlError(`set role ${role}; select count(*) from app.candidates;`);
            assert.match(stderr, /42501/, `${role} must not read app.candidates`);
            const writeStderr = supabasePsqlError(`set role ${role}; delete from app.organizations;`);
            assert.match(writeStderr, /42501/, `${role} must not delete app.organizations`);
        }
    });

    await t.test('catalog: forced RLS, app_owner ownership and no provider grants', () => {
        assert.equal(supabasePsql(`
            select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'app' and c.relkind = 'r'
        `).trim(), '16');
        assert.equal(supabasePsql(FORCED_RLS_COUNT_SQL).trim(), '0');
        assert.equal(supabasePsql(APP_TABLE_OWNER_SQL).trim(), '0');
        assert.equal(supabasePsql(`
            select coalesce(bool_or(a.grantee = 0), false)
            from pg_catalog.pg_namespace n
            cross join lateral aclexplode(n.nspacl) a
            where n.nspname = 'app'
        `).trim(), 'f');
        assert.equal(supabasePsql(NO_NON_OWNER_GRANTEE_SQL).trim(), 'f');
        assert.equal(supabasePsql(`
            select count(*) from pg_auth_members m
            join pg_roles member_role on member_role.oid = m.member
            where member_role.rolname = any(array['app_owner', 'app_staff', 'app_intake',
                'app_worker', 'app_executor', 'app_authz_reader'])
        `).trim(), '0');
        assert.equal(supabasePsql(`
            select count(*) from pg_auth_members m
            join pg_roles parent_role on parent_role.oid = m.roleid
            join pg_roles member_role on member_role.oid = m.member
            where parent_role.rolname in ('app_owner', 'app_executor', 'app_authz_reader')
                and member_role.rolname not in ('postgres', 'supabase_admin')
        `).trim(), '0');
    });

    await t.test('seed rerun preserves administrator edits on the upgraded stack', () => {
        supabasePsql(`
            update app.organizations set name = 'Agora Renamed' where key = 'agora';
            delete from app.role_permissions
                where role_id = '${ID.ROLE_A_RECRUITER}' and permission_key = 'jobs.write';
        `);
        supabasePsql(readMigration(FOUNDATION_MIGRATIONS[2]));
        assert.equal(supabasePsql(`select name from app.organizations where key = 'agora'`).trim(), 'Agora Renamed');
        assert.equal(supabasePsql(`select count(*) from app.role_permissions
            where role_id = '${ID.ROLE_A_RECRUITER}' and permission_key = 'jobs.write'`).trim(), '0');
        assert.equal(supabasePsql(`select count(*) from app.roles`).trim(), '3');
    });

    await t.test('staff authorization upgrade applies and enforces on the provider stack', async () => {
        const applicantsBeforeAuthz = supabasePsql(dumpApplicants);
        const bucketBeforeAuthz = supabasePsql(dumpBucket);
        copyFileSync(join(migrationsDir, AUTHZ_MIGRATION), join(tempMigrations, AUTHZ_MIGRATION));
        copyFileSync(join(migrationsDir, GOOGLE_MIGRATION), join(tempMigrations, GOOGLE_MIGRATION));
        runCli(['migration', 'up', '--local'], { timeout: 120_000, verifyDb: true });
        assert.equal(supabasePsql(dumpApplicants), applicantsBeforeAuthz);
        assert.equal(supabasePsql(dumpBucket), bucketBeforeAuthz);
        supabasePsql(staffFixtureSql);
        supabasePsql('grant app_staff, app_intake, app_worker to postgres;');

        const smokeSql = (inner) => `
            begin;
            set local role app_staff;
            ${inner}
            commit;
        `;
        const staffContext = `
            select pg_catalog.set_config('app.actor_id', '${AUTHZ_ID.USER_ADMIN1}', true);
            select pg_catalog.set_config('app.organization_id', '${AUTHZ_ID.ORG_A}', true);
        `;

        assert.equal(
            supabasePsql(smokeSql(`${staffContext} select app.has_permission_v1('staff.manage');`))
                .trim().split('\n').pop(),
            't',
        );
        assert.equal(
            supabasePsql(smokeSql(`
                select user_id || '|' || membership_id || '|' || role_id
                from app.resolve_staff_principal_v1(
                    'google', '${GOOGLE_ISSUER}', '${SUBJECTS.ADMIN1}', '${AUTHZ_ID.ORG_A}')
            `)).trim().split('\n').pop(),
            `${AUTHZ_ID.USER_ADMIN1}|${AUTHZ_ID.MEMBER_ADMIN1}|${ID.ROLE_A_ADMIN}`,
        );
        assert.equal(
            supabasePsql(smokeSql(`
                select count(*) from app.resolve_staff_principal_v1(
                    'github', '${GITHUB_ISSUER}', '${SUBJECTS.ADMIN1}', '${AUTHZ_ID.ORG_A}')
            `)).trim().split('\n').pop(),
            '0',
        );

        const membershipVersion = Number(supabasePsql(`
            select version from app.organization_memberships
            where id = '${AUTHZ_ID.MEMBER_CUSTOM}'
        `).trim());
        const changed = supabasePsql(smokeSql(`
            ${staffContext}
            select membership_id || '|' || version
            from app.change_membership_v1(
                '${AUTHZ_ID.MEMBER_CUSTOM}', '${AUTHZ_ID.ROLE_A_CUSTOM}', 'revoked',
                ${membershipVersion}, '${randomUUID()}', '${randomUUID()}');
        `)).trim().split('\n').pop();
        assert.equal(changed, `${AUTHZ_ID.MEMBER_CUSTOM}|${membershipVersion + 1}`);

        const roleVersion = Number(supabasePsql(`
            select version from app.roles where id = '${ID.ROLE_A_RECRUITER}'
        `).trim());
        const grantsChanged = supabasePsql(smokeSql(`
            ${staffContext}
            select role_id || '|' || version
            from app.change_role_grants_v1(
                '${ID.ROLE_A_RECRUITER}', ${roleVersion}, '{}', '{documents.download}',
                '${randomUUID()}', '${randomUUID()}');
        `)).trim().split('\n').pop();
        assert.equal(grantsChanged, `${ID.ROLE_A_RECRUITER}|${roleVersion + 1}`);
        assert.equal(
            supabasePsql(`select count(*) from app.audit_events
                where organization_id = '${AUTHZ_ID.ORG_A}'`).trim(),
            '2',
        );
        assert.equal(
            supabasePsql(`select action from app.audit_events
                where organization_id = '${AUTHZ_ID.ORG_A}' order by occurred_at, id`).trim(),
            'staff.membership.changed\nstaff.role_grants.changed',
        );

        for (const role of ['anon', 'authenticated', 'service_role', 'app_intake', 'app_worker']) {
            assert.match(
                supabasePsqlError(`set role ${role}; select app.has_permission_v1('staff.manage');`),
                /42501/,
                `${role} must not call internal functions`,
            );
        }
        assert.match(
            supabasePsqlError(`set role app_staff; select count(*) from app.candidates;`),
            /42501/,
            'app_staff must not read candidate data',
        );

        assert.equal(supabasePsql(`
            select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            join pg_roles r on r.oid = p.proowner
            where n.nspname = 'app' and (
                p.proname not in ('context_uuid_v1', 'has_permission_v1',
                    'resolve_staff_principal_v1', 'change_membership_v1', 'change_role_grants_v1')
                or (p.proname = 'context_uuid_v1'
                    and (p.prosecdef or r.rolname <> 'app_owner'))
                or (p.proname in ('has_permission_v1', 'resolve_staff_principal_v1')
                    and (not p.prosecdef or r.rolname <> 'app_authz_reader'))
                or (p.proname in ('change_membership_v1', 'change_role_grants_v1')
                    and (not p.prosecdef or r.rolname <> 'app_executor'))
            )
        `).trim(), '0');
        assert.equal(supabasePsql(`
            select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'app' and c.relname = 'audit_events'
                and c.relrowsecurity and c.relforcerowsecurity
        `).trim(), '1');
        assert.equal(supabasePsql(`
            select coalesce(bool_or(acl.grantee = 0), false)
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            cross join lateral aclexplode(
                coalesce(p.proacl, acldefault('f', p.proowner))
            ) acl
            where n.nspname = 'app'
        `).trim(), 'f');
    });

    await t.test('privacy and document foundations apply and enforce on the provider stack', async () => {
        const applicantsBeforePrivacy = supabasePsql(dumpApplicants);
        const bucketBeforePrivacy = supabasePsql(dumpBucket);
        const authRoutinesBeforePrivacy = supabasePsql(AUTH_ROUTINE_SNAPSHOT_SQL);
        for (const fileName of PRIVACY_MIGRATIONS) {
            copyFileSync(join(migrationsDir, fileName), join(tempMigrations, fileName));
        }
        const privacyMigrateStarted = performance.now();
        runCli(['migration', 'up', '--local'], { timeout: 120_000, verifyDb: true });
        t.diagnostic(`supabase privacy migration up elapsed ms: ${Math.round(
            performance.now() - privacyMigrateStarted)}`);
        assert.equal(supabasePsql(dumpApplicants), applicantsBeforePrivacy);
        assert.equal(supabasePsql(dumpBucket), bucketBeforePrivacy);
        assert.equal(supabasePsql(`
            select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'app' and c.relkind = 'r'
        `).trim(), '32');
        assert.equal(supabasePsql(`
            select count(*) from app.candidates
            where current_document_id is not null`).trim(), '0');
        assert.equal(supabasePsql(`
            select count(*) from app.applications where notice_id is not null`).trim(), '0');

        supabasePsql(privacyFixtureSql);
        supabasePsql('grant app_executor, app_authz_reader to postgres;');
        assertPrivacyFoundation(
            (sql) => supabasePsql(sql),
            (sql) => supabasePsqlError(sql),
            authRoutinesBeforePrivacy,
        );
        for (const role of ['app_executor', 'app_authz_reader']) {
            for (const statement of [
                'select count(*) from app.documents',
                'update app.file_blobs set version = version + 1',
                'delete from app.legacy_datasets',
            ]) {
                assert.match(
                    supabasePsqlError(`set role ${role}; ${statement};`),
                    /42501/,
                    `${role} must be denied on new tables`,
                );
            }
        }
        for (const role of ['anon', 'authenticated', 'service_role']) {
            assert.match(
                supabasePsqlError(`set role ${role}; select count(*) from app.documents;`),
                /42501/,
                `${role} must not read app.documents`,
            );
            assert.match(
                supabasePsqlError(
                    `set role ${role}; select count(*) from app.privacy_requests;`),
                /42501/,
                `${role} must not read app.privacy_requests`,
            );
        }
    });

    await t.test('privacy operations apply and enforce on the provider stack', () => {
        const applicantsBeforeOps = supabasePsql(dumpApplicants);
        const bucketBeforeOps = supabasePsql(dumpBucket);
        const authRoutinesBeforeOps = supabasePsql(AUTH_ROUTINE_SNAPSHOT_SQL);
        copyFileSync(
            join(migrationsDir, PRIVACY_OPS_MIGRATION),
            join(tempMigrations, PRIVACY_OPS_MIGRATION),
        );
        const opsMigrateStarted = performance.now();
        runCli(['migration', 'up', '--local'], { timeout: 120_000, verifyDb: true });
        t.diagnostic(`supabase privacy operations migration up elapsed ms: ${Math.round(
            performance.now() - opsMigrateStarted)}`);
        assert.equal(supabasePsql(dumpApplicants), applicantsBeforeOps);
        assert.equal(supabasePsql(dumpBucket), bucketBeforeOps);
        assert.equal(
            supabasePsql(AUTH_ROUTINE_SNAPSHOT_SQL),
            authRoutinesBeforeOps,
            'authorization routines must be unchanged by the operations migration',
        );
        assert.equal(supabasePsql(`
            select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            join pg_roles r on r.oid = p.proowner
            where n.nspname = 'app'
                and p.proname in ('${PRIVACY_FUNCTIONS.join("','")}')
                and p.prosecdef and r.rolname = 'app_executor'`).trim(), '5');
        assert.equal(supabasePsql(`
            select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            join pg_roles r on r.oid = p.proowner
            where n.nspname = 'app'
                and p.proname in ('${PRIVACY_HELPER_FUNCTIONS.join("','")}')
                and not p.prosecdef and r.rolname = 'app_owner'`).trim(), '3');

        supabasePsql(privacyOpsFixtureSql);

        const opsSql = (inner) => `
            begin;
            set local role app_staff;
            select pg_catalog.set_config('app.actor_id', '${AUTHZ_ID.USER_ADMIN1}', true),
                   pg_catalog.set_config('app.organization_id', '${AUTHZ_ID.ORG_A}', true);
            ${inner}
            commit;
        `;
        const tailLines = (output, count) => output.trim().split('\n').slice(-count);

        const restrictionRequest = randomUUID();
        const restrictionSubject = randomUUID();
        assert.deepEqual(
            tailLines(supabasePsql(opsSql(`
                select (app.create_privacy_request_v1('${restrictionRequest}', 'restriction',
                    now() - interval '1 day', null,
                    '${randomUUID()}', '${randomUUID()}')) ->> 'status';
                select (app.review_privacy_subject_v1('${restrictionRequest}', 1,
                    '${restrictionSubject}', '${PRIVACY_ID.CAND_1}', null, 1, null,
                    '${randomUUID()}', '${randomUUID()}')) ->> 'request_version';
                select (app.verify_privacy_request_v1('${restrictionRequest}', 2,
                    'synthetic-staff-review', '${randomUUID()}', '${randomUUID()}')) ->> 'status';
                select (app.restrict_privacy_subject_v1('${restrictionRequest}', 3,
                    '${restrictionSubject}', 1,
                    '${randomUUID()}', '${randomUUID()}')) ->> 'scope';
            `)), 4),
            ['received', '2', 'verified', 'candidate_records_only'],
        );

        const correctionRequest = randomUUID();
        const correctionSubject = randomUUID();
        assert.deepEqual(
            tailLines(supabasePsql(opsSql(`
                select (app.create_privacy_request_v1('${correctionRequest}', 'correction',
                    now() - interval '1 day', null,
                    '${randomUUID()}', '${randomUUID()}')) ->> 'status';
                select (app.review_privacy_subject_v1('${correctionRequest}', 1,
                    '${correctionSubject}', '${PRIVACY_ID.CAND_2}', null, 1, null,
                    '${randomUUID()}', '${randomUUID()}')) ->> 'request_version';
                select (app.verify_privacy_request_v1('${correctionRequest}', 2,
                    'synthetic-staff-review', '${randomUUID()}', '${randomUUID()}')) ->> 'status';
                select (app.correct_privacy_candidate_v1('${correctionRequest}', 3,
                    '${correctionSubject}', 1,
                    '{"professional_summary":"Synthetic provider correction"}'::jsonb,
                    '${randomUUID()}', '${randomUUID()}')) ->> 'scope';
            `)), 4),
            ['received', '2', 'verified', 'candidate_profile_only'],
        );

        const legacyRequest = randomUUID();
        const legacySubject = randomUUID();
        assert.deepEqual(
            tailLines(supabasePsql(opsSql(`
                select (app.create_privacy_request_v1('${legacyRequest}', 'restriction',
                    now() - interval '1 day', null,
                    '${randomUUID()}', '${randomUUID()}')) ->> 'status';
                select (app.review_privacy_subject_v1('${legacyRequest}', 1,
                    '${legacySubject}', null, '${PRIVACY_ID.LR_2}', 1,
                    decode('${HASH.H6}', 'hex'),
                    '${randomUUID()}', '${randomUUID()}')) ->> 'request_version';
                select (app.verify_privacy_request_v1('${legacyRequest}', 2,
                    'synthetic-staff-review', '${randomUUID()}', '${randomUUID()}')) ->> 'status';
                select (app.restrict_privacy_subject_v1('${legacyRequest}', 3,
                    '${legacySubject}', 1,
                    '${randomUUID()}', '${randomUUID()}')) ->> 'scope';
            `)), 4),
            ['received', '2', 'verified', 'legacy_metadata_only'],
        );

        assert.equal(supabasePsql(`
            select lifecycle from app.candidates where id = '${PRIVACY_ID.CAND_1}'`).trim(),
        'restricted');
        assert.equal(supabasePsql(`
            select processing_restricted and candidate_id is null
            from app.legacy_records where id = '${PRIVACY_ID.LR_2}'`).trim(), 't');
        assert.equal(supabasePsql(`
            select count(*) from app.privacy_events
            where request_id in
                ('${restrictionRequest}', '${correctionRequest}', '${legacyRequest}')`).trim(),
        '12');
        assert.equal(supabasePsql(`
            select count(*) from app.audit_events
            where target_id in
                ('${restrictionRequest}', '${correctionRequest}', '${legacyRequest}')`).trim(),
        '12');

        for (const role of ['anon', 'authenticated', 'service_role']) {
            assert.match(
                supabasePsqlError(`
                    set role ${role}; select app.create_privacy_request_v1(
                        '${randomUUID()}', 'access', now(), null,
                        '${randomUUID()}', '${randomUUID()}')`),
                /42501/,
                `${role} must not execute privacy procedures`,
            );
        }
        assert.match(
            supabasePsqlError(`set role app_staff;
                select app.privacy_actor_v1('${randomUUID()}', '${randomUUID()}')`),
            /42501/,
            'app_staff must not execute the internal helpers',
        );
        assert.match(
            supabasePsqlError(`set role app_staff; select count(*) from app.privacy_events`),
            /42501/,
            'app_staff must not read privacy tables directly',
        );
    });

    await t.test('client and job workflows apply and enforce on the provider stack', () => {
        const applicantsBeforeWorkflows = supabasePsql(dumpApplicants);
        const bucketBeforeWorkflows = supabasePsql(dumpBucket);
        const authRoutinesBeforeWorkflows = supabasePsql(AUTH_ROUTINE_SNAPSHOT_SQL);
        copyFileSync(
            join(migrationsDir, WORKFLOW_MIGRATION),
            join(tempMigrations, WORKFLOW_MIGRATION),
        );
        const workflowMigrateStarted = performance.now();
        runCli(['migration', 'up', '--local'], { timeout: 120_000, verifyDb: true });
        t.diagnostic(`supabase client job migration up elapsed ms: ${Math.round(
            performance.now() - workflowMigrateStarted)}`);
        assert.equal(supabasePsql(dumpApplicants), applicantsBeforeWorkflows);
        assert.equal(supabasePsql(dumpBucket), bucketBeforeWorkflows);
        assert.equal(
            supabasePsql(AUTH_ROUTINE_SNAPSHOT_SQL),
            authRoutinesBeforeWorkflows,
            'authorization routines must be unchanged by the workflow migration',
        );
        assert.equal(supabasePsql(`
            select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            join pg_roles r on r.oid = p.proowner
            where n.nspname = 'app'
                and p.proname in ('${WORKFLOW_FUNCTIONS.join("','")}')
                and p.prosecdef and r.rolname = 'app_executor'`).trim(),
            String(WORKFLOW_FUNCTIONS.length));
        assert.equal(supabasePsql(`
            select count(*) from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
            join pg_roles r on r.oid = c.relowner
            where n.nspname = 'app' and c.relkind = 'r'
                and c.relname in ('job_revisions', 'recruitment_operation_receipts')
                and r.rolname = 'app_owner'
                and c.relrowsecurity and c.relforcerowsecurity`).trim(), '2');

        const sqlJson = (value) => JSON.stringify(value).replaceAll("'", "''");
        const staffSql = (inner) => `
            set role app_staff;
            do $$
            begin
                perform pg_catalog.set_config('app.actor_id',
                    '${AUTHZ_ID.USER_ADMIN1}', false);
                perform pg_catalog.set_config('app.organization_id',
                    '${AUTHZ_ID.ORG_A}', false);
            end
            $$;
            ${inner}
        `;
        const namedClient = randomUUID();
        const stealthClient = randomUUID();
        const clientFields = (name, stealth) => ({
            name,
            contactName: 'Synthetic Contact',
            contactEmail: 'contact@synthetic-client.example',
            telegramUsername: null,
            website: stealth ? 'https://stealth-internal.example' : null,
            socialLinks: [],
            isStealth: stealth,
            anonymousDescription: stealth ? 'A synthetic confidential client.' : null,
        });
        const jobFields = {
            title: 'Synthetic Provider Job',
            employmentType: 'full_time',
            workplaceMode: 'remote',
            locations: [],
            remoteRegions: ['Worldwide'],
            compensationMin: '100000',
            compensationMax: '140000',
            currency: 'EUR',
            payPeriod: 'year',
            bonuses: [],
            descriptionDocument: {
                type: 'doc',
                content: [{
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'Synthetic provider description' }],
                }],
            },
        };

        assert.deepEqual(
            supabasePsql(staffSql(`
                select (app.save_client_v1('${namedClient}', null,
                    '${sqlJson(clientFields('Synthetic Named Client', false))}'::jsonb,
                    '${randomUUID()}', '${randomUUID()}')) ->> 'publicProfileVersion';
                select (app.save_client_v1('${stealthClient}', null,
                    '${sqlJson(clientFields('Synthetic Stealth Client', true))}'::jsonb,
                    '${randomUUID()}', '${randomUUID()}')) ->> 'publicProfileVersion';
            `)).trim().split('\n'),
            ['1', '1'],
        );

        const jobId = randomUUID();
        const revisionId = randomUUID();
        assert.equal(
            supabasePsql(staffSql(`
                select (app.create_job_draft_v1('${jobId}', '${revisionId}',
                    '${stealthClient}', '${sqlJson(jobFields)}'::jsonb,
                    '${randomUUID()}', '${randomUUID()}')) ->> 'status';
            `)).trim(),
            'draft',
        );
        const reviewHash = supabasePsql(staffSql(`
            select (app.preview_job_public_v1('${revisionId}')) ->> 'reviewHash';
        `)).trim();
        assert.match(reviewHash, /^[0-9a-f]{64}$/);
        assert.equal(
            supabasePsql(staffSql(`
                select (app.publish_job_revision_v1('${revisionId}', 1, 1,
                    decode('${reviewHash}', 'hex'),
                    '${randomUUID()}', '${randomUUID()}')) ->> 'status';
            `)).trim(),
            'published',
        );
        const projection = JSON.parse(supabasePsql(staffSql(`
            select app.get_job_publication_v1('${jobId}')::text;
        `)).trim());
        assert.equal(projection.company.name, 'Stealth company');
        assert.equal(projection.company.description, 'A synthetic confidential client.');
        assert.equal(projection.compensation.currency, 'EUR');
        assert.ok(
            !JSON.stringify(projection).includes('Synthetic Stealth Client'),
            'the public projection must not leak the internal client name',
        );

        for (const role of ['anon', 'authenticated', 'service_role']) {
            assert.match(
                supabasePsqlError(`set role ${role}; select app.get_job_publication_v1(
                    '${jobId}')`),
                /42501/,
                `${role} must not execute workflow procedures`,
            );
            assert.match(
                supabasePsqlError(`set role ${role}; select count(*) from app.job_revisions`),
                /42501/,
                `${role} must not read app.job_revisions`,
            );
            assert.match(
                supabasePsqlError(
                    `set role ${role}; select count(*) from app.recruitment_operation_receipts`),
                /42501/,
                `${role} must not read operation receipts`,
            );
        }
        assert.match(
            supabasePsqlError(`set role app_staff; select app.recruitment_actor_v1(
                array['jobs.read'], null, null, false)`),
            /42501/,
            'app_staff must not execute the recruitment helpers',
        );
    });

    await t.test('staff totp migration applies and enforces on the provider stack', () => {
        const applicantsBeforeTotp = supabasePsql(dumpApplicants);
        copyFileSync(
            join(migrationsDir, TOTP_MIGRATION),
            join(tempMigrations, TOTP_MIGRATION),
        );
        runCli(['migration', 'up', '--local'], { timeout: 120_000, verifyDb: true });
        assert.equal(supabasePsql(dumpApplicants), applicantsBeforeTotp);

        const staffSql = (inner) => `
            set role app_staff;
            do $$
            begin
                perform pg_catalog.set_config('app.actor_id',
                    '${AUTHZ_ID.USER_ADMIN1}', false);
                perform pg_catalog.set_config('app.organization_id',
                    '${AUTHZ_ID.ORG_A}', false);
            end
            $$;
            ${inner}
        `;
        const credentialId = supabasePsql(staffSql(`
            select app.totp_enroll_v1('ABCDEFGHIJKLMNOP',
                '${randomUUID()}', '${randomUUID()}');
        `)).trim();
        assert.match(credentialId, /^[0-9a-f-]{36}$/);
        assert.equal(supabasePsql(staffSql(`
            select status from app.totp_status_v1();
        `)).trim(), 'pending');
        supabasePsql(staffSql(`
            select app.totp_confirm_v1('${credentialId}',
                '${randomUUID()}', '${randomUUID()}');
        `));
        assert.equal(supabasePsql(staffSql(`
            select status from app.totp_status_v1();
        `)).trim(), 'active');
        supabasePsql(staffSql(`
            select app.totp_record_use_v1('${credentialId}', 7,
                '${randomUUID()}', '${randomUUID()}');
        `));
        assert.match(
            supabasePsqlError(staffSql(`
                select app.totp_record_use_v1('${credentialId}', 7,
                    '${randomUUID()}', '${randomUUID()}');
            `)),
            /23514/,
            'replaying the same TOTP counter must fail',
        );
        for (const role of ['anon', 'authenticated', 'service_role']) {
            assert.match(
                supabasePsqlError(`set role ${role}; select app.totp_status_v1()`),
                /42501/,
                `${role} must not execute totp procedures`,
            );
            assert.match(
                supabasePsqlError(`set role ${role}; select count(*) from app.totp_credentials`),
                /42501/,
                `${role} must not read app.totp_credentials`,
            );
        }
        assert.match(
            supabasePsqlError(`set role app_staff; select app.totp_actor_v1(false)`),
            /42501/,
            'app_staff must not execute the totp actor helper',
        );
    });

    await t.test('staff listing migration applies and enforces on the provider stack', () => {
        const applicantsBeforeListing = supabasePsql(dumpApplicants);
        copyFileSync(
            join(migrationsDir, LISTING_MIGRATION),
            join(tempMigrations, LISTING_MIGRATION),
        );
        runCli(['migration', 'up', '--local'], { timeout: 120_000, verifyDb: true });
        assert.equal(supabasePsql(dumpApplicants), applicantsBeforeListing);

        const staffSql = (inner) => `
            set role app_staff;
            do $$
            begin
                perform pg_catalog.set_config('app.actor_id',
                    '${AUTHZ_ID.USER_ADMIN1}', false);
                perform pg_catalog.set_config('app.organization_id',
                    '${AUTHZ_ID.ORG_A}', false);
            end
            $$;
            ${inner}
        `;
        assert.match(
            supabasePsql(staffSql(`select jsonb_typeof(app.list_clients_v1(10))`)).trim(),
            /^array$/,
            'list_clients_v1 must return a jsonb array under staff context',
        );
        assert.match(
            supabasePsql(staffSql(`select jsonb_typeof(app.list_jobs_v1(10, null, null))`)).trim(),
            /^array$/,
            'list_jobs_v1 must return a jsonb array under staff context',
        );
        assert.match(
            supabasePsqlError(`set role app_staff; select app.list_clients_v1(10)`),
            /42501/,
            'list_clients_v1 must deny missing tenant context',
        );
        for (const role of ['anon', 'authenticated', 'service_role']) {
            assert.match(
                supabasePsqlError(`set role ${role}; select app.list_clients_v1(10)`),
                /42501/,
                `${role} must not execute list_clients_v1`,
            );
            assert.match(
                supabasePsqlError(`set role ${role}; select app.list_jobs_v1(10, null, null)`),
                /42501/,
                `${role} must not execute list_jobs_v1`,
            );
        }
    });

    await t.test('staff invites migration applies and claims on the provider stack', () => {
        const applicantsBeforeInvites = supabasePsql(dumpApplicants);
        for (const file of [INVITES_MIGRATION, INVITE_DOMAINS_MIGRATION]) {
            copyFileSync(
                join(migrationsDir, file),
                join(tempMigrations, file),
            );
        }
        runCli(['migration', 'up', '--local'], { timeout: 120_000, verifyDb: true });
        assert.equal(supabasePsql(dumpApplicants), applicantsBeforeInvites);

        const staffSql = (inner) => `
            set role app_staff;
            do $$
            begin
                perform pg_catalog.set_config('app.actor_id',
                    '${AUTHZ_ID.USER_ADMIN1}', false);
                perform pg_catalog.set_config('app.organization_id',
                    '${AUTHZ_ID.ORG_A}', false);
            end
            $$;
            ${inner}
        `;
        const invitedMembership = randomUUID();
        const invitedUser = randomUUID();
        supabasePsql(staffSql(`
            select app.invite_staff_member_v1(
                '${invitedUser}', '${invitedMembership}', 'Stack Hire',
                'stack.hire@example.com', '${AUTHZ_ID.ROLE_A_RECRUITER}',
                '${randomUUID()}', '${randomUUID()}');
        `));
        assert.equal(
            supabasePsql(`select status from app.organization_memberships
                where id = '${invitedMembership}'`).trim(),
            'invited',
        );
        const claimSql = (email, subject) => `
            set role app_staff;
            do $$
            begin
                perform pg_catalog.set_config('app.organization_id',
                    '${AUTHZ_ID.ORG_A}', false);
            end
            $$;
            select membership_id::text
                from app.claim_staff_invite_v1(
                    '${randomUUID()}', 'google', 'https://accounts.google.com',
                    '${subject}', '${email}', '${randomUUID()}', '${randomUUID()}');
        `;
        assert.equal(
            supabasePsql(claimSql('nobody@example.com', '60606')).trim(),
            '',
            'claiming with an uninvited email must return no rows',
        );
        assert.equal(
            supabasePsql(claimSql('stack.hire@example.com', '60606')).trim(),
            invitedMembership,
            'the invited email must claim the pending membership',
        );
        assert.equal(
            supabasePsql(`select status from app.organization_memberships
                where id = '${invitedMembership}'`).trim(),
            'active',
        );
        assert.match(
            supabasePsql(`select membership_id::text
                from app.resolve_staff_principal_v1(
                    'google', 'https://accounts.google.com', '60606',
                    '${AUTHZ_ID.ORG_A}')`).trim(),
            new RegExp(`^${invitedMembership}$`),
            'the claimed subject must resolve to the membership',
        );
        for (const role of ['anon', 'authenticated', 'service_role']) {
            assert.match(
                supabasePsqlError(`set role ${role}; select app.staff_directory_v1(10)`),
                /42501/,
                `${role} must not execute staff_directory_v1`,
            );
            assert.match(
                supabasePsqlError(`set role ${role};
                    select app.claim_staff_invite_v1(
                        '${randomUUID()}', 'google', 'https://accounts.google.com',
                        '1', 'x@example.com', '${randomUUID()}', '${randomUUID()}')`),
                /42501/,
                `${role} must not execute claim_staff_invite_v1`,
            );
            assert.match(
                supabasePsqlError(`set role ${role};
                    select app.set_staff_invite_domains_v1(
                        '{a.example}'::text[], '${randomUUID()}', '${randomUUID()}')`),
                /42501/,
                `${role} must not execute set_staff_invite_domains_v1`,
            );
        }

        // The invite-domain allowlist applies on the provider stack too:
        // pinning to a domain rejects off-domain invites.
        supabasePsql(staffSql(`
            select app.set_staff_invite_domains_v1(
                '{workspace.example}'::text[], '${randomUUID()}', '${randomUUID()}');
        `));
        assert.match(
            supabasePsqlError(staffSql(`
                select app.invite_staff_member_v1(
                    '${randomUUID()}', '${randomUUID()}', 'Off Domain',
                    'hire@elsewhere.example', '${AUTHZ_ID.ROLE_A_RECRUITER}',
                    '${randomUUID()}', '${randomUUID()}');
            `)),
            /42501/,
            'off-domain invites are rejected once the allowlist is set',
        );
        supabasePsql(staffSql(`
            select app.set_staff_invite_domains_v1(
                null, '${randomUUID()}', '${randomUUID()}');
        `));
    });

    await t.test('pipeline and public intake migrations apply on the provider stack', () => {
        const applicantsBeforeIntake = supabasePsql(dumpApplicants);
        for (const file of [PIPELINE_MIGRATION, INTAKE_MIGRATION]) {
            copyFileSync(
                join(migrationsDir, file),
                join(tempMigrations, file),
            );
        }
        runCli(['migration', 'up', '--local'], { timeout: 120_000, verifyDb: true });
        assert.equal(supabasePsql(dumpApplicants), applicantsBeforeIntake);

        assert.equal(supabasePsql(`
            select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            join pg_roles r on r.oid = p.proowner
            where n.nspname = 'app'
                and p.proname in ('list_public_jobs_v1',
                    'submit_public_application_v1', 'set_job_public_listing_v1')
                and p.prosecdef and r.rolname = 'app_executor'`).trim(), '3');

        // Anonymous intake context can read the board; provider roles cannot
        // reach the intake procedures.
        assert.doesNotMatch(
            supabasePsql(`
                set role app_intake;
                select pg_catalog.set_config('app.organization_id',
                    '${AUTHZ_ID.ORG_A}', false);
                select count(*) >= 0 from (select app.list_public_jobs_v1()) x`),
            /error/i);
        for (const role of ['anon', 'authenticated', 'service_role']) {
            assert.match(
                supabasePsqlError(`set role ${role}; select app.list_public_jobs_v1()`),
                /42501/,
                `${role} must not execute list_public_jobs_v1`,
            );
        }
        assert.match(
            supabasePsqlError(`
                set role app_staff;
                select app.submit_public_application_v1(
                    '${randomUUID()}', '${randomUUID()}', '${randomUUID()}',
                    '${randomUUID()}', '${randomUUID()}', '${randomUUID()}',
                    '${randomUUID()}', '${randomUUID()}', '${randomUUID()}',
                    '${randomUUID()}', '${randomUUID()}',
                    'x', 'AG-0123456789AB', 'x', 'x@x.example', null, null,
                    null, null, null, null, null, null, null)`),
            /42501/,
            'app_staff must not execute submit_public_application_v1',
        );
    });

    await t.test('staff workspace migration applies on the provider stack', () => {
        copyFileSync(
            join(migrationsDir, WORKSPACE_MIGRATION),
            join(tempMigrations, WORKSPACE_MIGRATION),
        );
        copyFileSync(
            join(migrationsDir, VISIBILITY_MIGRATION),
            join(tempMigrations, VISIBILITY_MIGRATION),
        );
        runCli(['migration', 'up', '--local'], { timeout: 120_000, verifyDb: true });

        assert.equal(supabasePsql(`
            select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            join pg_roles r on r.oid = p.proowner
            where n.nspname = 'app'
                and p.proname in ('get_staff_workspace_v1', 'list_staff_tasks_v1',
                    'create_staff_task_v1', 'set_staff_task_completed_v1')
                and p.prosecdef and r.rolname = 'app_executor'`).trim(), '4');
        assert.equal(supabasePsql(`
            select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            join pg_roles r on r.oid = p.proowner
            where n.nspname = 'app' and p.proname = 'create_job_draft_v2'
                and p.prosecdef and r.rolname = 'app_executor'`).trim(), '1');
        assert.equal(supabasePsql(`
            select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            cross join lateral aclexplode(p.proacl) acl
            where n.nspname = 'app' and p.proname = 'create_job_draft_v2'
                and acl.grantee <> p.proowner
                and acl.grantee <> 'app_staff'::regrole`).trim(), '0');
        assert.equal(supabasePsql(`
            select count(*) from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
            join pg_roles r on r.oid = c.relowner
            where n.nspname = 'app' and c.relname = 'staff_tasks'
                and c.relkind = 'r' and r.rolname = 'app_owner'
                and c.relrowsecurity and c.relforcerowsecurity`).trim(), '1');
        for (const role of ['anon', 'authenticated', 'service_role']) {
            for (const fn of [
                'app.get_staff_workspace_v1()',
                'app.list_staff_tasks_v1(false, null, 20, 0)',
            ]) {
                assert.match(
                    supabasePsqlError(`set role ${role}; select ${fn}`),
                    /42501/,
                    `${role} must not execute ${fn}`,
                );
            }
            assert.match(
                supabasePsqlError(
                    `set role ${role}; select count(*) from app.staff_tasks`),
                /42501/,
                `${role} must not read app.staff_tasks`,
            );
            assert.match(
                supabasePsqlError(
                    `set role ${role}; select app.create_job_draft_v2(`
                        + `'${randomUUID()}'::uuid, '${randomUUID()}'::uuid, `
                        + `'${randomUUID()}'::uuid, '{}'::jsonb, true, `
                        + `'${randomUUID()}'::uuid, '${randomUUID()}'::uuid)`),
                /42501/,
                `${role} must not execute create_job_draft_v2`,
            );
        }
        assert.match(
            supabasePsqlError(
                `set role app_intake; select app.create_job_draft_v2(`
                    + `'${randomUUID()}'::uuid, '${randomUUID()}'::uuid, `
                    + `'${randomUUID()}'::uuid, '{}'::jsonb, true, `
                    + `'${randomUUID()}'::uuid, '${randomUUID()}'::uuid)`),
            /42501/,
            'app_intake must not execute create_job_draft_v2',
        );
    });

    await t.test('candidate profile migrations apply on the provider stack', () => {
        for (const file of [
            '20260930090000_candidate_profiles.sql',
            '20260930090100_candidate_intake_serialization.sql',
        ]) {
            copyFileSync(
                join(migrationsDir, file),
                join(tempMigrations, file),
            );
        }
        runCli(['migration', 'up', '--local'], { timeout: 120_000, verifyDb: true });

        assert.equal(supabasePsql(`
            select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            join pg_roles r on r.oid = p.proowner
            where n.nspname = 'app'
                and p.proname in ('save_candidate_profile_v1',
                    'get_candidate_profile_options_v1', 'get_candidate_profile_v1',
                    'list_candidate_profiles_v1', 'submit_public_application_v1',
                    'submit_public_application_core_v1')
                and p.prosecdef and r.rolname = 'app_executor'`).trim(), '6');
        assert.equal(supabasePsql(`
            select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            join pg_roles r on r.oid = p.proowner
            where n.nspname = 'app' and p.proname = 'candidate_contact_v1'
                and not p.prosecdef and r.rolname = 'app_executor'`).trim(), '1');
        for (const role of ['anon', 'authenticated', 'service_role', 'app_intake']) {
            for (const fn of [
                'app.get_candidate_profile_options_v1()',
                `app.get_candidate_profile_v1('${randomUUID()}'::uuid)`,
                'app.list_candidate_profiles_v1(null, 20)',
            ]) {
                assert.match(
                    supabasePsqlError(`set role ${role}; select ${fn}`),
                    /42501/,
                    `${role} must not execute ${fn}`,
                );
            }
            assert.match(
                supabasePsqlError(
                    `set role ${role}; select app.save_candidate_profile_v1(`
                        + `'${randomUUID()}'::uuid, null, '{}'::jsonb, `
                        + `'${randomUUID()}'::uuid, '${randomUUID()}'::uuid)`),
                /42501/,
                `${role} must not execute save_candidate_profile_v1`,
            );
            assert.match(
                supabasePsqlError(
                    `set role ${role}; select app.submit_public_application_core_v1(`
                        + `'${randomUUID()}'::uuid, '${randomUUID()}'::uuid, `
                        + `'${randomUUID()}'::uuid, '${randomUUID()}'::uuid, `
                        + `'${randomUUID()}'::uuid, '${randomUUID()}'::uuid, `
                        + `'${randomUUID()}'::uuid, '${randomUUID()}'::uuid, `
                        + `'${randomUUID()}'::uuid, '${randomUUID()}'::uuid, `
                        + `'${randomUUID()}'::uuid, 'x', 'AG-0123456789AB', 'x', `
                        + `'x@x.example', null, null, null, null, null, null, `
                        + `null, null, null)`),
                /42501/,
                `${role} must not execute submit_public_application_core_v1`,
            );
        }
    });

    await t.test('existing backend browser suite still passes on the upgraded stack', () => {
        const statusOutput = runCli(['status', '-o', 'env'], { verifyDb: true });
        const envValue = (key) => statusOutput.match(new RegExp(`^${key}="([^"]*)"`, 'm'))?.[1] ?? '';
        try {
            execFileSync(playwrightBin, ['test', 'tests/e2e/application-backend.spec.js'], {
                cwd: repoRoot,
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe'],
                timeout: 10 * 60 * 1000,
                maxBuffer: 32 * 1024 * 1024,
                env: {
                    ...process.env,
                    E2E_REAL_BACKEND: '1',
                    NEXT_PUBLIC_SUPABASE_URL: envValue('API_URL'),
                    NEXT_PUBLIC_SUPABASE_ANON_KEY: envValue('ANON_KEY'),
                    SUPABASE_SERVICE_ROLE_KEY: envValue('SERVICE_ROLE_KEY'),
                    NEXTAUTH_URL: 'http://127.0.0.1:3000',
                    NEXTAUTH_SECRET: `foundation-playwright-${RUN_ID}`,
                    INTAKE_DATABASE_URL: envValue('DB_URL'),
                    STAFF_ORGANIZATION_ID: '9c4edd11-2571-490b-a87c-ef30b9e0a001',
                    E2E_DATABASE_URL: envValue('DB_URL'),
                    RESEND_API_KEY: '',
                    SUPABASE_ACCESS_TOKEN: '',
                    DATABASE_URL: '',
                },
            });
        } catch (error) {
            const tail = redactCredentials(
                `${String(error.stdout ?? '')}\n${String(error.stderr ?? '')}`,
            ).slice(-4000);
            throw new Error(`Backend Playwright suite failed on the isolated stack: ${tail}`);
        }
    });
});
