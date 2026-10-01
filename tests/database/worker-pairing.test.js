import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID, createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { POSTGRES_17_IMAGE, assertLocalTestEnvironment, startPostgresContainer, stopAndRemoveContainer, psql } from '../support/foundation-docker.js';
import { AUTHZ_ID, SUBJECTS, installStaffFixture, staffPoolOptions } from '../support/staff-authorization.js';
import { workerDeviceAction, workerDeviceStatus, workerPairingOperation, workerPairingStatus } from '../../src/lib/worker-pairing-operations.js';
import { workerPairingFingerprint } from '../../src/lib/worker-pairing-contracts.js';
import { telegramConnectorOperation, telegramConnectionStatus } from '../../src/lib/telegram-connection-operations.js';
import { revokeTelegramWorker } from '../../src/lib/telegram-intake-operations.js';
const sha = v => createHash('sha256').update(v).digest('hex');
const dir = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
const files = readdirSync(dir).filter(f => f >= '20260922090000_foundation_roles.sql' && f <= '20261002220000_worker_pairing.sql' && f.endsWith('.sql')).sort();
test('outbound device pairing commits proof budgets, binds owners and preserves scoped credentials', async t => {
    assertLocalTestEnvironment(); const db = await startPostgresContainer('pgworkerpair', POSTGRES_17_IMAGE, { publish: true }); let pool, publicPool;
    t.after(async () => { await Promise.all([pool?.end(), publicPool?.end()]); await stopAndRemoveContainer(db); });
    for (const f of files) {
        if (f === '20261002220000_worker_pairing.sql') {
            psql(db, 'create role pairing_operator login inherit nosuperuser createrole bypassrls;grant app_owner,app_executor to pairing_operator;');
            psql(db, `set session authorization pairing_operator;${readFileSync(join(dir, f), 'utf8')}reset session authorization;`);
        } else psql(db, readFileSync(join(dir, f), 'utf8'));
    }
    const password = installStaffFixture(db);pool = new pg.Pool(staffPoolOptions(db, password, 4));
    const workerPassword = randomUUID();psql(db, `create role pairing_test login noinherit password '${workerPassword}';grant app_telegram_worker to pairing_test;`);
    publicPool = new pg.Pool({ ...staffPoolOptions(db, workerPassword, 3), user: 'pairing_test' });
    const org = AUTHZ_ID.ORG_A, identity = { provider: 'google', issuer: 'https://accounts.google.com', subject: SUBJECTS.ADMIN1 }, other = { ...identity, subject: SUBJECTS.ADMIN2 };
    const action = body => workerDeviceAction(pool, identity, org, body);
    const make = async () => { const invitation = randomBytes(32).toString('base64url'), token = randomBytes(48).toString('base64url'), verifier = randomBytes(32).toString('base64url'); const request = { action: 'invite', operationId: randomUUID(), invitationSha256: sha(invitation), name: 'Paired Mac' }; const created = await action(request); const claim = { pairingId: created.pairingId, claimId: randomUUID(), deviceName: 'Local Mac', tokenSha256: sha(token), verifierSha256: sha(verifier) }; return { invitation, token, verifier, request, created, claim }; };
    const approve = async x => { const claimed = await workerPairingOperation(publicPool, 'claim', x.invitation, x.claim); const approval = { action: 'approve', operationId: randomUUID(), pairingId: x.created.pairingId, deviceFingerprint: claimed.deviceFingerprint }; return { claimed, approval, result: await action(approval) }; };
    const clearPoll = id => psql(db, `update app.worker_pairings set poll_after=null where id='${id}'`);
    let paired, approved;
    await t.test('nested SET ROLE works without inherited table/staff privileges or public helpers', async () => {
        const client = await publicPool.connect();try { await client.query('begin;set local role app_worker_pairing');assert.equal((await client.query('select current_user')).rows[0].current_user, 'app_worker_pairing');await assert.rejects(client.query('select * from app.worker_pairings'), { code: '42501' });await client.query('rollback'); } finally { client.release(); }
        assert.equal(psql(db, `select count(*) from pg_proc p where pronamespace='app'::regnamespace and (proname like 'worker_pairing_%' or proname like 'worker_device_%') and exists(select 1 from aclexplode(coalesce(proacl,acldefault('f',proowner))) a where a.grantee=0 and privilege_type='EXECUTE')`).trim(), '0');
        for (const role of ['app_worker_pairing', 'app_telegram_worker', 'app_telegram_maintenance']) assert.equal(psql(db, `select has_function_privilege('${role}','app.worker_device_action_v1(jsonb)','EXECUTE')`).trim(), 'f');
    });
    await t.test('local token hashes enroll once; approval/poll replay and existing RSA heartbeat work', async () => {
        paired = await make();assert.equal(workerPairingStatus(paired.created), 201);assert.equal(workerPairingStatus(await action(paired.request)), 200);
        await assert.rejects(action({ ...paired.request, name: 'Changed' }), { code: 'OPERATION_CONFLICT' });
        approved = await approve(paired);assert.equal(approved.claimed.deviceFingerprint, workerPairingFingerprint(paired.claim.pairingId, paired.claim.claimId, paired.claim.tokenSha256, paired.claim.verifierSha256));
        assert.deepEqual(await action(approved.approval), approved.result);
        await assert.rejects(action({ ...approved.approval, operationId: randomUUID() }), { code: 'PAIRING_DECIDED' });
        const poll = await workerPairingOperation(publicPool, 'poll', paired.verifier, { pairingId: paired.created.pairingId });assert.equal(poll.worker.id, approved.result.worker.id);assert.equal(poll.organization.id, org);assert(!JSON.stringify(poll).includes(paired.token));
        clearPoll(paired.created.pairingId);assert.deepEqual(await workerPairingOperation(publicPool, 'poll', paired.verifier, { pairingId: paired.created.pairingId }), poll);
        const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
        await telegramConnectorOperation(publicPool, paired.token, 'heartbeat', { publicKeySpki: key });
        assert.equal((await telegramConnectionStatus(pool, identity, org)).workers[0].id, poll.worker.id);
        assert.equal(psql(db, `select encode(token_sha256,'hex') from app.telegram_workers where id='${poll.worker.id}'`).trim(), sha(paired.token));
    });
    await t.test('other owner, wrong invitation and mismatched claim cannot redirect enrollment', async () => {
        const x = await make();await assert.rejects(workerDeviceStatus(pool, other, org, { pairingId: x.created.pairingId }), { code: 'PAIRING_UNAVAILABLE' });
        await assert.rejects(workerPairingOperation(publicPool, 'claim', randomBytes(32).toString('base64url'), x.claim), { code: 'PAIRING_UNAVAILABLE' });
        const c = await workerPairingOperation(publicPool, 'claim', x.invitation, x.claim);
        await assert.rejects(workerPairingOperation(publicPool, 'claim', x.invitation, { ...x.claim, claimId: randomUUID() }), { code: 'PAIRING_CLAIMED' });
        await assert.rejects(workerDeviceAction(pool, other, org, { action: 'approve', operationId: randomUUID(), pairingId: x.created.pairingId, deviceFingerprint: c.deviceFingerprint }), { code: 'PAIRING_UNAVAILABLE' });
        await action({ action: 'cancel', operationId: randomUUID(), pairingId: x.created.pairingId });
        assert.equal((await workerPairingOperation(publicPool, 'poll', x.verifier, { pairingId: x.created.pairingId })).status, 'cancelled');
    });
    await t.test('current permissions fence claimed and approved polls without stale metadata', async () => {
        const x = await make(); const a = await approve(x);
        const permission = 'candidates.write';
        psql(db, `delete from app.role_permissions where organization_id='${org}' and role_id='${AUTHZ_ID.ROLE_A_ADMIN}' and permission_key='${permission}'`);
        try {
            const poll = await workerPairingOperation(publicPool, 'poll', x.verifier, { pairingId: x.created.pairingId });
            assert.deepEqual(poll, { status: 'access_denied' });
            await assert.rejects(action(a.approval), { code: 'FORBIDDEN' });
        } finally { psql(db, `insert into app.role_permissions values('${org}','${AUTHZ_ID.ROLE_A_ADMIN}','${permission}')`); }
        assert.equal((await workerPairingOperation(publicPool, 'poll', x.verifier, { pairingId: x.created.pairingId })).status, 'approved');
    });
    await t.test('conflicting concurrent claims and fresh approval replay IDs allocate no extra records', async () => {
        const x = await make();
        const claims = await Promise.allSettled([workerPairingOperation(publicPool, 'claim', x.invitation, x.claim), workerPairingOperation(publicPool, 'claim', x.invitation, { ...x.claim, claimId: randomUUID() })]);
        assert.equal(claims.filter(r => r.status === 'fulfilled').length, 1);assert.equal(claims.find(r => r.status === 'rejected').reason.code, 'PAIRING_CLAIMED');
        const approved = await action({ action: 'approve', operationId: randomUUID(), pairingId: x.created.pairingId, deviceFingerprint: claims.find(r => r.status === 'fulfilled').value.deviceFingerprint });
        const before = psql(db, `select count(*) from app.worker_pairings`).trim();
        await Promise.all(Array.from({ length: 12 }, () => assert.rejects(action({ action: 'approve', operationId: randomUUID(), pairingId: x.created.pairingId, deviceFingerprint: claims.find(r => r.status === 'fulfilled').value.deviceFingerprint }), { code: 'PAIRING_DECIDED' })));
        assert.equal(psql(db, 'select count(*) from app.worker_pairings').trim(), before);
        assert.equal(psql(db, `select count(*) from app.telegram_workers where id='${approved.worker.id}'`).trim(), '1');
    });
    await t.test('poll waits for an in-flight approval before reading its worker binding', async () => {
        const x = await make(); const c = await workerPairingOperation(publicPool, 'claim', x.invitation, x.claim);
        const client = await pool.connect(); let poll;
        try {
            await client.query('begin;set local role app_staff');
            await client.query("select set_config('app.organization_id',$1,true),set_config('app.actor_id',$2,true)", [org, AUTHZ_ID.USER_ADMIN1]);
            await client.query('select app.worker_device_action_v1($1::jsonb)', [JSON.stringify({ action: 'approve', operationId: randomUUID(), pairingId: x.created.pairingId, deviceFingerprint: c.deviceFingerprint })]);
            poll = workerPairingOperation(publicPool, 'poll', x.verifier, { pairingId: x.created.pairingId });
            assert.equal(await Promise.race([poll.then(() => 'finished'), new Promise(resolve => setTimeout(() => resolve('waiting'), 100))]), 'waiting');
            await client.query('commit');assert.equal((await poll).status, 'approved');
        } catch (error) { await client.query('rollback').catch(() => {});await poll?.catch(() => {});throw error; }
        finally { client.release(); }
    });
    await t.test('rejected proof attempts persist across connections and cannot grow public rows', async () => {
        const before = Number(psql(db, 'select request_count from app.worker_pairing_budget').trim());
        for (const pairingId of ['\u0000', '\ud800']) await assert.rejects(workerPairingOperation(publicPool, 'poll', 'x'.repeat(43), { pairingId }), { code: 'INVALID_INPUT' });
        await Promise.all(Array.from({ length: 4 }, () => assert.rejects(workerPairingOperation(publicPool, 'poll', 'x'.repeat(43), { pairingId: randomUUID() }), { code: 'PAIRING_UNAVAILABLE' })));
        assert.equal(Number(psql(db, 'select request_count from app.worker_pairing_budget').trim()), before + 6);
        psql(db, "update app.worker_pairing_budget set minute_start=date_trunc('minute',now()),request_count=600");
        await assert.rejects(workerPairingOperation(publicPool, 'poll', paired.verifier, { pairingId: paired.created.pairingId }), { code: 'PAIRING_RATE_LIMIT', status: 429 });
        assert.equal(psql(db, 'select count(*) from app.worker_pairing_budget').trim(), '1');
        psql(db, 'update app.worker_pairing_budget set request_count=0');
    });
    await t.test('expiry is immediate; two-pending cap and rejected attempts persist in owner budget', async () => {
        const a = await make(), b = await make();
        const before = Number(psql(db, `select invite_count from app.worker_pairing_owner_budget where organization_id='${org}' and owner_user_id='${AUTHZ_ID.USER_ADMIN1}'`).trim());
        await assert.rejects(make(), { code: 'INVITATION_LIMIT', status: 429 });
        assert.equal(Number(psql(db, `select invite_count from app.worker_pairing_owner_budget where organization_id='${org}' and owner_user_id='${AUTHZ_ID.USER_ADMIN1}'`).trim()), before + 1);
        psql(db, `update app.worker_pairings set expires_at=now()-interval '1 second' where id='${a.created.pairingId}'`);
        assert.equal((await workerDeviceStatus(pool, identity, org, { pairingId: a.created.pairingId })).status, 'expired');
        await assert.rejects(workerPairingOperation(publicPool, 'claim', a.invitation, a.claim), { code: 'PAIRING_UNAVAILABLE' });
        await action({ action: 'cancel', operationId: randomUUID(), pairingId: b.created.pairingId });
    });
    await t.test('approval and cancellation race produces one bounded terminal outcome', async () => {
        const x = await make();const c = await workerPairingOperation(publicPool, 'claim', x.invitation, x.claim);
        const results = await Promise.allSettled([action({ action: 'approve', operationId: randomUUID(), pairingId: x.created.pairingId, deviceFingerprint: c.deviceFingerprint }), action({ action: 'cancel', operationId: randomUUID(), pairingId: x.created.pairingId })]);
        assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);assert.equal(results.find(r => r.status === 'rejected').reason.code, 'PAIRING_DECIDED');
        assert.equal(psql(db, `select (approve_operation is not null)::integer+(cancel_operation is not null)::integer from app.worker_pairings where id='${x.created.pairingId}'`).trim(), '1');
    });
    await t.test('same-token renewal is expiry-fenced and revoke immediately denies poll and heartbeat', async () => {
        const id = approved.result.worker.id;psql(db, `update app.telegram_workers set expires_at=now()+interval '1 day' where id='${id}'`);
        const item = (await workerDeviceStatus(pool, identity, org)).devices.find(v => v.id === id);
        const renew = { action: 'renew', operationId: randomUUID(), workerId: id, expectedExpiresAt: item.expiresAt };
        const renewed = await action(renew);assert.deepEqual(await action(renew), renewed);
        await assert.rejects(action({ ...renew, operationId: randomUUID() }), { code: 'WORKER_CHANGED' });
        assert.equal(psql(db, `select encode(token_sha256,'hex') from app.telegram_workers where id='${id}'`).trim(), sha(paired.token));
        await revokeTelegramWorker(pool, identity, org, id);clearPoll(paired.created.pairingId);
        assert.equal((await workerPairingOperation(publicPool, 'poll', paired.verifier, { pairingId: paired.created.pairingId })).status, 'access_denied');
        await assert.rejects(action(renew), { code: 'RENEWAL_UNAVAILABLE' });
        await assert.rejects(telegramConnectorOperation(publicPool, paired.token, 'claim', {}), { code: '42501' });
    });
    await t.test('list pagination is owner private and maintenance purges at most100 expired invitations', async () => {
        psql(db, `insert into app.telegram_workers(organization_id,owner_user_id,name,token_sha256) select '${org}','${AUTHZ_ID.USER_ADMIN1}','Synthetic device',sha256(i::text::bytea) from generate_series(1,30)i`);
        psql(db, `update app.organizations set name=repeat('界',250)||chr(10) where id='${org}'`);
        const page = await workerDeviceStatus(pool, identity, org);assert.equal([...page.organization.name].length, 200);assert.equal(page.devices.length, 25);assert(page.nextAfter);assert.equal(page.organization.id, org);
        const next = await workerDeviceStatus(pool, identity, org, { after: page.nextAfter });assert(!next.devices.some(d => page.devices.some(p => p.id === d.id)));
        assert.equal((await workerDeviceStatus(pool, other, org)).devices.length, 0);
        psql(db, `insert into app.worker_pairings(organization_id,owner_user_id,name,invitation_sha256,invite_operation,invite_digest,expires_at) select '${org}','${AUTHZ_ID.USER_ADMIN1}','Expired',sha256(('expired-'||i)::bytea),gen_random_uuid(),sha256(i::text::bytea),now()-interval '2 days' from generate_series(1,105)i`);
        const out = JSON.parse(psql(db, 'set role app_telegram_maintenance;select app.telegram_maintenance_v1();reset role;').trim());assert.equal(out.pairingRowsPurged, 100);assert.equal(out.remainingWork, true);
    });
});
