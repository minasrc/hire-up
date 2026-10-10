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
    startPostgresContainer,
    stopAndRemoveContainer,
} from '../support/foundation-docker.js';
import {
    AUTHZ_ID,
    AUTHZ_MIGRATION,
    GOOGLE_ISSUER,
    GOOGLE_MIGRATION,
    SUBJECTS,
    installStaffFixture,
    staffPoolOptions,
} from '../support/staff-authorization.js';
import { readStaffAccess } from '../../src/lib/staff-access.js';
import { StaffOperationsError } from '../../src/lib/staff-operations.js';
import { saveStaffTimeZone } from '../../src/lib/staff-preferences.js';
import { withStaffActor } from '../../src/lib/staff-authorization.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const migrations = join(root, 'supabase', 'migrations');
const TIME_ZONE_MIGRATION = '20261011090000_staff_time_zone.sql';
const PREFIX = [
    '20260922090000_foundation_roles.sql',
    '20260922090100_foundation_schema.sql',
    '20260922090200_foundation_seed.sql',
    AUTHZ_MIGRATION,
    GOOGLE_MIGRATION,
    '20260925100000_staff_totp.sql',
];
const readMigration = name => readFileSync(join(migrations, name), 'utf8');
const identity = subject => ({ provider: 'google', issuer: GOOGLE_ISSUER, subject });
const rejectCode = (promise, code) => assert.rejects(promise, error => error.code === code);
const scalar = (container, sql) => psql(container, sql).trim();

async function countedAccess(pool, subject, organizationId) {
    const queries = [];
    const counted = { async connect() {
        const client = await pool.connect();
        return {
            query: (...args) => { queries.push(args[0]); return client.query(...args); },
            release: error => client.release(error),
        };
    } };
    const access = await readStaffAccess(counted, identity(subject), organizationId);
    return { access, queries };
}

