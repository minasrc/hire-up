import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import pg from 'pg';
import { POSTGRES_17_IMAGE, assertLocalTestEnvironment, psql, startPostgresContainer, stopAndRemoveContainer } from '../support/foundation-docker.js';
import { AUTHZ_ID, installStaffFixture, staffPoolOptions } from '../support/staff-authorization.js';
const issuer = 'https://accounts.google.com';

test('only immutable platform roots provision isolated invitation-only workspaces with bounded idempotent receipts', { timeout: 120000 }, async t => {
    assertLocalTestEnvironment();
    const db = await startPostgresContainer('pgstaffworkspaceprovisioning', POSTGRES_17_IMAGE, { publish: true });
    let pool;
    t.after(async () => { await pool?.end(); stopAndRemoveContainer(db); });
    const dir = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
    for (const name of readdirSync(dir).filter(name => name.endsWith('.sql') && name >= '20260922090000' && name <= '20261013140000_staff_workspace_provisioning.sql').sort()) psql(db, readFileSync(join(dir, name), 'utf8'));
    const password = installStaffFixture(db);
    pool = new pg.Pool(staffPoolOptions(db, password, 3));
    const call = async (sql, args = [], org = AUTHZ_ID.ORG_A, actor = AUTHZ_ID.USER_ADMIN1) => {
        const c = await pool.connect();
        try {
            await c.query('begin; set local role app_staff');
            await c.query("select set_config('app.organization_id',$1,true),set_config('app.actor_id',$2,true)", [org, actor]);
            const r = await c.query(sql, args); await c.query('commit'); return r.rows;
        } catch (error) { await c.query('rollback'); throw error; }
        finally { c.release(); }
    };
    const create = async (operation, name = 'Synthetic Customer', email = 'admin@customer.example', org, actor) => (await call('select app.staff_workspace_create_v1($1,$2,$3) result', [operation, name, email], org, actor))[0].result;
    const status = async (org, actor) => (await call('select app.staff_workspace_provisioning_status_v1() result', [], org, actor))[0].result;
    assert.equal((await status()).canCreate, true);
    assert.equal((await status(AUTHZ_ID.ORG_B, AUTHZ_ID.USER_ADMIN2)).canCreate, false);
    psql(db, `insert into app.role_permissions(organization_id,role_id,permission_key) values('${AUTHZ_ID.ORG_A}','${AUTHZ_ID.ROLE_A_CUSTOM}','workspaces.create');`);
    await assert.rejects(create(randomUUID(), 'Custom-role bypass', 'admin@customer.example', AUTHZ_ID.ORG_A, AUTHZ_ID.USER_CUSTOM), error => error.code === '42501');
    const operation = randomUUID();
    const created = await create(operation);
    assert.equal(created.created, true); assert.equal(created.name, 'Synthetic Customer');
    assert.equal(created.invitationPath, `/staff/workspaces?workspace=${created.organizationId}`);
    assert.equal((await create(operation, ' Synthetic Customer ', 'ADMIN@CUSTOMER.EXAMPLE')).created, false);
    await assert.rejects(create(operation, 'Changed Customer'), error => error.code === '40001');
    await assert.rejects(create(operation, 'Synthetic Customer', 'admin@customer.example', AUTHZ_ID.ORG_A, AUTHZ_ID.USER_ADMIN2), error => error.code === '40001');
    await assert.rejects(create(randomUUID(), '', 'not-an-email'), error => error.code === '22023');
    const data = JSON.parse(psql(db, `select jsonb_build_object(
        'operatorMemberships',(select count(*) from app.organization_memberships where organization_id='${created.organizationId}' and user_id='${AUTHZ_ID.USER_ADMIN1}'),
        'invited',(select count(*) from app.organization_memberships where organization_id='${created.organizationId}' and status='invited'),
        'active',(select count(*) from app.organization_memberships where organization_id='${created.organizationId}' and status='active'),
        'roles',(select count(*) from app.roles where organization_id='${created.organizationId}'),
        'pipeline',(select count(*) from app.pipelines where organization_id='${created.organizationId}' and key='default'),
        'stages',(select count(*) from app.pipeline_stages where organization_id='${created.organizationId}'),
        'platformPermission',(select count(*) from app.role_permissions where organization_id='${created.organizationId}' and permission_key='workspaces.create'),
        'rootAllowlist',(select count(*) from app.platform_workspace_roots where organization_id='${created.organizationId}'),
        'audit',(select count(*) from app.audit_events where organization_id='${AUTHZ_ID.ORG_A}' and action='workspace.created' and target_id='${created.organizationId}'));`).trim());
    assert.deepEqual(data, { operatorMemberships: 0, invited: 1, active: 0, roles: 3, pipeline: 1, stages: 6, platformPermission: 0, rootAllowlist: 0, audit: 1 });
    const principal = await call('select * from app.resolve_staff_principal_v1($1,$2,$3,$4)', ['google', issuer, '1001', created.organizationId]);
    assert.deepEqual(principal, []);
    const customer = (await call('select * from app.claim_staff_invite_v1($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), 'google', issuer, '55555', 'admin@customer.example', randomUUID(), randomUUID()], created.organizationId))[0];
    assert.ok(customer.user_id); assert.notEqual(customer.user_id, AUTHZ_ID.USER_ADMIN1);
    assert.equal((await status(created.organizationId, customer.user_id)).canCreate, false);
    await assert.rejects(create(randomUUID(), 'Unauthorized Customer', 'admin@customer.example', created.organizationId, customer.user_id), error => error.code === '42501');
    // Even a hostile customer administrator granting the permission locally
    // cannot change the immutable root allowlist or gain platform authority.
    psql(db, `insert into app.role_permissions(organization_id,role_id,permission_key) values('${created.organizationId}','${customer.role_id}','workspaces.create');`);
    await assert.rejects(create(randomUUID(), 'Unauthorized Customer', 'admin@customer.example', created.organizationId, customer.user_id), error => error.code === '42501');
    assert.equal((await status(created.organizationId, customer.user_id)).canCreate, false);
    psql(db, `delete from app.role_permissions where organization_id='${AUTHZ_ID.ORG_A}' and role_id='${AUTHZ_ID.ROLE_A_ADMIN}' and permission_key='workspaces.create';`);
    await assert.rejects(create(operation), error => error.code === '42501');
    assert.equal((await status()).canCreate, false);
    psql(db, `insert into app.role_permissions(organization_id,role_id,permission_key) values('${AUTHZ_ID.ORG_A}','${AUTHZ_ID.ROLE_A_ADMIN}','workspaces.create');`);
    await assert.rejects(call('select * from app.platform_workspace_roots'), error => error.code === '42501');
    await assert.rejects(call('select app.staff_workspace_provision_v1($1,$2,$3)', [randomUUID(), 'Bypass', 'admin@customer.example']), error => error.code === '42501');
    await assert.rejects(call('set role app_workspace_provisioner'), error => error.code === '42501');
    assert.equal(psql(db, "select has_table_privilege('app_workspace_provisioner','app.candidates','select') or has_table_privilege('app_workspace_provisioner','app.clients','select') or has_table_privilege('app_workspace_provisioner','app.organizations','select');").trim(), 'f');
    assert.equal(psql(db, "select rolcanlogin or rolinherit or rolsuper or rolbypassrls from pg_roles where rolname='app_workspace_provisioner';").trim(), 'f');
    assert.equal(psql(db, "select count(*) from pg_auth_members where member=(select oid from pg_roles where rolname='app_workspace_provisioner');").trim(), '0');
    const listed = await status(); assert.equal(listed.created.length, 1); assert.equal(listed.created[0].organizationId, created.organizationId);
    const concurrentOperation = randomUUID();
    const concurrent = await Promise.all([create(concurrentOperation, 'Concurrent Customer'), create(concurrentOperation, 'Concurrent Customer')]);
    assert.deepEqual(concurrent.map(row => row.created).sort(), [false, true]);
    assert.equal(concurrent[0].organizationId, concurrent[1].organizationId);
    // Seed only synthetic metadata to exercise the cap without provisioning
    // ninety-seven additional real users/roles or contacting any external system.
    psql(db, `with synthetic as (select gen_random_uuid() id from generate_series(1,97)), orgs as(insert into app.organizations(id,key,name,status) select id,'synthetic-cap-'||id::text,'Synthetic capacity fixture','active' from synthetic returning id) insert into app.staff_workspace_creations(root_organization_id,operation_id,actor_user_id,request_digest,organization_id,name,admin_email) select '${AUTHZ_ID.ORG_A}',gen_random_uuid(),'${AUTHZ_ID.USER_ADMIN1}',sha256(convert_to('synthetic','UTF8')),id,'Synthetic capacity fixture','admin@customer.example' from orgs;`);
    const finalSlot = await Promise.allSettled([create(randomUUID(), 'Final slot one'), create(randomUUID(), 'Final slot two')]);
    assert.equal(finalSlot.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal(finalSlot.find(row => row.status === 'rejected').reason.code, '53300');
    await assert.rejects(create(randomUUID()), error => error.code === '53300');
    assert.equal((await create(operation)).created, false);
});
