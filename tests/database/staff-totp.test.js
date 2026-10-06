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
import { generateBackupCodes } from '../../src/lib/staff-backup-codes.js';
import { withStaffActor } from '../../src/lib/staff-authorization.js';
import { readStaffAccess } from '../../src/lib/staff-access.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const migrationsDir = join(repoRoot, 'supabase', 'migrations');
const TOTP_MIGRATION = '20260925100000_staff_totp.sql';
const RECOVERY_MIGRATION = '20261007090000_staff_mfa_admin_recovery.sql';
const STABLE_ENROLLMENT_MIGRATION = '20261006090000_staff_totp_stable_enrollment.sql';
const MIGRATIONS = [
    '20260922090000_foundation_roles.sql',
    '20260922090100_foundation_schema.sql',
    '20260922090200_foundation_seed.sql',
    AUTHZ_MIGRATION,
    GOOGLE_MIGRATION,
    TOTP_MIGRATION,
    '20261003090000_staff_mfa_backup_codes.sql',
    STABLE_ENROLLMENT_MIGRATION,
    RECOVERY_MIGRATION,
];
const readMigration = (name) => readFileSync(join(migrationsDir, name), 'utf8');
const identity = (subject) => ({ provider: 'google', issuer: GOOGLE_ISSUER, subject });
const { ORG_A, USER_ADMIN1, USER_ADMIN2 } = AUTHZ_ID;

const scalar = (container, sql) => psql(container, sql).trim();
const rejectCode = async (promise, code) => {
    await assert.rejects(promise, (error) => error.code === code, `expected ${code}`);
};
const SECRET = 'ABCDEFGHIJKLMNOP';

const setLocalContext = (client, actor, org) => client.query(
    `select
        pg_catalog.set_config('app.actor_id', $1, true),
        pg_catalog.set_config('app.organization_id', $2, true)`,
    [actor ?? '', org ?? ''],
);

const withContext = async (pool, actor, org, fn) => {
    const client = await pool.connect();
    try {
        await client.query('begin');
        await client.query('set local role app_staff');
        await setLocalContext(client, actor, org);
        return await fn(client);
    } finally {
        await client.query('rollback').catch(() => {});
        client.release();
    }
};

const totpStatus = (pool, subject) => withStaffActor(
    pool, identity(subject), ORG_A,
    async ({ client }) => (await client.query(
        'select credential_id, status, secret, last_used_counter from app.totp_status_v1()',
    )).rows[0] ?? null,
);

