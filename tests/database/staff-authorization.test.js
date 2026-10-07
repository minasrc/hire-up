import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import {
    POSTGRES_17_IMAGE,
    assertLocalTestEnvironment,
    assertSqlstate,
    psql,
    publishedPort,
    startPostgresContainer,
    stopAndRemoveContainer,
} from '../support/foundation-docker.js';
import {
    AUTHZ_ID,
    AUTHZ_MIGRATION,
    GITHUB_ISSUER,
    GOOGLE_ISSUER,
    GOOGLE_MIGRATION,
    INVITES_MIGRATION,
    INVITE_DOMAINS_MIGRATION,
    RUNTIME_ROLE,
    SUBJECTS,
    installStaffFixture,
    staffPoolOptions,
} from '../support/staff-authorization.js';
import { withStaffTransaction } from '../../src/lib/staff-authorization.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const migrationsDir = join(repoRoot, 'supabase', 'migrations');
const MIGRATIONS = [
    '20260922090000_foundation_roles.sql',
    '20260922090100_foundation_schema.sql',
    '20260922090200_foundation_seed.sql',
    AUTHZ_MIGRATION,
    GOOGLE_MIGRATION,
    INVITES_MIGRATION,
    INVITE_DOMAINS_MIGRATION,
    '20261002090000_staff_invite_recovery.sql',
];
const readMigration = (name) => readFileSync(join(migrationsDir, name), 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const identity = (subject) => ({ provider: 'google', issuer: GOOGLE_ISSUER, subject });
const {
    ORG_A,
    ORG_B,
    ROLE_A_ADMIN,
    ROLE_A_RECRUITER,
    ROLE_A_VIEWER,
    ROLE_A_CUSTOM,
    ROLE_A_INACTIVE,
    ROLE_B_ADMIN,
    USER_ADMIN1,
    USER_ADMIN2,
    USER_RECRUITER,
    USER_VIEWER,
    USER_CUSTOM,
    USER_INVITED,
    USER_SHARED,
    USER_DISABLED,
    MEMBER_ADMIN1,
    MEMBER_ADMIN2,
    MEMBER_RECRUITER,
    MEMBER_INVITED,
    MEMBER_CUSTOM,
    MEMBER_SHARED_A,
    MEMBER_SHARED_B,
    MEMBER_B_ADMIN,
    MEMBER_DISABLED,
} = AUTHZ_ID;

const scalar = (container, sql) => psql(container, sql).trim();

const setSessionContext = (client, actor, org) => client.query(
    `select
        pg_catalog.set_config('app.actor_id', $1, false),
        pg_catalog.set_config('app.organization_id', $2, false)`,
    [actor ?? '', org ?? ''],
);

const setLocalContext = (client, actor, org) => client.query(
    `select
        pg_catalog.set_config('app.actor_id', $1, true),
        pg_catalog.set_config('app.organization_id', $2, true)`,
    [actor ?? '', org ?? ''],
);

const rejectCode = async (promise, code, label) => {
    await assert.rejects(
        promise,
        (error) => error.code === code,
        label ?? `expected ${code}`,
    );
};

const membershipVersion = (container, id) => Number(scalar(
    container,
    `select version from app.organization_memberships where id = '${id}'`,
));

const roleVersion = (container, id) => Number(scalar(
    container,
    `select version from app.roles where id = '${id}'`,
));

const auditRows = (container, auditId) => scalar(
    container,
    `select count(*) from app.audit_events where id = '${auditId}'`,
);

async function waitFor(check, description, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await check()) {
            return;
        }
        if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for ${description}.`);
        }
        await sleep(100);
    }
}

test('staff authorization core on PostgreSQL 17', async (t) => {
    assertLocalTestEnvironment();
    const adminPassword = randomUUID();
    const pg17 = await startPostgresContainer('pgauthz', POSTGRES_17_IMAGE, {
        publish: true,
        password: adminPassword,
    });
    let pool;
    let admin;
    t.after(async () => {
        await pool?.end().catch(() => {});
        await admin?.end().catch(() => {});
        await stopAndRemoveContainer(pg17);
    });

    const timings = {};
    for (const fileName of MIGRATIONS) {
        const startedAt = performance.now();
        psql(pg17, readMigration(fileName));
        timings[fileName] = Math.round(performance.now() - startedAt);
    }
    t.diagnostic(`migration timings ms: ${JSON.stringify(timings)}`);

    const runtimePassword = installStaffFixture(pg17);
    const port = publishedPort(pg17, 5432);
    pool = new pg.Pool(staffPoolOptions(pg17, runtimePassword, 4));
    admin = new pg.Client({
        host: '127.0.0.1',
        port,
        user: 'postgres',
        password: adminPassword,
        database: 'postgres',
    });
    await admin.connect();

    await t.test('context and permission checks fail closed', async () => {
        const client = await pool.connect();
        try {
            const allowed = async (key) => (await client.query(
                'select app.has_permission_v1($1) as allowed',
                [key],
            )).rows[0].allowed;

            assert.equal(await allowed('staff.manage'), false);
            await setSessionContext(client, USER_ADMIN1, '');
            assert.equal(await allowed('staff.manage'), false);
            await setSessionContext(client, 'not-a-uuid', ORG_A);
            assert.equal(await allowed('staff.manage'), false);
            await setSessionContext(client, USER_ADMIN1, 'also-not-a-uuid');
            assert.equal(await allowed('staff.manage'), false);

            await setSessionContext(client, USER_ADMIN1, ORG_A);
            assert.equal(await allowed('staff.manage'), true);
            assert.equal(await allowed('roles.manage'), true);
            assert.equal(await allowed('bogus.key'), false);
            assert.equal(await allowed('retired.key'), false);

            await setSessionContext(client, USER_CUSTOM, ORG_A);
            assert.equal(await allowed('candidates.read'), true);
            assert.equal(await allowed('jobs.write'), false);
            assert.equal(await allowed('staff.manage'), false);
            assert.equal(
                await allowed('retired.key'),
                false,
                'retired grant on the custom role must not resolve',
            );

            await setSessionContext(client, USER_VIEWER, ORG_A);
            assert.equal(await allowed('candidates.read'), false);

            await setSessionContext(client, USER_INVITED, ORG_A);
            assert.equal(await allowed('candidates.read'), false);

            await setSessionContext(client, USER_DISABLED, ORG_A);
            assert.equal(await allowed('candidates.read'), false);

            await setSessionContext(client, USER_SHARED, ORG_A);
            assert.equal(await allowed('staff.manage'), false);
            await setSessionContext(client, USER_SHARED, ORG_B);
            assert.equal(await allowed('staff.manage'), true);

            await setSessionContext(client, USER_ADMIN1, ORG_A);
            assert.equal(await allowed('candidates.read'), true);
        } finally {
            client.release();
        }
    });

    await t.test('principal resolution only maps verified active memberships', async () => {
        const client = await pool.connect();
        try {
            const resolve = (provider, issuer, subject, org) => client.query(
                'select user_id, membership_id, role_id'
                    + ' from app.resolve_staff_principal_v1($1, $2, $3, $4)',
                [provider, issuer, subject, org],
            );

            const adminRow = await resolve('google', GOOGLE_ISSUER, SUBJECTS.ADMIN1, ORG_A);
            assert.equal(adminRow.rows.length, 1);
            assert.deepEqual(Object.keys(adminRow.rows[0]).sort(), [
                'membership_id', 'role_id', 'user_id',
            ]);
            assert.equal(adminRow.rows[0].user_id, USER_ADMIN1);
            assert.equal(adminRow.rows[0].membership_id, MEMBER_ADMIN1);
            assert.equal(adminRow.rows[0].role_id, ROLE_A_ADMIN);

            const sharedA = await resolve('google', GOOGLE_ISSUER, SUBJECTS.SHARED, ORG_A);
            assert.equal(sharedA.rows[0].role_id, ROLE_A_RECRUITER);
            assert.equal(sharedA.rows[0].membership_id, MEMBER_SHARED_A);
            const sharedB = await resolve('google', GOOGLE_ISSUER, SUBJECTS.SHARED, ORG_B);
            assert.equal(sharedB.rows[0].role_id, ROLE_B_ADMIN);
            assert.equal(sharedB.rows[0].membership_id, MEMBER_SHARED_B);

            const identityCount = Number(scalar(pg17, 'select count(*) from app.auth_identities'));
            const userCount = Number(scalar(pg17, 'select count(*) from app.users'));
            const zeroRows = [
                // A GitHub identity exists for ADMIN1 but GitHub is an applicant
                // sign-in only — it must never resolve to a staff principal.
                ['github', GITHUB_ISSUER, SUBJECTS.ADMIN1, ORG_A],
                ['google', 'https://login.example', SUBJECTS.ADMIN1, ORG_A],
                ['gitlab', GOOGLE_ISSUER, SUBJECTS.ADMIN1, ORG_A],
                ['google', GOOGLE_ISSUER, 'abc', ORG_A],
                ['google', GOOGLE_ISSUER, '0', ORG_A],
                ['google', GOOGLE_ISSUER, '1234567890123456789012', ORG_A],
                ['google', GOOGLE_ISSUER, SUBJECTS.REVOKED, ORG_A],
                ['google', GOOGLE_ISSUER, SUBJECTS.UNMAPPED, ORG_A],
                ['google', GOOGLE_ISSUER, SUBJECTS.INVITED, ORG_A],
                ['google', GOOGLE_ISSUER, SUBJECTS.DISABLED, ORG_A],
                ['google', GOOGLE_ISSUER, SUBJECTS.VIEWER, ORG_A],
                ['google', GOOGLE_ISSUER, SUBJECTS.ADMIN1, null],
                ['google', GOOGLE_ISSUER, SUBJECTS.ADMIN1, ORG_B],
                ['google', GOOGLE_ISSUER, SUBJECTS.ADMIN1, randomUUID()],
            ];
            for (const args of zeroRows) {
                const result = await resolve(...args);
                assert.equal(result.rows.length, 0, JSON.stringify(args));
            }
            assert.equal(
                Number(scalar(pg17, 'select count(*) from app.auth_identities')),
                identityCount,
            );
            assert.equal(Number(scalar(pg17, 'select count(*) from app.users')), userCount);

            await client.query('begin');
            await setLocalContext(client, USER_ADMIN1, ORG_A);
            await client.query(
                `select pg_catalog.set_config('app.identity_provider', 'stale', true)`,
            );
            await resolve('google', GOOGLE_ISSUER, SUBJECTS.ADMIN1, ORG_A);
            const settings = await client.query(
                `select
                    current_setting('app.actor_id', true) as actor,
                    current_setting('app.organization_id', true) as org,
                    current_setting('app.identity_provider', true) as provider,
                    current_setting('app.identity_issuer', true) as issuer,
                    current_setting('app.identity_subject', true) as subject`,
            );
            assert.deepEqual(settings.rows[0], {
                actor: '', org: '', provider: '', issuer: '', subject: '',
            });
            await client.query('rollback');
        } finally {
            client.release();
        }
    });

    await t.test('fixture state changes deny then restore access', async () => {
        const resolveCount = async () => Number((await pool.query(
            'select count(*) as hits from app.resolve_staff_principal_v1($1, $2, $3, $4)',
            ['google', GOOGLE_ISSUER, SUBJECTS.ADMIN1, ORG_A],
        )).rows[0].hits);
        const helperCheck = () => withStaffTransaction(
            pool,
            identity(SUBJECTS.ADMIN1),
            ORG_A,
            ['staff.manage'],
            async () => 'ok',
        );
        const assertDenied = async (label) => {
            assert.equal(await resolveCount(), 0, `${label}: resolver must return no row`);
            await assert.rejects(
                helperCheck(),
                (error) => error.code === 'UNAUTHORIZED',
                `${label}: helper must reject`,
            );
        };
        const assertAllowed = async (label) => {
            assert.equal(await resolveCount(), 1, `${label}: resolver must return the row`);
            assert.equal(await helperCheck(), 'ok', `${label}: helper must succeed`);
        };

        const scenarios = [
            {
                label: 'suspended organization',
                apply: () => admin.query(
                    `update app.organizations set status = 'suspended' where id = $1`,
                    [ORG_A],
                ),
                restore: () => admin.query(
                    `update app.organizations set status = 'active' where id = $1`,
                    [ORG_A],
                ),
            },
            {
                label: 'disabled actor user',
                apply: () => admin.query(
                    `update app.users set status = 'disabled' where id = $1`,
                    [USER_ADMIN1],
                ),
                restore: () => admin.query(
                    `update app.users set status = 'active' where id = $1`,
                    [USER_ADMIN1],
                ),
            },
            {
                label: 'inactive role',
                apply: () => admin.query(
                    `update app.roles set status = 'inactive' where id = $1`,
                    [ROLE_A_ADMIN],
                ),
                restore: () => admin.query(
                    `update app.roles set status = 'active' where id = $1`,
                    [ROLE_A_ADMIN],
                ),
            },
            {
                label: 'revoked membership',
                apply: () => admin.query(
                    `update app.organization_memberships
                     set status = 'revoked', revoked_at = now(),
                        version = version + 1, updated_at = now()
                     where id = $1`,
                    [MEMBER_ADMIN1],
                ),
                restore: () => admin.query(
                    `update app.organization_memberships
                     set status = 'active', revoked_at = null,
                        version = version + 1, updated_at = now()
                     where id = $1`,
                    [MEMBER_ADMIN1],
                ),
            },
        ];
        for (const { label, apply, restore } of scenarios) {
            await assertAllowed(`${label} baseline`);
            try {
                await apply();
                await assertDenied(label);
            } finally {
                await restore();
            }
            await assertAllowed(`${label} restored`);
        }
    });

    await t.test('withStaffTransaction drives the full seam on one connection', async () => {
        const single = new pg.Pool({ ...staffPoolOptions(pg17, runtimePassword, 1), max: 1 });
        try {
            const first = await withStaffTransaction(
                single,
                identity(SUBJECTS.ADMIN1),
                ORG_A,
                ['staff.manage'],
                async ({ client }) => (await client.query(
                    `select pg_backend_pid() as pid,
                        current_setting('app.actor_id', true) as actor`,
                )).rows[0],
            );
            assert.equal(first.actor, USER_ADMIN1);

            const second = await withStaffTransaction(
                single,
                identity(SUBJECTS.RECRUITER),
                ORG_A,
                ['candidates.read'],
                async ({ client }) => (await client.query('select pg_backend_pid() as pid')).rows[0],
            );
            assert.equal(second.pid, first.pid);

            await assert.rejects(
                withStaffTransaction(
                    single,
                    identity(SUBJECTS.RECRUITER),
                    ORG_A,
                    ['staff.manage'],
                    () => {},
                ),
                (error) => error.code === 'FORBIDDEN',
            );
            await assert.rejects(
                withStaffTransaction(
                    single,
                    identity(SUBJECTS.UNMAPPED),
                    ORG_A,
                    ['candidates.read'],
                    () => {},
                ),
                (error) => error.code === 'UNAUTHORIZED',
            );
            const failure = new Error('callback exploded');
            await assert.rejects(
                withStaffTransaction(
                    single,
                    identity(SUBJECTS.ADMIN1),
                    ORG_A,
                    ['staff.manage'],
                    async () => {
                        throw failure;
                    },
                ),
                (error) => error === failure,
            );

            const context = await single.query(
                `select
                    current_setting('app.actor_id', true) as actor,
                    current_setting('app.organization_id', true) as org`,
            );
            assert.deepEqual(context.rows[0], { actor: '', org: '' });
        } finally {
            await single.end();
        }
    });

    await t.test('membership mutation commits version and matching audit row', async () => {
        const auditId = randomUUID();
        const correlationId = randomUUID();
        const before = membershipVersion(pg17, MEMBER_RECRUITER);
        const outcome = await withStaffTransaction(
            pool,
            identity(SUBJECTS.ADMIN1),
            ORG_A,
            ['staff.manage', 'roles.manage'],
            async ({ client }) => (await client.query(
                'select membership_id, version from app.change_membership_v1($1, $2, $3, $4, $5, $6)',
                [
                    MEMBER_RECRUITER,
                    ROLE_A_CUSTOM,
                    'active',
                    before,
                    auditId,
                    correlationId,
                ],
            )).rows[0],
        );
        assert.equal(outcome.membership_id, MEMBER_RECRUITER);
        assert.equal(Number(outcome.version), before + 1);
        const state = await admin.query(
            'select role_id, status, activated_at, revoked_at, version'
                + ' from app.organization_memberships where id = $1',
            [MEMBER_RECRUITER],
        );
        assert.equal(state.rows[0].role_id, ROLE_A_CUSTOM);
        assert.equal(state.rows[0].status, 'active');
        assert.ok(state.rows[0].activated_at !== null);
        assert.equal(state.rows[0].revoked_at, null);
        assert.equal(Number(state.rows[0].version), before + 1);

        const audit = await admin.query(
            `select organization_id, actor_kind, actor_user_id, actor_membership_id,
                action, target_type, target_id, correlation_id, details
             from app.audit_events where id = $1`,
            [auditId],
        );
        assert.equal(audit.rows.length, 1);
        const row = audit.rows[0];
        assert.equal(row.organization_id, ORG_A);
        assert.equal(row.actor_kind, 'staff');
        assert.equal(row.actor_user_id, USER_ADMIN1);
        assert.equal(row.actor_membership_id, MEMBER_ADMIN1);
        assert.equal(row.action, 'staff.membership.changed');
        assert.equal(row.target_type, 'organization_membership');
        assert.equal(row.target_id, MEMBER_RECRUITER);
        assert.equal(row.correlation_id, correlationId);
        assert.deepEqual(row.details, {
            previous_role_id: ROLE_A_RECRUITER,
            new_role_id: ROLE_A_CUSTOM,
            previous_status: 'active',
            new_status: 'active',
            previous_version: before,
            new_version: before + 1,
        });
    });

    await t.test('grant mutation commits version and before/after audit keys', async () => {
        const auditId = randomUUID();
        const correlationId = randomUUID();
        const before = roleVersion(pg17, ROLE_A_RECRUITER);
        const outcome = await withStaffTransaction(
            pool,
            identity(SUBJECTS.ADMIN1),
            ORG_A,
            ['staff.manage', 'roles.manage'],
            async ({ client }) => (await client.query(
                'select role_id, version from app.change_role_grants_v1($1, $2, $3, $4, $5, $6)',
                [
                    ROLE_A_RECRUITER,
                    before,
                    '{}',
                    '{jobs.write, jobs.write}',
                    auditId,
                    correlationId,
                ],
            )).rows[0],
        );
        assert.equal(outcome.role_id, ROLE_A_RECRUITER);
        assert.equal(Number(outcome.version), before + 1);
        const audit = await admin.query(
            'select action, target_type, target_id, correlation_id, details'
                + ' from app.audit_events where id = $1',
            [auditId],
        );
        assert.equal(audit.rows.length, 1);
        const row = audit.rows[0];
        assert.equal(row.action, 'staff.role_grants.changed');
        assert.equal(row.target_type, 'role');
        assert.equal(row.target_id, ROLE_A_RECRUITER);
        assert.equal(row.correlation_id, correlationId);
        const expectedBefore = [
            'applications.read', 'applications.stage', 'candidates.read', 'candidates.write',
            'clients.read', 'clients.write', 'collaboration.read', 'collaboration.write',
            'documents.download', 'documents.write', 'duplicates.review', 'jobs.read',
            'jobs.write',
        ].sort();
        const expectedAfter = expectedBefore.filter((key) => key !== 'jobs.write');
        assert.deepEqual([...row.details.before_keys].sort(), expectedBefore);
        assert.deepEqual([...row.details.after_keys].sort(), expectedAfter);
        assert.equal(row.details.previous_version, before);
        assert.equal(row.details.new_version, before + 1);
        assert.equal(
            scalar(pg17, `select count(*) from app.role_permissions
                where organization_id = '${ORG_A}' and role_id = '${ROLE_A_RECRUITER}'
                    and permission_key = 'jobs.write'`),
            '0',
        );
    });

    await t.test('mutation negatives roll back without audit', async () => {
        const client = await pool.connect();
        try {
            await setSessionContext(client, USER_ADMIN1, ORG_A);
            const auditId = randomUUID();
            const changeMembership = (args) => client.query(
                'select * from app.change_membership_v1($1, $2, $3, $4, $5, $6)',
                args,
            );
            const changeGrants = (args) => client.query(
                'select * from app.change_role_grants_v1($1, $2, $3, $4, $5, $6)',
                args,
            );

            await rejectCode(
                changeMembership([MEMBER_SHARED_B, ROLE_B_ADMIN, 'revoked', 1, auditId, randomUUID()]),
                'P0002',
                'cross-org membership target',
            );
            await rejectCode(
                changeMembership([MEMBER_ADMIN2, ROLE_A_ADMIN, 'revoked', 999, auditId, randomUUID()]),
                '40001',
                'stale membership version',
            );
            await rejectCode(
                changeMembership([MEMBER_RECRUITER, ROLE_A_RECRUITER, 'invited', 2, auditId, randomUUID()]),
                '22023',
                'unsupported status',
            );
            await rejectCode(
                changeMembership([MEMBER_CUSTOM, null, 'active', 1, auditId, randomUUID()]),
                '22023',
                'null role',
            );
            await rejectCode(
                changeMembership([MEMBER_CUSTOM, ROLE_A_VIEWER, 'active', 1, auditId, randomUUID()]),
                '42501',
                'viewer role assignment',
            );
            await rejectCode(
                changeMembership([MEMBER_CUSTOM, ROLE_A_INACTIVE, 'active', 1, auditId, randomUUID()]),
                '42501',
                'inactive role assignment',
            );
            await rejectCode(
                changeMembership([MEMBER_RECRUITER, ROLE_A_RECRUITER, 'revoked', 2, auditId, randomUUID()]),
                '22023',
                'revocation cannot reassign role',
            );

            const recruiterVersion = roleVersion(pg17, ROLE_A_RECRUITER);
            await rejectCode(
                changeGrants([ROLE_A_RECRUITER, 999, '{}', '{jobs.read}', auditId, randomUUID()]),
                '40001',
                'stale role version',
            );
            await rejectCode(
                changeGrants([ROLE_A_RECRUITER, recruiterVersion, '{}', '{unknown.key}', auditId, randomUUID()]),
                '22023',
                'unknown permission key',
            );
            await rejectCode(
                changeGrants([ROLE_A_RECRUITER, recruiterVersion, '{jobs.read}', '{jobs.read}', auditId, randomUUID()]),
                '22023',
                'intersecting grant and revoke sets',
            );
            await rejectCode(
                changeGrants([ROLE_A_RECRUITER, recruiterVersion, '{}', '{}', auditId, randomUUID()]),
                '22023',
                'empty grant and revoke sets',
            );
            await rejectCode(
                changeGrants([ROLE_A_RECRUITER, recruiterVersion, '{retired.key}', '{}', auditId, randomUUID()]),
                '22023',
                'retired permission grant',
            );
            await rejectCode(
                changeGrants([ROLE_A_ADMIN, 1, '{}', '{staff.manage}', auditId, randomUUID()]),
                '42501',
                'protected admin grant revocation',
            );
            await rejectCode(
                changeGrants([ROLE_A_RECRUITER, recruiterVersion, '{staff.manage}', '{}', auditId, randomUUID()]),
                '42501',
                'admin-only grant to recruiter role',
            );
            await rejectCode(
                changeGrants([ROLE_A_CUSTOM, 1, '{candidates.merge}', '{}', auditId, randomUUID()]),
                '42501',
                'admin-only grant to custom role',
            );
            await rejectCode(
                changeGrants([randomUUID(), 1, '{}', '{jobs.read}', auditId, randomUUID()]),
                'P0002',
                'missing role',
            );
            await rejectCode(
                changeGrants([ROLE_A_RECRUITER, 1, null, '{}', auditId, randomUUID()]),
                '22023',
                'null grant array',
            );

            const duplicateAudit = randomUUID();
            const first = await changeMembership(
                [MEMBER_CUSTOM, ROLE_A_CUSTOM, 'revoked', 1, duplicateAudit, randomUUID()],
            );
            assert.equal(Number(first.rows[0].version), 2);
            const reactivated = await changeMembership(
                [MEMBER_CUSTOM, ROLE_A_CUSTOM, 'active', 2, randomUUID(), randomUUID()],
            );
            assert.equal(Number(reactivated.rows[0].version), 3);
            await rejectCode(
                changeMembership([MEMBER_CUSTOM, ROLE_A_CUSTOM, 'revoked', 3, duplicateAudit, randomUUID()]),
                '23505',
                'duplicate audit id rolls back the mutation',
            );
            const after = await admin.query(
                'select status, version from app.organization_memberships where id = $1',
                [MEMBER_CUSTOM],
            );
            assert.equal(after.rows[0].status, 'active');
            assert.equal(Number(after.rows[0].version), 3);

            const disabledRevoke = await changeMembership(
                [MEMBER_DISABLED, ROLE_A_RECRUITER, 'revoked', 1, randomUUID(), randomUUID()],
            );
            assert.equal(Number(disabledRevoke.rows[0].version), 2);
            assert.equal(
                scalar(pg17, `select count(*) from app.audit_events where id = '${auditId}'`),
                '0',
            );
        } finally {
            client.release();
        }
    });

    await t.test('raw mutation calls deny non-admin actors and bad context', async () => {
        const client = await pool.connect();
        try {
            const auditCount = () => Number(scalar(
                pg17,
                `select count(*) from app.audit_events where organization_id = '${ORG_A}'`,
            ));
            const baselineAudit = auditCount();
            const memberVersionBefore = membershipVersion(pg17, MEMBER_CUSTOM);
            await client.query(
                `select
                    pg_catalog.set_config('app.actor_id', '', false),
                    pg_catalog.set_config('app.organization_id', '', false)`,
            );
            const changeMembership = (args) => client.query(
                'select * from app.change_membership_v1($1, $2, $3, $4, $5, $6)',
                args,
            );
            const changeGrants = (args) => client.query(
                'select * from app.change_role_grants_v1($1, $2, $3, $4, $5, $6)',
                args,
            );
            const membershipArgs = () => [
                MEMBER_CUSTOM, ROLE_A_CUSTOM, 'revoked',
                membershipVersion(pg17, MEMBER_CUSTOM), randomUUID(), randomUUID(),
            ];
            const grantsArgs = () => [
                ROLE_A_CUSTOM, roleVersion(pg17, ROLE_A_CUSTOM),
                '{jobs.read}', '{}', randomUUID(), randomUUID(),
            ];

            await rejectCode(changeMembership(membershipArgs()), '42501', 'missing context');
            await rejectCode(changeGrants(grantsArgs()), '42501', 'missing context grants');
            await setSessionContext(client, 'not-a-uuid', ORG_A);
            await rejectCode(changeMembership(membershipArgs()), '42501', 'malformed actor context');
            await setSessionContext(client, USER_ADMIN1, 'not-a-uuid');
            await rejectCode(changeMembership(membershipArgs()), '42501', 'malformed org context');

            for (const [actor, label] of [
                [USER_RECRUITER, 'recruiter'],
                [USER_CUSTOM, 'custom role'],
                [USER_VIEWER, 'viewer'],
            ]) {
                await setSessionContext(client, actor, ORG_A);
                await rejectCode(
                    changeMembership(membershipArgs()),
                    '42501',
                    `${label} membership mutation`,
                );
                await rejectCode(
                    changeGrants(grantsArgs()),
                    '42501',
                    `${label} grant mutation`,
                );
            }

            await setSessionContext(client, USER_ADMIN1, ORG_A);
            await rejectCode(
                changeMembership([
                    MEMBER_RECRUITER, ROLE_B_ADMIN, 'active',
                    membershipVersion(pg17, MEMBER_RECRUITER), randomUUID(), randomUUID(),
                ]),
                'P0002',
                'cross-org role assignment',
            );
            await rejectCode(
                changeGrants([
                    ROLE_B_ADMIN, roleVersion(pg17, ROLE_B_ADMIN),
                    '{jobs.read}', '{}', randomUUID(), randomUUID(),
                ]),
                'P0002',
                'cross-org role target',
            );

            assert.equal(auditCount(), baselineAudit, 'denied calls must not audit');
            assert.equal(membershipVersion(pg17, MEMBER_CUSTOM), memberVersionBefore);
            const memberState = await admin.query(
                'select status, version from app.organization_memberships where id = $1',
                [MEMBER_CUSTOM],
            );
            assert.equal(memberState.rows[0].status, 'active');
            const customState = await admin.query(
                `select count(*) as grants from app.role_permissions
                 where organization_id = $1 and role_id = $2`,
                [ORG_A, ROLE_A_CUSTOM],
            );
            assert.equal(Number(customState.rows[0].grants), 2);
        } finally {
            await client.query(
                `select
                    pg_catalog.set_config('app.actor_id', '', false),
                    pg_catalog.set_config('app.organization_id', '', false)`,
            ).catch(() => {});
            client.release();
        }
    });

    await t.test('revocation is observed by the next request and resolver', async () => {
        const revoked = await withStaffTransaction(
            pool,
            identity(SUBJECTS.ADMIN1),
            ORG_A,
            ['staff.manage'],
            async ({ client }) => (await client.query(
                'select version from app.change_membership_v1($1, $2, $3, $4, $5, $6)',
                [
                    MEMBER_RECRUITER,
                    ROLE_A_CUSTOM,
                    'revoked',
                    membershipVersion(pg17, MEMBER_RECRUITER),
                    randomUUID(),
                    randomUUID(),
                ],
            )).rows[0],
        );
        assert.equal(Number(revoked.version), 3);
        await assert.rejects(
            withStaffTransaction(
                pool,
                identity(SUBJECTS.RECRUITER),
                ORG_A,
                ['candidates.read'],
                () => {},
            ),
            (error) => error.code === 'UNAUTHORIZED',
        );

        const resolving = await pool.query(
            'select count(*) as hits from app.resolve_staff_principal_v1($1, $2, $3, $4)',
            ['google', GOOGLE_ISSUER, SUBJECTS.RECRUITER, ORG_A],
        );
        assert.equal(Number(resolving.rows[0].hits), 0);

        await admin.query(
            'update app.auth_identities set revoked_at = now() where provider_subject = $1',
            [SUBJECTS.ADMIN2],
        );
        const denied = await pool.query(
            'select count(*) as hits from app.resolve_staff_principal_v1($1, $2, $3, $4)',
            ['google', GOOGLE_ISSUER, SUBJECTS.ADMIN2, ORG_A],
        );
        assert.equal(Number(denied.rows[0].hits), 0);
        await admin.query(
            'update app.auth_identities set revoked_at = null where provider_subject = $1',
            [SUBJECTS.ADMIN2],
        );
    });

    await t.test('grant changes are observed by the next request on a reused connection', async () => {
        const single = new pg.Pool({ ...staffPoolOptions(pg17, runtimePassword, 1), max: 1 });
        const adminGrants = (grantKeys, revokeKeys) => withStaffTransaction(
            pool,
            identity(SUBJECTS.ADMIN1),
            ORG_A,
            ['staff.manage', 'roles.manage'],
            async ({ client }) => (await client.query(
                'select role_id, version from app.change_role_grants_v1($1, $2, $3, $4, $5, $6)',
                [
                    ROLE_A_CUSTOM,
                    roleVersion(pg17, ROLE_A_CUSTOM),
                    grantKeys,
                    revokeKeys,
                    randomUUID(),
                    randomUUID(),
                ],
            )).rows[0],
        );
        const customRequest = (keys) => withStaffTransaction(
            single,
            identity(SUBJECTS.CUSTOM),
            ORG_A,
            keys,
            async () => 'ok',
        );
        try {
            assert.equal(await customRequest(['candidates.read']), 'ok');

            const granted = await adminGrants('{candidates.write}', '{}');
            assert.equal(
                (await admin.query(
                    `select granted_by_user_id from app.role_permissions
                     where organization_id = $1 and role_id = $2
                        and permission_key = 'candidates.write'`,
                    [ORG_A, ROLE_A_CUSTOM],
                )).rows[0].granted_by_user_id,
                USER_ADMIN1,
                'grant must record the acting user',
            );
            assert.equal(
                await customRequest(['candidates.write']),
                'ok',
                'newly granted key is usable on the reused connection',
            );

            await adminGrants('{}', '{candidates.read}');
            await assert.rejects(
                customRequest(['candidates.read']),
                (error) => error.code === 'FORBIDDEN',
                'revoked key must be denied on the next request',
            );

            const retiredRevoke = await adminGrants('{}', '{retired.key}');
            assert.equal(
                scalar(pg17, `select count(*) from app.role_permissions
                    where organization_id = '${ORG_A}' and role_id = '${ROLE_A_CUSTOM}'
                        and permission_key = 'retired.key'`),
                '0',
                'revoking a retired grant is allowed',
            );
            assert.ok(Number(retiredRevoke.version) > Number(granted.version));

            await adminGrants('{candidates.read}', '{}');
            await rejectCode(
                adminGrants('{retired.key}', '{}'),
                '22023',
                'retired grant cannot be restored through runtime',
            );
            assert.equal(await customRequest(['candidates.read']), 'ok');
        } finally {
            await admin.query(
                `insert into app.role_permissions (organization_id, role_id, permission_key)
                 values ($1, $2, 'candidates.read'), ($1, $2, 'retired.key')
                 on conflict do nothing`,
                [ORG_A, ROLE_A_CUSTOM],
            ).catch(() => {});
            await single.end();
        }
    });

    await t.test('raw table and internal-role access stay denied for runtime staff', async () => {
        const client = await pool.connect();
        try {
            const tables = [
                'organizations', 'users', 'auth_identities', 'permissions', 'roles',
                'role_permissions', 'organization_memberships', 'clients', 'pipelines',
                'pipeline_stages', 'jobs', 'candidates', 'candidate_sources',
                'candidate_identifiers', 'applications', 'application_stage_history',
                'audit_events',
            ];
            for (const table of tables) {
                await rejectCode(
                    client.query(`select * from app.${table}`),
                    '42501',
                    `select on ${table}`,
                );
            }
            const writes = [
                `insert into app.role_permissions (organization_id, role_id, permission_key)
                    values ('${ORG_A}', '${ROLE_A_CUSTOM}', 'clients.read')`,
                `update app.organization_memberships set status = 'revoked'
                    where id = '${MEMBER_CUSTOM}'`,
                `delete from app.roles where id = '${ROLE_A_CUSTOM}'`,
                `update app.users set status = 'disabled' where id = '${USER_CUSTOM}'`,
                `insert into app.audit_events (id, organization_id, actor_kind, action,
                    target_type, correlation_id, occurred_at)
                    values ('${randomUUID()}', '${ORG_A}', 'migration', 'x', 'y',
                    '${randomUUID()}', now())`,
                `update app.roles set status = 'inactive' where id = '${ROLE_A_CUSTOM}'`,
                `delete from app.role_permissions where organization_id = '${ORG_A}'`,
                `update app.audit_events set action = 'tampered'`,
                `delete from app.audit_events`,
                `delete from app.application_stage_history`,
            ];
            for (const statement of writes) {
                await rejectCode(client.query(statement), '42501', statement.slice(0, 60));
            }
            for (const role of ['app_owner', 'app_executor', 'app_authz_reader']) {
                await rejectCode(
                    client.query(`set role ${role}`),
                    '42501',
                    `set role ${role}`,
                );
            }
        } finally {
            client.release();
        }

        for (const role of ['app_intake', 'app_worker']) {
            assertSqlstate(
                pg17,
                `set role ${role}; select app.has_permission_v1('candidates.read');`,
                '42501',
            );
            assertSqlstate(
                pg17,
                `set role ${role};
                 select * from app.resolve_staff_principal_v1(
                    'github', '${GITHUB_ISSUER}', '1', '${ORG_A}');`,
                '42501',
            );
            assertSqlstate(
                pg17,
                `set role ${role};
                 select * from app.change_role_grants_v1(
                    '${ROLE_A_RECRUITER}', 1, '{}', '{jobs.read}',
                    '${randomUUID()}', '${randomUUID()}');`,
                '42501',
            );
        }
    });

    await t.test('catalog: function owners, ACLs, schema privileges and audit constraints', () => {
        const functions = scalar(pg17, `
            select p.proname || ':' || p.prosecdef || ':' || r.rolname || ':' ||
                coalesce(p.proconfig::text, '')
            from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            join pg_roles r on r.oid = p.proowner
            where n.nspname = 'app'
            order by p.proname
        `).split('\n');
        assert.equal(functions.length, 10);
        const expected = {
            'app.change_membership_v1': ['t', 'app_executor'],
            'app.change_role_grants_v1': ['t', 'app_executor'],
            'app.claim_staff_invite_v1': ['t', 'app_executor'],
            'app.context_uuid_v1': ['f', 'app_owner'],
            'app.has_permission_v1': ['t', 'app_authz_reader'],
            'app.invite_staff_member_v1': ['t', 'app_executor'],
            'app.resolve_staff_principal_v1': ['t', 'app_authz_reader'],
            'app.set_staff_invite_domains_v1': ['t', 'app_executor'],
            'app.staff_directory_v1': ['t', 'app_executor'],
            'app.valid_domain_list_v1': ['f', 'app_owner'],
        };
        for (const line of functions) {
            const name = `app.${line.split(':')[0]}`;
            const [, secdef, owner, config] = line.split(':');
            assert.deepEqual(
                [secdef === 'true', owner],
                expected[name].map((value, index) => (index === 0 ? value === 't' : value)),
                `${name} security definer and owner`,
            );
            assert.match(config, /search_path=pg_catalog, app, pg_temp/);
        }

        const grants = scalar(pg17, `
            select p.proname,
                string_agg(coalesce(grantee_role.rolname, '<public>'), ','
                    order by coalesce(grantee_role.rolname, '<public>'))
            from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            cross join lateral aclexplode(
                coalesce(p.proacl, acldefault('f', p.proowner))
            ) acl
            left join pg_roles grantee_role on grantee_role.oid = acl.grantee
            where n.nspname = 'app' and acl.privilege_type = 'EXECUTE'
            group by p.proname
            order by p.proname
        `).split('\n');
        const expectedGrants = {
            change_membership_v1: 'app_executor,app_staff',
            change_role_grants_v1: 'app_executor,app_staff',
            claim_staff_invite_v1: 'app_executor,app_staff',
            context_uuid_v1: 'app_authz_reader,app_executor,app_owner,app_staff',
            has_permission_v1: 'app_authz_reader,app_executor,app_staff',
            invite_staff_member_v1: 'app_executor,app_staff',
            resolve_staff_principal_v1: 'app_authz_reader,app_staff',
            set_staff_invite_domains_v1: 'app_executor,app_staff',
            staff_directory_v1: 'app_executor,app_staff',
            valid_domain_list_v1: 'app_executor,app_owner',
        };
        for (const line of grants) {
            const [name, grantees] = line.split('|');
            assert.equal(grantees, expectedGrants[name], `${name} execute grantees`);
        }
        assert.equal(scalar(pg17, `
            select coalesce(bool_or(acl.grantee = 0), false)
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            cross join lateral aclexplode(
                coalesce(p.proacl, acldefault('f', p.proowner))
            ) acl
            where n.nspname = 'app'
        `), 'f');

        const schemaChecks = [
            ['app_staff', 'usage', 't'],
            ['app_staff', 'create', 'f'],
            ['app_executor', 'usage', 't'],
            ['app_executor', 'create', 'f'],
            ['app_authz_reader', 'usage', 't'],
            ['app_authz_reader', 'create', 'f'],
            ['app_intake', 'usage', 'f'],
            ['app_worker', 'usage', 'f'],
        ];
        for (const [role, privilege, expectedValue] of schemaChecks) {
            assert.equal(
                scalar(pg17, `select has_schema_privilege('${role}', 'app', '${privilege}')`),
                expectedValue,
                `${role} ${privilege}`,
            );
        }
        assert.equal(scalar(pg17, `
            select count(*) from pg_auth_members m
            join pg_roles member_role on member_role.oid = m.member
            where member_role.rolname = '${RUNTIME_ROLE}'
                and m.roleid <> 'app_staff'::regrole
        `), '0');
        assert.equal(scalar(pg17, `
            select count(*) from pg_policies
            where schemaname = 'app' and tablename in (
                'clients', 'pipelines', 'pipeline_stages', 'jobs', 'candidates',
                'candidate_sources', 'candidate_identifiers', 'applications',
                'application_stage_history'
            )
        `), '0');
        assert.equal(scalar(pg17, `
            select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'app' and c.relkind = 'r'
        `), '17');
        assert.equal(scalar(pg17, `
            select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'app' and c.relkind = 'r'
                and (not c.relrowsecurity or not c.relforcerowsecurity)
        `), '0');

        const auditId = randomUUID();
        const membershipDetails = `jsonb_build_object(
            'previous_role_id', '${ROLE_A_RECRUITER}',
            'new_role_id', '${ROLE_A_CUSTOM}',
            'previous_status', 'active',
            'new_status', 'revoked',
            'previous_version', 1,
            'new_version', 2
        )`;
        assertSqlstate(pg17, `
            insert into app.audit_events (id, organization_id, actor_kind, actor_user_id,
                actor_membership_id, action, target_type, target_id, correlation_id,
                occurred_at, details)
            values ('${auditId}', '${ORG_B}', 'staff', '${USER_ADMIN1}',
                '${MEMBER_ADMIN1}', 'staff.membership.changed', 'organization_membership',
                '${MEMBER_CUSTOM}', '${randomUUID()}', now(), ${membershipDetails})
        `, '23503');
        assertSqlstate(pg17, `
            insert into app.audit_events (id, organization_id, actor_kind, actor_user_id,
                actor_membership_id, action, target_type, target_id, correlation_id,
                occurred_at, details)
            values ('${randomUUID()}', '${ORG_A}', 'staff', '${USER_ADMIN2}',
                '${MEMBER_ADMIN1}', 'staff.membership.changed', 'organization_membership',
                '${MEMBER_CUSTOM}', '${randomUUID()}', now(), ${membershipDetails})
        `, '23503');
        assertSqlstate(pg17, `
            insert into app.audit_events (id, organization_id, actor_kind, actor_user_id,
                actor_membership_id, action, target_type, target_id, correlation_id,
                occurred_at, details)
            values ('${randomUUID()}', '${ORG_A}', 'staff', '${USER_ADMIN1}',
                '${MEMBER_ADMIN1}', 'staff.membership.changed', 'organization_membership',
                '${MEMBER_CUSTOM}', '${randomUUID()}', now(),
                jsonb_build_object('unexpected', 'key'))
        `, '23514');
        assertSqlstate(pg17, `
            insert into app.audit_events (id, organization_id, actor_kind, actor_user_id,
                actor_membership_id, action, target_type, target_id, correlation_id,
                occurred_at, details)
            values ('${randomUUID()}', '${ORG_A}', 'staff', '${USER_ADMIN1}',
                '${MEMBER_ADMIN1}', 'staff.membership.changed', 'organization_membership',
                '${MEMBER_CUSTOM}', '${randomUUID()}', now(),
                jsonb_build_object('previous_role_id', repeat('x', 5000)))
        `, '23514');
        assertSqlstate(pg17, `
            insert into app.audit_events (id, organization_id, actor_kind, actor_user_id,
                actor_membership_id, action, target_type, target_id, correlation_id,
                occurred_at, details)
            values ('${randomUUID()}', '${ORG_A}', 'staff', null,
                null, 'staff.membership.changed', 'organization_membership',
                '${MEMBER_CUSTOM}', '${randomUUID()}', now(), ${membershipDetails})
        `, '23514');
        assertSqlstate(pg17, `
            insert into app.audit_events (id, organization_id, actor_kind, actor_user_id,
                actor_membership_id, action, target_type, target_id, correlation_id,
                occurred_at, details)
            values ('${randomUUID()}', '${ORG_A}', 'staff', '${USER_ADMIN1}',
                '${MEMBER_ADMIN1}', 'staff.unlisted.action', 'organization_membership',
                '${MEMBER_CUSTOM}', '${randomUUID()}', now(), '{}')
        `, '23514');
    });

    await t.test('lock waiters recheck authority after the organization lock', async () => {
        const lockWaiterDenial = async ({ applyDenial, restoreDenial, label }) => {
            await admin.query('begin');
            await admin.query(
                'select id from app.organizations where id = $1 for update',
                [ORG_A],
            );
            const waiterClient = await pool.connect();
            const waiterPid = Number((await waiterClient.query(
                'select pg_backend_pid() as pid',
            )).rows[0].pid);
            const auditProbe = randomUUID();
            const waiter = (async () => {
                try {
                    await waiterClient.query('begin');
                    await setLocalContext(waiterClient, USER_ADMIN1, ORG_A);
                    const result = await waiterClient.query(
                        'select * from app.change_membership_v1($1, $2, $3, $4, $5, $6)',
                        [
                            MEMBER_CUSTOM,
                            ROLE_A_CUSTOM,
                            'revoked',
                            membershipVersion(pg17, MEMBER_CUSTOM),
                            auditProbe,
                            randomUUID(),
                        ],
                    );
                    await waiterClient.query('commit');
                    return result.rows;
                } catch (error) {
                    await waiterClient.query('rollback').catch(() => {});
                    throw error;
                } finally {
                    waiterClient.release();
                }
            })();
            const waiterOutcome = waiter.then(
                (value) => ({ value }),
                (error) => ({ error }),
            );
            let lastSeen = null;
            try {
                await waitFor(async () => {
                    const settled = await Promise.race([
                        waiterOutcome,
                        Promise.resolve(null),
                    ]);
                    if (settled?.error) {
                        throw settled.error;
                    }
                    const waiting = await admin.query(
                        `select locktype, mode from pg_locks
                         where pid = $1 and not granted`,
                        [waiterPid],
                    );
                    lastSeen = waiting.rows;
                    return waiting.rows.length > 0;
                }, `waiting mutation to block on the organization lock (${label})`)
                    .catch((error) => {
                        throw new Error(
                            `${error.message} last seen: ${JSON.stringify(lastSeen)}`,
                        );
                    });
                await applyDenial();
                await admin.query('commit');
            } catch (error) {
                await admin.query('rollback').catch(() => {});
                await waiterOutcome;
                throw error;
            }
            const outcome = await waiterOutcome;
            assert.ok(outcome.error, `${label}: waiter must recheck after lock`);
            assert.equal(outcome.error.code, '42501', `${label}: waiter must recheck after lock`);
            assert.equal(auditRows(pg17, auditProbe), '0', `${label}: no audit row`);
            await restoreDenial();
        };

        await lockWaiterDenial({
            label: 'actor membership revoked while waiting',
            applyDenial: () => admin.query(
                `update app.organization_memberships
                 set status = 'revoked', revoked_at = now(), version = version + 1,
                    updated_at = now()
                 where id = $1`,
                [MEMBER_ADMIN1],
            ),
            restoreDenial: () => admin.query(
                `update app.organization_memberships
                 set status = 'active', revoked_at = null,
                    activated_at = coalesce(activated_at, now()),
                    version = version + 1, updated_at = now()
                 where id = $1`,
                [MEMBER_ADMIN1],
            ),
        });
        await lockWaiterDenial({
            label: 'actor grant removed while waiting',
            applyDenial: () => admin.query(
                `delete from app.role_permissions
                 where organization_id = $1 and role_id = $2
                    and permission_key = 'staff.manage'`,
                [ORG_A, ROLE_A_ADMIN],
            ),
            restoreDenial: () => admin.query(
                `insert into app.role_permissions
                    (organization_id, role_id, permission_key)
                 values ($1, $2, 'staff.manage') on conflict do nothing`,
                [ORG_A, ROLE_A_ADMIN],
            ),
        });
    });

    await t.test('concurrent self-revocation can never remove the last admin', async () => {
        const auditA = randomUUID();
        const auditB = randomUUID();
        const revokeSelf = async (client, actor, membership, auditId) => {
            try {
                await client.query('begin');
                await setLocalContext(client, actor, ORG_B);
                const result = await client.query(
                    'select * from app.change_membership_v1($1, $2, $3, $4, $5, $6)',
                    [membership, ROLE_B_ADMIN, 'revoked', 1, auditId, randomUUID()],
                );
                await client.query('commit');
                return result.rows[0];
            } catch (error) {
                await client.query('rollback').catch(() => {});
                throw error;
            } finally {
                client.release();
            }
        };

        await admin.query('begin');
        await admin.query(
            'select id from app.organizations where id = $1 for update',
            [ORG_B],
        );
        const clientA = await pool.connect();
        const clientB = await pool.connect();
        const pidA = Number((await clientA.query('select pg_backend_pid() as pid')).rows[0].pid);
        const pidB = Number((await clientB.query('select pg_backend_pid() as pid')).rows[0].pid);
        const waiterA = revokeSelf(clientA, USER_ADMIN2, MEMBER_B_ADMIN, auditA)
            .then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason }));
        const waiterB = revokeSelf(clientB, USER_SHARED, MEMBER_SHARED_B, auditB)
            .then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason }));
        try {
            await waitFor(async () => {
                const waiting = await admin.query(
                    `select pid from pg_locks
                     where not granted and pid = any($1::int[])`,
                    [[pidA, pidB]],
                );
                return waiting.rows.length === 2;
            }, 'both self-revocations to wait on the organization lock');
            await admin.query('commit');
        } catch (error) {
            await admin.query('rollback').catch(() => {});
            await Promise.allSettled([waiterA, waiterB]);
            throw error;
        }
        const [first, second] = await Promise.all([waiterA, waiterB]);
        const outcomes = [first, second];
        const fulfilled = outcomes.filter(({ status }) => status === 'fulfilled');
        const rejected = outcomes.filter(({ status }) => status === 'rejected');
        assert.equal(fulfilled.length, 1, 'exactly one self-revoke may commit');
        assert.equal(rejected.length, 1);
        assert.equal(rejected[0].reason.code, '23514');
        const failedAudit = first.status === 'rejected' ? auditA : auditB;
        assert.equal(auditRows(pg17, failedAudit), '0', 'loser must not audit');
        assert.equal(
            scalar(pg17, `
                select count(*) from app.organization_memberships m
                join app.roles r
                    on r.organization_id = m.organization_id and r.id = m.role_id
                where m.organization_id = '${ORG_B}' and m.status = 'active'
                    and r.system_kind = 'admin'
            `),
            '1',
        );

        const survivor = (await admin.query(
            `select m.id, m.user_id, m.version from app.organization_memberships m
             join app.roles r
                on r.organization_id = m.organization_id and r.id = m.role_id
             where m.organization_id = $1 and m.status = 'active'
                and r.system_kind = 'admin'`,
            [ORG_B],
        )).rows[0];
        const survivorVersion = Number(survivor.version);
        const survivorAuditId = randomUUID();
        const auditBefore = Number(scalar(pg17,
            `select count(*) from app.audit_events where organization_id = '${ORG_B}'`));
        const sequentialClient = await pool.connect();
        try {
            await sequentialClient.query('begin');
            await setLocalContext(sequentialClient, survivor.user_id, ORG_B);
            await rejectCode(
                sequentialClient.query(
                    'select * from app.change_membership_v1($1, $2, $3, $4, $5, $6)',
                    [survivor.id, ROLE_B_ADMIN, 'revoked', survivorVersion,
                        survivorAuditId, randomUUID()],
                ),
                '23514',
                'sequential last-admin self-revoke',
            );
            await sequentialClient.query('rollback');
        } finally {
            sequentialClient.release();
        }
        const survivorAfter = (await admin.query(
            'select status, version from app.organization_memberships where id = $1',
            [survivor.id],
        )).rows[0];
        assert.equal(survivorAfter.status, 'active');
        assert.equal(Number(survivorAfter.version), survivorVersion);
        assert.equal(auditRows(pg17, survivorAuditId), '0');
        assert.equal(Number(scalar(pg17,
            `select count(*) from app.audit_events where organization_id = '${ORG_B}'`)),
        auditBefore);
        assert.equal(
            scalar(pg17, `select count(*) from app.audit_events
                where organization_id = '${ORG_B}'`),
            '1',
        );
    });

    await t.test('staff invites bind a first sign-in to the pending membership', async () => {
        const invitedUser = randomUUID();
        const invitedMembership = randomUUID();
        const inviteAuditId = randomUUID();
        const newSubject = '70707';

        const claim = async (email, subject, provider = 'google') => {
            const ids = {
                identityId: randomUUID(),
                auditId: randomUUID(),
                correlationId: randomUUID(),
            };
            const client = await pool.connect();
            try {
                await client.query('begin isolation level read committed');
                await client.query(
                    `select pg_catalog.set_config('app.organization_id', $1, true)`,
                    [ORG_A],
                );
                const result = await client.query(
                    `select user_id, membership_id, role_id
                       from app.claim_staff_invite_v1($1, $2, $3, $4, $5, $6, $7)`,
                    [
                        ids.identityId, provider,
                        provider === 'google' ? GOOGLE_ISSUER : GITHUB_ISSUER,
                        subject, email, ids.auditId, ids.correlationId,
                    ],
                );
                await client.query('commit');
                return { ids, principal: result.rows[0] ?? null };
            } catch (error) {
                await client.query('rollback').catch(() => {});
                throw error;
            } finally {
                client.release();
            }
        };

        const invite = await withStaffTransaction(
            pool,
            identity(SUBJECTS.ADMIN1),
            ORG_A,
            ['staff.manage'],
            async ({ client }) => (await client.query(
                'select app.invite_staff_member_v1($1, $2, $3, $4, $5, $6, $7) as result',
                [
                    invitedUser, invitedMembership, 'New Hire',
                    'New.Hire@Example.COM', ROLE_A_RECRUITER,
                    inviteAuditId, randomUUID(),
                ],
            )).rows[0].result,
        );
        assert.equal(invite.membershipId, invitedMembership);
        assert.equal(invite.userId, invitedUser);
        assert.equal(invite.email, 'new.hire@example.com');

        const pending = (await admin.query(
            `select status, invited_email, activated_at, version
               from app.organization_memberships where id = $1`,
            [invitedMembership],
        )).rows[0];
        assert.equal(pending.status, 'invited');
        assert.equal(pending.invited_email, 'new.hire@example.com');
        assert.equal(pending.activated_at, null);

        const inviteAudit = (await admin.query(
            `select action, target_type, target_id, actor_user_id,
                actor_membership_id, details
               from app.audit_events where id = $1`,
            [inviteAuditId],
        )).rows[0];
        assert.equal(inviteAudit.action, 'staff.member.invited');
        assert.equal(inviteAudit.target_type, 'organization_membership');
        assert.equal(inviteAudit.target_id, invitedMembership);
        assert.equal(inviteAudit.actor_user_id, USER_ADMIN1);
        assert.equal(inviteAudit.actor_membership_id, MEMBER_ADMIN1);
        assert.deepEqual(inviteAudit.details, {
            user_id: invitedUser,
            role_id: ROLE_A_RECRUITER,
        });

        const unresolved = await pool.query(
            'select count(*) as hits'
                + ' from app.resolve_staff_principal_v1($1, $2, $3, $4)',
            ['google', GOOGLE_ISSUER, newSubject, ORG_A],
        );
        assert.equal(unresolved.rows[0].hits, '0');

        // A different verified email finds no pending invite.
        assert.equal(
            (await claim('someone-else@example.com', newSubject)).principal,
            null,
        );

        // The invited email claims: the subject binds and the membership
        // activates — matching is case-insensitive on the stored email.
        const claimed = await claim('NEW.HIRE@example.com', newSubject);
        assert.equal(claimed.principal.user_id, invitedUser);
        assert.equal(claimed.principal.membership_id, invitedMembership);
        assert.equal(claimed.principal.role_id, ROLE_A_RECRUITER);

        const after = (await admin.query(
            `select status, activated_at, version
               from app.organization_memberships where id = $1`,
            [invitedMembership],
        )).rows[0];
        assert.equal(after.status, 'active');
        assert.ok(after.activated_at !== null);
        assert.equal(Number(after.version), 2);

        const boundIdentity = (await admin.query(
            `select provider_subject, verified_at, revoked_at
               from app.auth_identities where id = $1`,
            [claimed.ids.identityId],
        )).rows[0];
        assert.equal(boundIdentity.provider_subject, newSubject);
        assert.ok(boundIdentity.verified_at !== null);
        assert.equal(boundIdentity.revoked_at, null);

        const claimAudit = (await admin.query(
            `select action, actor_user_id, actor_membership_id, target_id, details
               from app.audit_events where id = $1`,
            [claimed.ids.auditId],
        )).rows[0];
        assert.equal(claimAudit.action, 'staff.invite.claimed');
        assert.equal(claimAudit.actor_user_id, invitedUser);
        assert.equal(claimAudit.actor_membership_id, invitedMembership);
        assert.equal(claimAudit.target_id, invitedMembership);
        assert.deepEqual(claimAudit.details, {
            identity_id: claimed.ids.identityId,
        });

        const resolved = await pool.query(
            'select user_id, membership_id, role_id'
                + ' from app.resolve_staff_principal_v1($1, $2, $3, $4)',
            ['google', GOOGLE_ISSUER, newSubject, ORG_A],
        );
        assert.equal(resolved.rows[0].membership_id, invitedMembership);

        // The invite is consumed — a second claim finds nothing.
        assert.equal(
            (await claim('new.hire@example.com', '80808')).principal,
            null,
        );
        const reinvite = () => withStaffTransaction(
            pool, identity(SUBJECTS.ADMIN1), ORG_A, ['staff.manage'],
            async ({ client }) => (await client.query(
                'select app.invite_staff_member_v1($1,$2,$3,$4,$5,$6,$7) as result',
                [randomUUID(), randomUUID(), 'Returning hire', 'new.hire@example.com',
                    ROLE_A_RECRUITER, randomUUID(), randomUUID()],
            )).rows[0].result,
        );
        await assert.rejects(reinvite, (error) => error.code === '23505');
        await admin.query(`update app.organization_memberships
            set status = 'revoked', revoked_at = now(), version = version + 1 where id = $1`,
        [invitedMembership]);
        const returning = await reinvite();
        assert.equal(returning.userId, invitedUser);
        assert.equal(returning.membershipId, invitedMembership);
        // Matching email alone cannot replace the originally bound account.
        await assert.rejects(() => claim('new.hire@example.com', '90909'),
            (error) => error.code === '42501');
        const reclaimed = await claim('new.hire@example.com', newSubject);
        assert.equal(reclaimed.principal.membership_id, invitedMembership);
        assert.equal((await admin.query(
            'select count(*) as count from app.auth_identities where user_id = $1',
            [invitedUser],
        )).rows[0].count, '1');
        await admin.query(`update app.organization_memberships
            set status = 'revoked', revoked_at = now(), version = version + 1 where id = $1`,
        [invitedMembership]);
        await reinvite();
        await admin.query('update app.auth_identities set revoked_at = now() where user_id = $1',
            [invitedUser]);
        await assert.rejects(() => claim('new.hire@example.com', newSubject),
            (error) => error.code === '42501');
    });

    await t.test('staff invites deny invalid or unauthorized paths', async () => {
        // The recruiter fixture's membership is left revoked by an earlier
        // subtest, so create a fresh invite and claim it with a new subject —
        // that becomes the non-admin actor for the denial checks below. Each
        // step runs its own transaction — a raised error aborts everything
        // before it.
        const withOrgContext = async (fn) => {
            const client = await pool.connect();
            try {
                await client.query('begin isolation level read committed');
                await client.query(
                    `select pg_catalog.set_config('app.organization_id', $1, true)`,
                    [ORG_A],
                );
                const result = await fn(client);
                await client.query('commit');
                return result;
            } catch (error) {
                await client.query('rollback').catch(() => {});
                throw error;
            } finally {
                client.release();
            }
        };
        const claimWith = (provider, subject, email) => withOrgContext(
            (client) => client.query(
                `select user_id, membership_id, role_id
                   from app.claim_staff_invite_v1($1, $2, $3, $4, $5, $6, $7)`,
                [
                    randomUUID(), provider,
                    provider === 'google' ? GOOGLE_ISSUER : GITHUB_ISSUER,
                    subject, email, randomUUID(), randomUUID(),
                ],
            ),
        );

        await withOrgContext(async (client) => {
            await client.query(
                `select pg_catalog.set_config('app.actor_id', $1, true)`,
                [USER_ADMIN1],
            );
            await client.query(
                'select app.invite_staff_member_v1($1, $2, $3, $4, $5, $6, $7)',
                [
                    randomUUID(), randomUUID(), 'Second Invite',
                    'second@example.com', ROLE_A_RECRUITER,
                    randomUUID(), randomUUID(),
                ],
            );
        });

        // The provider gate mirrors the resolver: a GitHub subject can never
        // claim a staff invite.
        await rejectCode(
            claimWith('github', '12345', 'second@example.com'),
            '22023',
        );

        // Re-binding an already-bound subject to a different invite is a
        // uniqueness violation, not a silent reattach.
        await rejectCode(
            claimWith('google', SUBJECTS.ADMIN1, 'second@example.com'),
            '23505',
            'an already-bound subject must not claim another invite',
        );

        const claimed = await claimWith(
            'google', '90909', 'second@example.com');
        assert.ok(claimed.rows[0], 'fresh subject claims the pending invite');
        assert.notEqual(claimed.rows[0].membership_id, MEMBER_INVITED);

        const invite = (subject, permissions, args) => withStaffTransaction(
            pool,
            identity(subject),
            ORG_A,
            permissions,
            async ({ client }) => client.query(
                'select app.invite_staff_member_v1($1, $2, $3, $4, $5, $6, $7)',
                args,
            ),
        );

        // A non-admin reaches the procedure but the staff.manage assertion
        // inside it still denies.
        await rejectCode(
            invite('90909', ['candidates.read'], [
                randomUUID(), randomUUID(), 'No Perms',
                'nope@example.com', ROLE_A_RECRUITER, randomUUID(), randomUUID(),
            ]),
            '42501',
            'non-admin invite must be denied',
        );
        await rejectCode(
            invite(SUBJECTS.ADMIN1, ['staff.manage'], [
                randomUUID(), randomUUID(), 'Viewer Invite',
                'viewer@example.com', ROLE_A_VIEWER, randomUUID(), randomUUID(),
            ]),
            '42501',
            'viewer roles are not invitable',
        );
        await rejectCode(
            invite(SUBJECTS.ADMIN1, ['staff.manage'], [
                randomUUID(), randomUUID(), 'Paused Role',
                'paused@example.com', ROLE_A_INACTIVE, randomUUID(), randomUUID(),
            ]),
            '42501',
            'inactive roles are not invitable',
        );
        await rejectCode(
            invite(SUBJECTS.ADMIN1, ['staff.manage'], [
                randomUUID(), randomUUID(), 'Cross Org',
                'cross@example.com', ROLE_B_ADMIN, randomUUID(), randomUUID(),
            ]),
            'P0002',
            'roles from another organization must not resolve',
        );
        await rejectCode(
            invite(SUBJECTS.ADMIN1, ['staff.manage'], [
                randomUUID(), randomUUID(), 'Bad Email',
                'not-an-email', ROLE_A_RECRUITER, randomUUID(), randomUUID(),
            ]),
            '22023',
            'malformed invite emails are rejected',
        );
    });

    await t.test('staff directory lists members and invitable roles for admins', async () => {
        const directory = await withStaffTransaction(
            pool,
            identity(SUBJECTS.ADMIN1),
            ORG_A,
            ['staff.manage'],
            async ({ client }) => (await client.query(
                'select app.staff_directory_v1(null) as result',
            )).rows[0].result,
        );
        const memberIds = directory.members.map((m) => m.membershipId);
        assert.ok(memberIds.includes(MEMBER_ADMIN1));
        assert.ok(memberIds.includes(MEMBER_INVITED));
        assert.ok(!memberIds.includes(MEMBER_B_ADMIN), 'no cross-org members');
        const invitedRow = directory.members.find(
            (m) => m.membershipId === MEMBER_INVITED);
        assert.ok(invitedRow.invitedEmail !== undefined);
        const roleIds = directory.roles.map((r) => r.id);
        assert.ok(roleIds.includes(ROLE_A_ADMIN));
        assert.ok(roleIds.includes(ROLE_A_RECRUITER));
        assert.ok(roleIds.includes(ROLE_A_CUSTOM));
        assert.ok(
            !roleIds.includes(ROLE_A_VIEWER),
            'viewer roles are not invitable',
        );
        assert.ok(
            !roleIds.includes(ROLE_A_INACTIVE),
            'inactive roles are not invitable',
        );
        assert.ok(!roleIds.includes(ROLE_B_ADMIN), 'no cross-org roles');

        await rejectCode(
            withStaffTransaction(
                pool,
                identity('90909'),
                ORG_A,
                ['candidates.read'],
                async ({ client }) => client.query(
                    'select app.staff_directory_v1(null)'),
            ),
            '42501',
            'directory requires staff.manage',
        );
    });

    await t.test('invite domain allowlist gates invite and claim', async () => {
        const admin = identity(SUBJECTS.ADMIN1);
        const setDomains = (domains) => withStaffTransaction(
            pool, admin, ORG_A, ['staff.manage'],
            async ({ client }) => client.query(
                'select app.set_staff_invite_domains_v1($1::text[], $2::uuid, $3::uuid)',
                [domains, randomUUID(), randomUUID()],
            ),
        );
        const invite = (email, subject = SUBJECTS.ADMIN1) => withStaffTransaction(
            pool, identity(subject), ORG_A, ['staff.manage'],
            async ({ client }) => client.query(
                'select app.invite_staff_member_v1($1, $2, $3, $4, $5, $6, $7)',
                [
                    randomUUID(), randomUUID(), 'Domain Hire', email,
                    ROLE_A_RECRUITER, randomUUID(), randomUUID(),
                ],
            ),
        );
        // Claims need only the organization context — the procedure binds the
        // actor itself once the invite is claimed.
        const claim = async (subject, email) => {
            const client = await pool.connect();
            try {
                await client.query('begin isolation level read committed');
                await client.query('set local role app_staff');
                await client.query(
                    `select pg_catalog.set_config('app.organization_id', $1, true)`,
                    [ORG_A],
                );
                const result = await client.query(
                    `select user_id, membership_id, role_id
                       from app.claim_staff_invite_v1($1, $2, $3, $4, $5, $6, $7)`,
                    [
                        randomUUID(), 'google', GOOGLE_ISSUER, subject, email,
                        randomUUID(), randomUUID(),
                    ],
                );
                await client.query('commit');
                return result;
            } catch (error) {
                await client.query('rollback').catch(() => {});
                throw error;
            } finally {
                client.release();
            }
        };

        // No allowlist configured — any verified email domain is invitable.
        await invite('anyone@elsewhere.example');

        await setDomains(['allowed.example']);
        assert.equal(
            scalar(pg17,
                `select staff_invite_domains::text from app.organizations
                    where id = '${ORG_A}'`),
            '{allowed.example}',
            'allowlist is stored normalized',
        );

        await rejectCode(
            invite('denied@blocked.example'),
            '42501',
            'a domain outside the allowlist must not be invitable',
        );
        await rejectCode(
            invite('denied@sub.allowed.example'),
            '42501',
            'subdomains of an allowed domain are not implied',
        );
        const invited = await invite('hire@allowed.example');
        assert.equal(invited.rows[0].invite_staff_member_v1.email, 'hire@allowed.example');

        const claimed = await claim('71717', 'hire@allowed.example');
        assert.equal(claimed.rows.length, 1, 'allowed-domain invite claims');

        // Tightening the allowlist unclaims a stale pending invite: the pending
        // row survives, but claim returns no rows until the domains are relaxed.
        await invite('pending@allowed.example');
        await setDomains(['other.example']);
        assert.equal(
            (await claim('72727', 'pending@allowed.example')).rows.length,
            0,
            'a pending invite outside the new allowlist cannot be claimed',
        );
        await setDomains(null);
        assert.equal(
            (await claim('72727', 'pending@allowed.example')).rows.length,
            1,
            'clearing the allowlist restores claimability',
        );

        await rejectCode(
            setDomains(['not a domain!']),
            '22023',
            'malformed domain entries are rejected',
        );
        await rejectCode(
            withStaffTransaction(
                pool, identity('90909'), ORG_A, ['candidates.read'],
                async ({ client }) => client.query(
                    'select app.set_staff_invite_domains_v1($1::text[], $2::uuid, $3::uuid)',
                    [['sneaky.example'], randomUUID(), randomUUID()],
                ),
            ),
            '42501',
            'setting domains requires staff.manage',
        );
    });
});

test('non-superuser migration operator applies staff authorization core', async (t) => {
    assertLocalTestEnvironment();
    const pgOperator = await startPostgresContainer('pgauthzop', POSTGRES_17_IMAGE);
    t.after(() => stopAndRemoveContainer(pgOperator));
    psql(pgOperator, `
        create role staff_operator nologin nosuperuser createrole bypassrls;
        grant create on database postgres to staff_operator with grant option;
    `);
    for (const fileName of MIGRATIONS) {
        psql(pgOperator, `set session authorization staff_operator;\n${readMigration(fileName)}`);
    }
    assert.equal(scalar(pgOperator, `
        select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app'
    `), '10');
    assert.equal(scalar(pgOperator, `
        select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relname = 'audit_events'
            and c.relrowsecurity and c.relforcerowsecurity
    `), '1');
    for (const [role, privilege, expectedValue] of [
        ['app_executor', 'create', 'f'],
        ['app_authz_reader', 'create', 'f'],
        ['app_staff', 'create', 'f'],
        ['app_staff', 'usage', 't'],
    ]) {
        assert.equal(
            scalar(pgOperator, `select has_schema_privilege('${role}', 'app', '${privilege}')`),
            expectedValue,
        );
    }
    assert.equal(
        scalar(pgOperator, `select pg_has_role('staff_operator', 'app_executor', 'member')`),
        't',
    );
    assert.equal(
        scalar(pgOperator, `select pg_has_role('staff_operator', 'app_authz_reader', 'member')`),
        't',
    );
    for (const role of ['app_staff', 'app_intake', 'app_worker']) {
        assertSqlstate(
            pgOperator,
            `set role ${role}; select count(*) from app.audit_events;`,
            '42501',
        );
    }
    assertSqlstate(
        pgOperator,
        `set role app_intake; select app.has_permission_v1('staff.manage');`,
        '42501',
    );
});