test('staff time zone preference foundation on PostgreSQL 17', async t => {
    assertLocalTestEnvironment();
    const password = randomUUID();
    const db = await startPostgresContainer('pgtimezone', POSTGRES_17_IMAGE, {
        publish: true, password,
    });
    let pool;
    t.after(async () => {
        await pool?.end().catch(() => {});
        await stopAndRemoveContainer(db);
    });
    for (const migration of PREFIX) psql(db, readMigration(migration));
    const runtimePassword = installStaffFixture(db);
    pool = new pg.Pool(staffPoolOptions(db, runtimePassword, 1));

    const before = scalar(db, `select jsonb_agg(to_jsonb(u) - array['time_zone','time_zone_version'] order by id) from app.users u`);
    const oldAccess = await countedAccess(pool, SUBJECTS.ADMIN1, AUTHZ_ID.ORG_A);
    assert.equal(oldAccess.queries.length, 4);
    assert.equal(oldAccess.access.principal.time_zone, null);
    assert.equal(oldAccess.access.principal.time_zone_version, '0');
    assert.equal(oldAccess.access.totp, null);

    psql(db, readMigration(TIME_ZONE_MIGRATION));
    assert.equal(scalar(db, `select jsonb_agg(to_jsonb(u) - array['time_zone','time_zone_version'] order by id) from app.users u`), before);

    const initial = await countedAccess(pool, SUBJECTS.ADMIN1, AUTHZ_ID.ORG_A);
    assert.equal(initial.queries.length, 4, 'setup, resolve/context, MFA/preferences, commit');
    assert.equal(initial.access.principal.time_zone, null);
    assert.equal(initial.access.principal.time_zone_version, '0');
    assert.equal(initial.access.totp, null);

    const admin1 = input => saveStaffTimeZone(
        pool, identity(SUBJECTS.ADMIN1), AUTHZ_ID.ORG_A, input);
    assert.deepEqual(await admin1({ timeZone: 'Europe/Madrid', expectedVersion: '0' }),
        { timeZone: 'Europe/Madrid', version: '1' });
    let access = await readStaffAccess(pool, identity(SUBJECTS.ADMIN1), AUTHZ_ID.ORG_A);
    assert.equal(access.principal.time_zone, 'Europe/Madrid');
    assert.equal(access.principal.time_zone_version, '1');
    const other = await readStaffAccess(pool, identity(SUBJECTS.ADMIN2), AUTHZ_ID.ORG_A);
    assert.equal(other.principal.time_zone, null);
    assert.equal(other.principal.time_zone_version, '0');
    access = await readStaffAccess(pool, identity(SUBJECTS.ADMIN1), AUTHZ_ID.ORG_A);
    assert.equal(access.principal.time_zone, 'Europe/Madrid');
    assert.equal(access.principal.time_zone_version, '1');

    assert.deepEqual(await admin1({ timeZone: 'Europe/Madrid', expectedVersion: '0' }),
        { timeZone: 'Europe/Madrid', version: '1' });
    assert.deepEqual(await admin1({ timeZone: 'America/New_York', expectedVersion: '1' }),
        { timeZone: 'America/New_York', version: '2' });
    await rejectCode(admin1({ timeZone: 'Asia/Tokyo', expectedVersion: '1' }), '40001');
    access = await readStaffAccess(pool, identity(SUBJECTS.ADMIN1), AUTHZ_ID.ORG_A);
    assert.equal(access.principal.time_zone, 'America/New_York');
    assert.equal(access.principal.time_zone_version, '2');

    const auditCount = () => Number(scalar(db, `select count(*) from app.audit_events where action='staff.time_zone.changed' and actor_user_id='${AUTHZ_ID.USER_ADMIN1}'`));
    assert.equal(auditCount(), 2);
    const details = JSON.parse(scalar(db, `select jsonb_agg(details order by occurred_at) from app.audit_events where action='staff.time_zone.changed' and actor_user_id='${AUTHZ_ID.USER_ADMIN1}'`));
    assert.deepEqual(details.map(value => Object.keys(value).sort()), [
        ['new_version', 'previous_version'], ['new_version', 'previous_version'],
    ]);
    assert.ok(!JSON.stringify(details).includes('Madrid'));
    assert.ok(!JSON.stringify(details).includes('New_York'));

    await assert.rejects(
        saveStaffTimeZone({ connect: () => assert.fail('must not connect') }, identity(SUBJECTS.ADMIN1), AUTHZ_ID.ORG_A,
            { timeZone: 'UTC', expectedVersion: '2', userId: AUTHZ_ID.USER_ADMIN2 }),
        error => error instanceof StaffOperationsError,
    );
    for (const subject of [SUBJECTS.UNMAPPED, SUBJECTS.REVOKED, SUBJECTS.DISABLED]) {
        assert.equal(await readStaffAccess(pool, identity(subject), AUTHZ_ID.ORG_A), null);
        await rejectCode(saveStaffTimeZone(pool, identity(subject), AUTHZ_ID.ORG_A,
            { timeZone: 'UTC', expectedVersion: '0' }), 'UNAUTHORIZED');
    }
    await rejectCode(saveStaffTimeZone(pool, identity(SUBJECTS.ADMIN1), AUTHZ_ID.ORG_B,
        { timeZone: 'UTC', expectedVersion: '2' }), 'UNAUTHORIZED');

    assertSqlstate(db, `set role app_staff; update app.users set time_zone='UTC' where id='${AUTHZ_ID.USER_ADMIN2}';`, '42501');
    for (const role of ['app_intake', 'app_worker']) {
        assertSqlstate(db, `set role ${role};select app.set_staff_time_zone_v1('UTC',0,'${randomUUID()}','${randomUUID()}');`, '42501');
    }
    assertSqlstate(db, `set role app_staff;select app.set_staff_time_zone_v1('UTC',0,'${randomUUID()}','${randomUUID()}');`, '42501');
    assertSqlstate(db, `insert into app.audit_events (id, organization_id, actor_kind, actor_user_id, actor_membership_id, action, target_type, target_id, correlation_id, occurred_at, details) values ('${randomUUID()}', '${AUTHZ_ID.ORG_A}', 'staff', '${AUTHZ_ID.USER_ADMIN1}', '${AUTHZ_ID.MEMBER_ADMIN1}', 'staff.time_zone.changed', 'user', null, '${randomUUID()}', now(), '{"previous_version":0,"new_version":1}'::jsonb);`, '23514');

    await rejectCode(withStaffActor(pool, identity(SUBJECTS.ADMIN1), AUTHZ_ID.ORG_A,
        async ({ client, auditId, correlationId }) => client.query(
            'select app.set_staff_time_zone_v1($1::text,$2::bigint,$3::uuid,$4::uuid) as result',
            ['Invalid/Zone', '2', auditId, correlationId])), '22023');
    access = await readStaffAccess(pool, identity(SUBJECTS.ADMIN1), AUTHZ_ID.ORG_A);
    assert.equal(access.principal.time_zone, 'America/New_York');
    assert.equal(access.principal.time_zone_version, '2');
    assert.equal(auditCount(), 2);

    psql(db, `update app.organization_memberships set status='revoked',revoked_at=now() where id='${AUTHZ_ID.MEMBER_ADMIN1}'`);
    try {
        assert.equal(await readStaffAccess(pool, identity(SUBJECTS.ADMIN1), AUTHZ_ID.ORG_A), null);
        await rejectCode(admin1({ timeZone: 'UTC', expectedVersion: '2' }), 'UNAUTHORIZED');
    } finally {
        psql(db, `update app.organization_memberships set status='active',revoked_at=null where id='${AUTHZ_ID.MEMBER_ADMIN1}'`);
    }

    const catalog = await pool.query(`select proowner::regrole::text as owner, prosecdef from pg_proc where oid='app.set_staff_time_zone_v1(text,bigint,uuid,uuid)'::regprocedure`);
    assert.deepEqual(catalog.rows[0], { owner: 'app_executor', prosecdef: true });
    assert.equal((await pool.query(`select pg_catalog.has_table_privilege('app_staff','app.users','update') as value`)).rows[0].value, false);
    assert.equal((await pool.query(`select pg_catalog.has_column_privilege('app_executor','app.users','status','update') as value`)).rows[0].value, false);
    assert.deepEqual((await pool.query(`select relrowsecurity,relforcerowsecurity from pg_class where oid='app.users'::regclass`)).rows[0],
        { relrowsecurity: true, relforcerowsecurity: true });
});

test('non-superuser preference operator applies the migration', async t => {
    assertLocalTestEnvironment();
    const db = await startPostgresContainer('pgtimezoneop', POSTGRES_17_IMAGE);
    t.after(() => stopAndRemoveContainer(db));
    psql(db, `create role preference_operator nologin nosuperuser createrole bypassrls; grant create on database postgres to preference_operator with grant option;`);
    for (const migration of PREFIX) {
        psql(db, `set session authorization preference_operator;\n${readMigration(migration)}`);
    }
    installStaffFixture(db);
    psql(db, `set session authorization preference_operator;\n${readMigration(TIME_ZONE_MIGRATION)}`);
    assert.equal(scalar(db, `select proowner::regrole::text from pg_proc where oid='app.set_staff_time_zone_v1(text,bigint,uuid,uuid)'::regprocedure`), 'app_executor');
});