test('staff totp credentials on PostgreSQL 17', async (t) => {
    assertLocalTestEnvironment();
    const adminPassword = randomUUID();
    const container = await startPostgresContainer('pgtotp', POSTGRES_17_IMAGE, {
        publish: true,
        password: adminPassword,
    });
    let pool;
    t.after(async () => {
        await pool?.end().catch(() => {});
        await stopAndRemoveContainer(container);
    });

    for (const fileName of MIGRATIONS.filter((file) => file !== STABLE_ENROLLMENT_MIGRATION && file !== RECOVERY_MIGRATION)) {
        psql(container, readMigration(fileName));
    }
    const runtimePassword = installStaffFixture(container);
    pool = new pg.Pool(staffPoolOptions(container, runtimePassword, 4));

    await t.test('upgrade preserves existing credentials, backup codes, audit records and function permissions', async () => {
        const active = randomUUID();
        const pending = randomUUID();
        const legacyPending = randomUUID();
        const backup = generateBackupCodes(active);
        psql(container, `insert into app.totp_credentials (id,organization_id,user_id,secret,status,verified_at,last_used_counter)
            values ('${active}','${ORG_A}','${AUTHZ_ID.USER_CUSTOM}','${SECRET}','active',now(),123),
                   ('${pending}','${ORG_A}','${AUTHZ_ID.USER_VIEWER}','BCDEFGHIJKLMNOPQ','pending',null,-1),
                   ('${legacyPending}','${ORG_A}','${AUTHZ_ID.USER_CUSTOM}','CDEFGHIJKLMNOPQR','pending',null,-1);
            insert into app.staff_mfa_backup_codes (organization_id,user_id,credential_id,code_hash,used_at)
                values ('${ORG_A}','${AUTHZ_ID.USER_CUSTOM}','${active}','${backup.hashes[0]}',now());
            insert into app.audit_events (id,organization_id,actor_kind,actor_user_id,actor_membership_id,action,target_type,target_id,correlation_id,occurred_at,details)
                values ('${randomUUID()}','${ORG_A}','staff','${AUTHZ_ID.USER_CUSTOM}','${AUTHZ_ID.MEMBER_CUSTOM}','staff.totp.enrolled','totp_credential','${active}','${randomUUID()}',now(),jsonb_build_object('credential_id','${active}'));`);
        const snapshot = () => scalar(container, `select jsonb_build_object(
            'credentials', (select jsonb_agg(to_jsonb(c) order by c.id) from app.totp_credentials c),
            'codes', (select jsonb_agg(to_jsonb(c) order by c.credential_id,c.code_hash) from app.staff_mfa_backup_codes c),
            'audit', (select jsonb_agg(to_jsonb(a) order by a.id) from app.audit_events a),
            'functions', (select jsonb_agg(jsonb_build_object('oid',p.oid,'owner',p.proowner,'acl',p.proacl) order by p.oid) from pg_proc p
                where p.oid in ('app.totp_enroll_v1(text,uuid,uuid)'::regprocedure,'app.totp_status_v1()'::regprocedure)));`);
        const before = snapshot();
        psql(container, readMigration(STABLE_ENROLLMENT_MIGRATION));
        assert.equal(snapshot(), before);
        const access = await readStaffAccess(pool, identity(SUBJECTS.CUSTOM), ORG_A);
        assert.equal(access.totp.credentialId, active);
        assert.equal(access.totp.status, 'active');
        const existing = await withStaffActor(pool, identity(SUBJECTS.CUSTOM), ORG_A,
            async ({ client, auditId, correlationId }) => (await client.query(
                'select app.totp_enroll_v1($1,$2,$3) as id', [SECRET,auditId,correlationId])).rows[0].id);
        assert.equal(existing, active);
        assert.equal(snapshot(), before);
    });

    await t.test('recovery migration preserves all existing application rows', async () => {
        const tables = JSON.parse(scalar(container, `select json_agg(tablename order by tablename) from pg_tables where schemaname='app'`));
        const rows = () => scalar(container, tables.map((name) =>
            `select '${name}' as table_name, to_jsonb(t)::text as row_data from app."${name}" t`).join(' union all ') + ' order by table_name,row_data');
        const before = rows();
        psql(container, readMigration(RECOVERY_MIGRATION));
        assert.equal(rows(), before, 'recovery migration preserves every existing application row');
        assert.equal(scalar(container, `select proowner::regrole::text from pg_proc
            where oid='app.reset_staff_mfa_v1(uuid,bigint,text,uuid,bigint,uuid,uuid)'::regprocedure`), 'app_executor');
        assert.equal(scalar(container, `select count(*) from pg_proc p,
            lateral aclexplode(p.proacl) a
            where p.oid='app.reset_staff_mfa_v1(uuid,bigint,text,uuid,bigint,uuid,uuid)'::regprocedure
            and a.grantee=0`), '0', 'reset is not executable by public');
    });

    await t.test('combined access uses four exchanges and does not reuse access across requests', async () => {
        const queries = [];
        const countedPool = { async connect() {
            const client = await pool.connect();
            return {
                query: (...args) => { queries.push(args[0]); return client.query(...args); },
                release: (error) => client.release(error),
            };
        } };
        const access = await readStaffAccess(countedPool, identity(SUBJECTS.ADMIN2), ORG_A);
        assert.equal(access.principal.user_id, USER_ADMIN2);
        assert.equal(access.totp, null);
        assert.equal(queries.length, 4, 'setup, resolve/context, MFA, commit');
        assert.equal(await readStaffAccess(pool, identity(SUBJECTS.UNMAPPED), ORG_A), null);
        assert.equal(await readStaffAccess(pool, identity(SUBJECTS.ADMIN1), AUTHZ_ID.ORG_B), null);
        psql(container, `update app.organization_memberships set status='revoked', revoked_at=now(), version=version+1
            where id='${AUTHZ_ID.MEMBER_ADMIN2}';`);
        try {
            assert.equal(await readStaffAccess(pool, identity(SUBJECTS.ADMIN2), ORG_A), null);
        } finally {
            psql(container, `update app.organization_memberships set status='active', revoked_at=null, version=version+1
                where id='${AUTHZ_ID.MEMBER_ADMIN2}';`);
        }
        assert.equal((await readStaffAccess(pool, identity(SUBJECTS.ADMIN2), ORG_A)).principal.user_id, USER_ADMIN2);
    });

    await t.test('procedures fail closed without a trusted actor context', async () => {
        await rejectCode(withContext(pool, '', '', (client) => client.query(
            'select app.totp_status_v1()',
        )), '42501');
        await rejectCode(withContext(pool, '', '', (client) => client.query(
            'select app.totp_enroll_v1($1, $2, $3)',
            [SECRET, randomUUID(), randomUUID()],
        )), '42501');
        // Unknown identity cannot even reach the procedures: resolution fails first.
        await assert.rejects(
            withStaffActor(pool, identity(SUBJECTS.UNMAPPED), ORG_A, async () => {}),
            (error) => error.code === 'UNAUTHORIZED',
        );
    });

    await t.test('enrollment lifecycle with audit trail', async () => {
        const enrolled = await withStaffActor(
            pool, identity(SUBJECTS.ADMIN1), ORG_A,
            async ({ client, auditId, correlationId }) => {
                const result = await client.query(
                    'select app.totp_enroll_v1($1, $2, $3) as credential_id',
                    [SECRET, auditId, correlationId],
                );
                return { credentialId: result.rows[0].credential_id, auditId };
            },
        );

        let status = await totpStatus(pool, SUBJECTS.ADMIN1);
        assert.equal(status.credential_id, enrolled.credentialId);
        assert.equal(status.status, 'pending');
        assert.equal((await readStaffAccess(pool, identity(SUBJECTS.ADMIN1), ORG_A)).totp.status, 'pending');
        assert.equal(status.secret, SECRET);
        assert.equal(Number(status.last_used_counter), -1);
        assert.equal(scalar(
            container,
            `select count(*) from app.audit_events where action = 'staff.totp.enrolled'`
                + ` and target_id = '${enrolled.credentialId}'`,
        ), '1');

        // Refreshing or opening another setup tab reuses the pending credential.
        const second = await withStaffActor(
            pool, identity(SUBJECTS.ADMIN1), ORG_A,
            async ({ client, auditId, correlationId }) => (await client.query(
                'select app.totp_enroll_v1($1, $2, $3) as credential_id',
                ['BCDEFGHIJKLMNOPQ', auditId, correlationId],
            )).rows[0].credential_id,
        );
        assert.equal(second, enrolled.credentialId);
        assert.equal(scalar(
            container,
            `select status from app.totp_credentials where id = '${enrolled.credentialId}'`,
        ), 'pending');
        status = await totpStatus(pool, SUBJECTS.ADMIN1);
        assert.equal(status.credential_id, second);
        assert.equal(status.secret, SECRET);

        // Confirm activates and revokes nothing else (no prior active).
        await withStaffActor(
            pool, identity(SUBJECTS.ADMIN1), ORG_A,
            async ({ client, auditId, correlationId }) => client.query(
                'select app.totp_confirm_v1($1, $2, $3)',
                [second, auditId, correlationId],
            ),
        );
        status = await totpStatus(pool, SUBJECTS.ADMIN1);
        assert.equal(status.status, 'active');
        const access = await readStaffAccess(pool, identity(SUBJECTS.ADMIN1), ORG_A);
        assert.equal(access.totp.status, 'active');
        assert.equal(access.totp.credentialId, second);
        assert.equal(access.principal.user_id, USER_ADMIN1);
        assert.equal(scalar(
            container,
            `select count(*) from app.audit_events where action = 'staff.totp.activated'`
                + ` and target_id = '${second}'`,
        ), '1');

        // An enrollment request that arrives after confirmation reuses the
        // active credential and cannot create a competing pending setup.
        const third = await withStaffActor(pool, identity(SUBJECTS.ADMIN1), ORG_A,
            async ({ client, auditId, correlationId }) => (await client.query(
                'select app.totp_enroll_v1($1, $2, $3) as credential_id',
                [SECRET, auditId, correlationId],
            )).rows[0].credential_id);
        assert.equal(third, second);
        status = await totpStatus(pool, SUBJECTS.ADMIN1);
        assert.equal(status.status, 'active');
        assert.equal(status.credential_id, second);
        assert.equal(scalar(container, `select count(*) from app.totp_credentials
            where organization_id = '${ORG_A}' and user_id = '${USER_ADMIN1}'`), '1');
        assert.equal(scalar(container, `select count(*) from app.audit_events
            where action = 'staff.totp.enrolled' and target_id = '${second}'`), '1');
    });

    await t.test('replay protection is counter-monotonic', async () => {
        const credential = (await totpStatus(pool, SUBJECTS.ADMIN1)).credential_id;
        const record = (counter) => withStaffActor(
            pool, identity(SUBJECTS.ADMIN1), ORG_A,
            async ({ client, auditId, correlationId }) => client.query(
                'select app.totp_record_use_v1($1, $2, $3, $4)',
                [credential, counter, auditId, correlationId],
            ),
        );
        await record(5);
        await rejectCode(record(5), '23514');
        await rejectCode(record(4), '23514');
        await record(6);
        assert.equal(scalar(
            container,
            `select count(*) from app.audit_events where action = 'staff.totp.verified'`
                + ` and target_id = '${credential}'`,
        ), '2');
        const status = await totpStatus(pool, SUBJECTS.ADMIN1);
        assert.equal(Number(status.last_used_counter), 6);
    });

    await t.test('credentials are bound to the acting user', async () => {
        const credential = (await totpStatus(pool, SUBJECTS.ADMIN1)).credential_id;
        // Admin Two cannot see or mutate Admin One's credential.
        await rejectCode(withContext(pool, USER_ADMIN2, ORG_A, (client) => client.query(
            'select app.totp_confirm_v1($1, $2, $3)',
            [credential, randomUUID(), randomUUID()],
        )), 'P0002');
        await rejectCode(withContext(pool, USER_ADMIN2, ORG_A, (client) => client.query(
            'select app.totp_record_use_v1($1, $2, $3, $4)',
            [credential, 99, randomUUID(), randomUUID()],
        )), 'P0002');
        const status2 = await totpStatus(pool, SUBJECTS.ADMIN2);
        assert.equal(status2, null);
    });

    await t.test('input validation', async () => {
        const enroll = (secret) => withStaffActor(
            pool, identity(SUBJECTS.ADMIN2), ORG_A,
            async ({ client, auditId, correlationId }) => client.query(
                'select app.totp_enroll_v1($1, $2, $3)',
                [secret, auditId, correlationId],
            ),
        );
        await rejectCode(enroll('short'), '22023');
        await rejectCode(enroll('INVALID!CHARS0000'), '22023');
        await rejectCode(enroll('aBCDEFGHIJKLMNOP'), '22023');
        await rejectCode(withStaffActor(
            pool, identity(SUBJECTS.ADMIN2), ORG_A,
            async ({ client }) => client.query(
                'select app.totp_enroll_v1($1, null, null)', [SECRET],
            ),
        ), '22023');
    });

    await t.test('raw table access stays denied for runtime roles', async () => {
        const client = await pool.connect();
        try {
            await rejectCode(
                client.query('select count(*) from app.totp_credentials'),
                '42501',
            );
            await rejectCode(client.query('set role app_executor'), '42501');
            await client.query('begin');
            await client.query('set local role app_staff');
            await rejectCode(
                client.query('select count(*) from app.totp_credentials'),
                '42501',
            );
            await client.query('rollback');
        } finally {
            client.release();
        }
    });

    await t.test('catalog assertions', async () => {
        assert.equal(scalar(
            container,
            `select relowner::regrole::text from pg_catalog.pg_class c
                join pg_catalog.pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'app' and c.relname = 'totp_credentials'`,
        ), 'app_owner');
        assert.equal(scalar(
            container,
            `select relrowsecurity and relforcerowsecurity from pg_catalog.pg_class c
                join pg_catalog.pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'app' and c.relname = 'totp_credentials'`,
        ), 't');
        assert.equal(scalar(
            container,
            `select count(*) from pg_catalog.pg_policy p
                join pg_catalog.pg_class c on c.oid = p.polrelid
                join pg_catalog.pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'app' and c.relname = 'totp_credentials'
                  and p.polroles::regrole[]::text[] = array['app_executor']`,
        ), '5');
        assert.equal(scalar(
            container,
            `select string_agg(proowner::regrole::text, ',' order by proname)
                from pg_catalog.pg_proc p
                join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'app' and p.proname like 'totp_%_v1' and p.proname <> 'totp_actor_v1'`,
        ), 'app_executor,app_executor,app_executor,app_executor');
        assert.equal(scalar(
            container,
            `select proowner::regrole::text from pg_catalog.pg_proc p
                join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'app' and p.proname = 'totp_actor_v1'`,
        ), 'app_owner');
        // No grants to provider/runtime surfaces beyond app_staff/app_executor.
        assert.equal(scalar(
            container,
            `select count(*) from information_schema.role_table_grants
                where table_schema = 'app' and table_name = 'totp_credentials'
                  and grantee not in ('app_owner', 'app_executor')`,
        ), '0');
    });
    await t.test('backup codes are hashed, actor bound, single use, replaceable and audited', async () => {
        const credential = (await totpStatus(pool, SUBJECTS.ADMIN1)).credential_id;
        const backup = generateBackupCodes(credential);
        const set = (hashes) => withStaffActor(pool, identity(SUBJECTS.ADMIN1), ORG_A,
            ({ client, auditId, correlationId }) => client.query(
                'select app.set_mfa_backup_codes_v1($1,$2,$3,$4)',
                [credential, hashes, auditId, correlationId]));
        const consume = (hash, subject = SUBJECTS.ADMIN1) => withStaffActor(pool,
            identity(subject), ORG_A, async ({ client, auditId, correlationId }) =>
                (await client.query('select app.consume_mfa_backup_code_v1($1,$2,$3,$4) as accepted',
                    [credential, hash, auditId, correlationId])).rows[0].accepted);
        await rejectCode(set(['bad']), '22023');
        await rejectCode(set(Array(10).fill(backup.hashes[0])), '22023');
        await set(backup.hashes);
        assert.equal(scalar(container, `select count(*) from app.staff_mfa_backup_codes
            where credential_id = '${credential}'`), '10');
        assert.equal(scalar(container, `select code_hash from app.staff_mfa_backup_codes
            where credential_id = '${credential}' order by code_hash limit 1`), [...backup.hashes].sort()[0]);
        assert.equal(await consume(backup.hashes[0], SUBJECTS.ADMIN2), false);
        const concurrent = await Promise.all([consume(backup.hashes[0]), consume(backup.hashes[0])]);
        assert.deepEqual(concurrent.sort(), [false, true]);
        assert.equal(await consume(backup.hashes[0]), false);
        assert.equal(scalar(container, `select count(*) from app.audit_events where
            target_id = '${credential}' and action = 'staff.mfa.backup_code.used'`), '1');
        assert.equal(scalar(container, `select count(*) from app.audit_events where
            action like 'staff.mfa.%' and details::text like '%${backup.hashes[0]}%'`), '0');
        const replacement = generateBackupCodes(credential);
        await set(replacement.hashes);
        assert.equal(await consume(backup.hashes[1]), false);
        assert.equal(await consume(replacement.hashes[1]), true);
        scalar(container, `update app.totp_credentials set status = 'revoked', revoked_at = now()
            where id = '${credential}';`);
        assert.equal(await consume(replacement.hashes[2]), false);
        await rejectCode(set(replacement.hashes), '42501');
    });

    await t.test('MFA attempts share a persistent atomic budget across concurrent requests', async () => {
        const reserve = () => withStaffActor(pool, identity(SUBJECTS.ADMIN1), ORG_A,
            async ({ client }) => (await client.query('select app.reserve_mfa_attempt_v1() as retry')).rows[0].retry);
        const results = await Promise.all(Array.from({ length: 12 }, reserve));
        assert.equal(results.filter((n) => n === 0).length, 10);
        assert.equal(results.filter((n) => n > 0 && n <= 600).length, 2);
        assert.ok(await reserve() > 0);
        scalar(container, `update app.staff_mfa_attempts set window_started_at = now() - interval '11 minutes'
            where user_id = '${USER_ADMIN1}';`);
        assert.equal(await reserve(), 0);
        assert.equal(scalar(container, `select attempts from app.staff_mfa_attempts where user_id = '${USER_ADMIN1}'`), '1');
        await rejectCode(withContext(pool, '', '', (client) => client.query('select app.reserve_mfa_attempt_v1()')), '42501');
        await rejectCode(pool.query('select * from app.staff_mfa_backup_codes'), '42501');
        await rejectCode(pool.query('select * from app.staff_mfa_attempts'), '42501');
        assert.equal(scalar(container, `select count(*) from information_schema.role_table_grants
            where table_schema = 'app' and table_name in ('staff_mfa_backup_codes', 'staff_mfa_attempts')
            and grantee not in ('app_owner','app_executor')`), '0');
    });

    await t.test('simultaneous setup and confirmation keep one secret, audit and backup set', async () => {
        const subject = SUBJECTS.RECRUITER;
        const begin = (secret) => withStaffActor(pool, identity(subject), ORG_A,
            async ({ client, auditId, correlationId }) => {
                const id = (await client.query('select app.totp_enroll_v1($1,$2,$3) as id', [secret, auditId, correlationId])).rows[0].id;
                const row = (await client.query('select * from app.totp_status_v1()')).rows[0];
                assert.equal(row.credential_id, id);
                return row;
            });
        const requests = await Promise.all(Array.from({ length: 8 }, (_, i) => begin(i % 2 ? SECRET : 'BCDEFGHIJKLMNOPQ')));
        const first = requests[0];
        for (const row of requests) assert.deepEqual(row, first);
        assert.equal(first.status, 'pending');
        const codes = generateBackupCodes(first.credential_id);
        const confirm = () => withStaffActor(pool, identity(subject), ORG_A,
            async ({ client, auditId, correlationId }) => {
                await client.query('select app.totp_confirm_v1($1,$2,$3)', [first.credential_id, auditId, correlationId]);
                await client.query('select app.totp_record_use_v1($1,$2,$3,$4)', [first.credential_id, 100, randomUUID(), correlationId]);
                await client.query('select app.set_mfa_backup_codes_v1($1,$2,$3,$4)', [first.credential_id, codes.hashes, randomUUID(), correlationId]);
            });
        const outcomes = await Promise.allSettled([confirm(), confirm(), begin('CDEFGHIJKLMNOPQR')]);
        assert.equal(outcomes.slice(0,2).filter(({ status }) => status === 'fulfilled').length, 1);
        assert.equal(outcomes.slice(0,2).find(({ status }) => status === 'rejected').reason.code, '23514');
        const raced = outcomes[2]; assert.equal(raced.status, 'fulfilled');
        assert.equal(raced.value.credential_id, first.credential_id);
        assert.equal(raced.value.secret, first.secret);
        assert.equal((await totpStatus(pool, subject)).status, 'active');
        assert.equal((await begin('CDEFGHIJKLMNOPQR')).status, 'active');
        assert.equal(scalar(container, `select count(*) from app.totp_credentials where id = '${first.credential_id}'`), '1');
        assert.equal(scalar(container, `select count(*) from app.audit_events where action = 'staff.totp.enrolled' and target_id = '${first.credential_id}'`), '1');
        assert.equal(scalar(container, `select count(*) from app.audit_events where action = 'staff.totp.activated' and target_id = '${first.credential_id}'`), '1');
        assert.equal(scalar(container, `select count(*) from app.staff_mfa_backup_codes where credential_id = '${first.credential_id}'`), '10');
    });

    await t.test('admin recovery revokes credentials and backups without changing the Google identity', async () => {
        // Start fresh while keeping prior cases and their history intact.
        psql(container, `update app.totp_credentials set status='revoked', revoked_at=now()
            where organization_id='${ORG_A}' and user_id in ('${USER_ADMIN1}','${USER_ADMIN2}')
            and status in ('active','pending');`);
        const activate = (subject) => withStaffActor(pool, identity(subject), ORG_A,
            async ({ client, auditId, correlationId }) => {
                const id = (await client.query('select app.totp_enroll_v1($1,$2,$3) as id', [SECRET, auditId, correlationId])).rows[0].id;
                await client.query('select app.totp_confirm_v1($1,$2,$3)', [id, randomUUID(), correlationId]);
                return id;
            });
        const admin = await activate(SUBJECTS.ADMIN1);
        const target = await activate(SUBJECTS.ADMIN2);
        // Cover legacy data with an active and pending credential together.
        const pending = randomUUID();
        psql(container, `insert into app.totp_credentials(id,organization_id,user_id,secret,status)
            values ('${pending}','${ORG_A}','${USER_ADMIN2}','${SECRET}','pending');`);
        const codes = generateBackupCodes(target);
        await withStaffActor(pool, identity(SUBJECTS.ADMIN2), ORG_A,
            ({ client, auditId, correlationId }) => client.query('select app.set_mfa_backup_codes_v1($1,$2,$3,$4)', [target, codes.hashes, auditId, correlationId]));
        const version = Number(scalar(container, `select version from app.organization_memberships where id = '${AUTHZ_ID.MEMBER_ADMIN2}'`));
        const reset = (member = AUTHZ_ID.MEMBER_ADMIN2, expected = version, subject = SUBJECTS.ADMIN1, counter = 1000, actorCredential = admin, reason = 'lost_authenticator') =>
            withStaffActor(pool, identity(subject), ORG_A, ({ client, auditId, correlationId }) => client.query(
                'select app.reset_staff_mfa_v1($1,$2,$3,$4,$5,$6,$7)', [member, expected, reason, actorCredential, counter, auditId, correlationId]));
        await rejectCode(reset(AUTHZ_ID.MEMBER_ADMIN1), '42501');
        await rejectCode(reset(AUTHZ_ID.MEMBER_B_ADMIN), 'P0002');
        await rejectCode(reset(AUTHZ_ID.MEMBER_INVITED), '23514');
        await rejectCode(reset(undefined, version + 1), '40001');
        await rejectCode(reset(undefined, version, SUBJECTS.RECRUITER), '42501');
        await rejectCode(reset(undefined, version, undefined, undefined, target), 'P0002');
        await rejectCode(reset(undefined, version, undefined, undefined, undefined, 'bad'), '22023');
        assert.equal((await totpStatus(pool, SUBJECTS.ADMIN1)).last_used_counter, '-1');
        const concurrent = await Promise.allSettled([reset(), reset(undefined, version, undefined, 1001)]);
        assert.equal(concurrent.filter(({ status }) => status === 'fulfilled').length, 1);
        assert.equal(concurrent.find(({ status }) => status === 'rejected').reason.code, '40001');
        assert.equal(await totpStatus(pool, SUBJECTS.ADMIN2), null);
        assert.equal(scalar(container, `select status from app.totp_credentials where id = '${target}'`), 'revoked');
        assert.equal(scalar(container, `select status from app.totp_credentials where id = '${pending}'`), 'revoked');
        assert.equal(scalar(container, `select count(*) from app.audit_events where action = 'staff.mfa.reset' and target_id = '${AUTHZ_ID.MEMBER_ADMIN2}'`), '1');
        assert.equal(scalar(container, `select version from app.organization_memberships where id = '${AUTHZ_ID.MEMBER_ADMIN2}'`), String(version + 1));
        assert.equal(scalar(container, `select status from app.organization_memberships where id = '${AUTHZ_ID.MEMBER_ADMIN2}'`), 'active');
        assert.equal(scalar(container, `select provider_subject from app.auth_identities where id = '${AUTHZ_ID.IDENTITY_ADMIN2}'`), SUBJECTS.ADMIN2);
        const used = await withStaffActor(pool, identity(SUBJECTS.ADMIN2), ORG_A,
            async ({ client, auditId, correlationId }) => (await client.query('select app.consume_mfa_backup_code_v1($1,$2,$3,$4) as used', [target, codes.hashes[0], auditId, correlationId])).rows[0].used);
        assert.equal(used, false);
        const replacement = await activate(SUBJECTS.ADMIN2);
        assert.notEqual(replacement, target);
        assert.equal((await totpStatus(pool, SUBJECTS.ADMIN2)).status, 'active');
        // A reset with an already-used administrator counter is rejected, and
        // rolls back the target revocation and membership version change.
        const usedCounter = Number((await totpStatus(pool, SUBJECTS.ADMIN1)).last_used_counter);
        await rejectCode(reset(undefined, version + 1, undefined, usedCounter), '23514');
        assert.equal((await totpStatus(pool, SUBJECTS.ADMIN2)).credential_id, replacement);
    });

});
