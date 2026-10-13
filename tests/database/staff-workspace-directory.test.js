import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import pg from 'pg';
import { createStaffMfaProof, readStaffMfaProof } from '../../src/lib/staff-mfa-cookie.js';
import { POSTGRES_17_IMAGE, assertLocalTestEnvironment, psql, startPostgresContainer, stopAndRemoveContainer } from '../support/foundation-docker.js';
import { AUTHZ_ID, installStaffFixture, staffPoolOptions } from '../support/staff-authorization.js';
const issuer = 'https://accounts.google.com';

test('private workspace directory and invite claim reuse global identities across tenant boundaries', { timeout: 120000 }, async t => {
    assertLocalTestEnvironment();
    const db = await startPostgresContainer('pgstaffworkspacedirectory', POSTGRES_17_IMAGE, { publish: true });
    let pool;
    t.after(async () => { await pool?.end(); stopAndRemoveContainer(db); });
    const dir = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
    for (const name of readdirSync(dir).filter(name => name.endsWith('.sql') && name >= '20260922090000' && name <= '20261013130000_staff_workspace_directory.sql').sort()) {
        psql(db, readFileSync(join(dir, name), 'utf8'));
    }
    const password = installStaffFixture(db);
    pool = new pg.Pool(staffPoolOptions(db, password, 3));
    const call = async (sql, args = [], org = null, actor = null) => {
        const client = await pool.connect();
        try {
            await client.query('begin; set local role app_staff');
            if (org) await client.query("select set_config('app.organization_id',$1,true)", [org]);
            if (actor) await client.query("select set_config('app.actor_id',$1,true)", [actor]);
            const result = await client.query(sql, args);
            await client.query('commit');
            return result.rows;
        } catch (error) { await client.query('rollback'); throw error; }
        finally { client.release(); }
    };
    const directory = async (subject, email = '') => (await call('select app.staff_workspace_directory_v1($1,$2,$3,$4) result', ['google', issuer, subject, email]))[0].result;
    const claim = async (subject, email, org = AUTHZ_ID.ORG_B) => call('select * from app.claim_staff_invite_v1($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), 'google', issuer, subject, email, randomUUID(), randomUUID()], org);
    const invite = (email, user = randomUUID(), member = randomUUID(), org = AUTHZ_ID.ORG_B, role = AUTHZ_ID.ROLE_B_ADMIN) => {
        psql(db, `insert into app.users(id,display_name,status) values('${user}','Synthetic invited user','active'); insert into app.organization_memberships(id,organization_id,user_id,role_id,status,invited_email) values('${member}','${org}','${user}','${role}','invited','${email}');`);
        return { user, member };
    };
    psql(db, `update app.organizations set staff_invite_domains=array['allowed.example'] where id='${AUTHZ_ID.ORG_B}';`);
    const active = await directory('1002');
    assert.deepEqual(active.map(row => row.organizationId).sort(), [AUTHZ_ID.ORG_A, AUTHZ_ID.ORG_B].sort());
    assert.equal(active.every(row => Object.keys(row).sort().join() === 'name,organizationId,roleName,state'), true);
    assert.deepEqual(await directory('55555'), []);
    assert.deepEqual(await directory('1004'), []);
    assert.deepEqual(await directory('1008', 'revoked@allowed.example'), []);
    assert.deepEqual(await directory('1009', 'disabled@allowed.example'), []);
    await assert.rejects(call('select app.staff_workspace_directory_v1($1,$2,$3,$4)', ['github', issuer, '1001', 'person@allowed.example']), error => error.code === '42501');
    await assert.rejects(directory('1001', 'invalid'), error => error.code === '22023');
    const pending = invite('member@allowed.example');
    const before = await directory('1001', 'MEMBER@ALLOWED.EXAMPLE');
    assert.equal(before.find(row => row.organizationId === AUTHZ_ID.ORG_B).state, 'invited');
    assert.equal((await directory('55555', 'other@allowed.example')).length, 0);
    const bound = await claim('1001', 'member@allowed.example');
    assert.equal(bound[0].user_id, AUTHZ_ID.USER_ADMIN1);
    assert.equal(bound[0].membership_id, pending.member);
    assert.equal(psql(db, "select count(*) from app.auth_identities where provider='google' and provider_subject='1001';").trim(), '1');
    assert.equal(psql(db, `select user_id from app.organization_memberships where id='${pending.member}';`).trim(), AUTHZ_ID.USER_ADMIN1);
    assert.equal((await directory('1001')).find(row => row.organizationId === AUTHZ_ID.ORG_B).state, 'active');
    assert.deepEqual(await claim('1001', 'member@allowed.example'), []);
    const newInvite = invite('new@allowed.example');
    assert.equal((await directory('55555', 'new@allowed.example'))[0].state, 'invited');
    assert.equal((await claim('55555', 'new@allowed.example'))[0].user_id, newInvite.user);
    invite('revoked@allowed.example'); invite('disabled@allowed.example');
    await assert.rejects(claim('1008', 'revoked@allowed.example'), error => error.code === '42501');
    await assert.rejects(claim('1009', 'disabled@allowed.example'), error => error.code === '42501');
    invite('duplicate@allowed.example');
    await assert.rejects(claim('1002', 'duplicate@allowed.example'), error => error.code === '42501');
    invite('blocked@blocked.example');
    assert.equal((await directory('77777', 'blocked@blocked.example')).length, 0);
    assert.deepEqual(await claim('77777', 'blocked@blocked.example'), []);
    const wrongIdentity = invite('bound@allowed.example');
    psql(db, `insert into app.auth_identities(id,user_id,provider,issuer,provider_subject,verified_at) values('${randomUUID()}','${wrongIdentity.user}','google','${issuer}','88888',now());`);
    await assert.rejects(claim('99999', 'bound@allowed.example'), error => error.code === '42501');
    await assert.rejects(call('select * from app.organizations'), error => error.code === '42501');
    await assert.rejects(call('select * from app.auth_identities'), error => error.code === '42501');
    await assert.rejects(call('select app.staff_workspace_identity_v1($1,$2,$3)', ['google', issuer, '1001']), error => error.code === '42501');
    await assert.rejects(call('select app.staff_workspace_name_v1()'), error => error.code === '42501');
    assert.equal((await call('select app.staff_workspace_name_v1() name', [], AUTHZ_ID.ORG_B, AUTHZ_ID.USER_ADMIN1))[0].name, 'Acme');
    // One global identity has independent organization-specific credentials.
    const credentialA = (await call('select app.totp_enroll_v1($1,$2,$3) id', ['A'.repeat(32), randomUUID(), randomUUID()], AUTHZ_ID.ORG_A, AUTHZ_ID.USER_ADMIN1))[0].id;
    const credentialB = (await call('select app.totp_enroll_v1($1,$2,$3) id', ['B'.repeat(32), randomUUID(), randomUUID()], AUTHZ_ID.ORG_B, AUTHZ_ID.USER_ADMIN1))[0].id;
    assert.notEqual(credentialA, credentialB);
    await call('select app.totp_confirm_v1($1,$2,$3)', [credentialA, randomUUID(), randomUUID()], AUTHZ_ID.ORG_A, AUTHZ_ID.USER_ADMIN1);
    await call('select app.totp_confirm_v1($1,$2,$3)', [credentialB, randomUUID(), randomUUID()], AUTHZ_ID.ORG_B, AUTHZ_ID.USER_ADMIN1);
    await assert.rejects(call('select app.totp_record_use_v1($1,1,$2,$3)', [credentialB, randomUUID(), randomUUID()], AUTHZ_ID.ORG_A, AUTHZ_ID.USER_ADMIN1), error => error.code === 'P0002');
    await call('select app.totp_record_use_v1($1,1,$2,$3)', [credentialA, randomUUID(), randomUUID()], AUTHZ_ID.ORG_A, AUTHZ_ID.USER_ADMIN1);
    await call('select app.totp_record_use_v1($1,1,$2,$3)', [credentialB, randomUUID(), randomUUID()], AUTHZ_ID.ORG_B, AUTHZ_ID.USER_ADMIN1);
    const proofSecret = 'synthetic-workspace-proof-secret';
    const proof = createStaffMfaProof(proofSecret, { subject: '1001', userId: AUTHZ_ID.USER_ADMIN1, credentialId: credentialA });
    assert.ok(readStaffMfaProof(proofSecret, proof, { subject: '1001', userId: AUTHZ_ID.USER_ADMIN1, credentialId: credentialA }));
    assert.equal(readStaffMfaProof(proofSecret, proof, { subject: '1001', userId: AUTHZ_ID.USER_ADMIN1, credentialId: credentialB }), null);
    const failedInvite = invite('failed@allowed.example');
    const existingAudit = psql(db, "select id from app.audit_events where action='staff.invite.claimed' limit 1;").trim();
    const checked = await pool.connect();
    try {
        await checked.query('begin;set local role app_staff');
        await checked.query("select set_config('app.organization_id',$1,true),set_config('app.actor_id',$2,true)", [AUTHZ_ID.ORG_A, AUTHZ_ID.USER_ADMIN1]);
        await checked.query('savepoint failed_directory');
        await assert.rejects(checked.query('select app.staff_workspace_directory_v1($1,$2,$3,$4)', ['google', issuer, '1001', 'invalid']), error => error.code === '22023');
        await checked.query('rollback to savepoint failed_directory');
        await checked.query("select set_config('app.organization_id',$1,true)", [AUTHZ_ID.ORG_B]);
        await checked.query('savepoint failed_claim');
        await assert.rejects(checked.query('select * from app.claim_staff_invite_v1($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), 'google', issuer, '777770', 'failed@allowed.example', existingAudit, randomUUID()]), error => error.code === '23505');
        await checked.query('rollback to savepoint failed_claim');
        assert.equal((await checked.query("select current_setting('app.actor_id',true) actor")).rows[0].actor, AUTHZ_ID.USER_ADMIN1);
        await checked.query("select set_config('app.organization_id',$1,true)", [AUTHZ_ID.ORG_A]);

        await checked.query('select app.staff_workspace_directory_v1($1,$2,$3,$4)', ['google', issuer, '1001', '']);
        const scope = (await checked.query("select current_setting('app.actor_id',true) actor,current_setting('app.organization_id',true) org,current_setting('app.workspace_user',true) directory_user,current_setting('app.workspace_subject',true) directory_subject")).rows[0];
        assert.equal(scope.actor, AUTHZ_ID.USER_ADMIN1); assert.equal(scope.org, AUTHZ_ID.ORG_A);
        assert.equal(scope.directory_user ?? '', ''); assert.equal(scope.directory_subject ?? '', '');
        await checked.query('rollback');
    } finally { checked.release(); }
    psql(db, `update app.organization_memberships set status='revoked',revoked_at=now() where id='${pending.member}';`);
    await assert.rejects(call('select app.staff_workspace_name_v1()', [], AUTHZ_ID.ORG_B, AUTHZ_ID.USER_ADMIN1), error => error.code === '42501');
    assert.equal(psql(db, "select count(*) from app.auth_identities where provider_subject='777770';").trim(), '0');
    assert.equal(psql(db, `select status from app.organization_memberships where id='${failedInvite.member}';`).trim(), 'invited');
    const rls = JSON.parse(psql(db, `select jsonb_agg(jsonb_build_object('table',relname,'rls',relrowsecurity,'forced',relforcerowsecurity)) from pg_class where oid in('app.organizations'::regclass,'app.users'::regclass,'app.auth_identities'::regclass,'app.organization_memberships'::regclass,'app.roles'::regclass);`).trim());
    assert.equal(rls.every(row => row.rls && row.forced), true);
    assert.equal(psql(db, "select rolcanlogin or rolinherit or rolsuper or rolbypassrls from pg_roles where rolname='app_workspace_directory_reader';").trim(), 'f');
    assert.equal(psql(db, "select count(*) from pg_auth_members where member=(select oid from pg_roles where rolname='app_workspace_directory_reader');").trim(), '0');
});
