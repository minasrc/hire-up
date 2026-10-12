import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, randomBytes, createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { POSTGRES_17_IMAGE, assertLocalTestEnvironment, startPostgresContainer, stopAndRemoveContainer, psql } from '../support/foundation-docker.js';
import { AUTHZ_ID, SUBJECTS, installStaffFixture, staffPoolOptions } from '../support/staff-authorization.js';
import { telegramHostedStatus, telegramHostedPrepare, telegramHostedControl } from '../../src/lib/telegram-hosted-operations.js';
import { registerTelegramWorker } from '../../src/lib/telegram-intake-operations.js';
import { telegramNativeWorkerOperation } from '../../src/lib/telegram-native-update-operations.js';
import { telegramConnectionAction, telegramConnectorOperation } from '../../src/lib/telegram-connection-operations.js';
const dir = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
const files = readdirSync(dir).filter(f => f.endsWith('.sql') && f >= '20260922090000_foundation_roles.sql' && f <= '20261013110000_telegram_efficient_polling.sql').sort();
test('hosted service scope, exclusive runtime lease, durable enrollment and current authorization', async t => {
    assertLocalTestEnvironment(); const db = await startPostgresContainer('pghosted', POSTGRES_17_IMAGE, { publish: true }); let staff, control, connector;
    t.after(async () => { await Promise.all([staff?.end(), control?.end(), connector?.end()]); await stopAndRemoveContainer(db); });
    for (const f of files) psql(db, readFileSync(join(dir, f), 'utf8'));
    const password = installStaffFixture(db); staff = new pg.Pool(staffPoolOptions(db, password, 4));
    const runtimePassword = randomUUID();
    psql(db, `create role hosted_test login noinherit password '${runtimePassword}';grant app_telegram_hosted_service to hosted_test;create role connector_test login noinherit password '${runtimePassword}';grant app_telegram_worker to connector_test;`);
    control = new pg.Pool({ ...staffPoolOptions(db, runtimePassword, 3), user: 'hosted_test' });
    connector = new pg.Pool({ ...staffPoolOptions(db, runtimePassword, 2), user: 'connector_test' });
    const service = randomUUID(), instanceId = randomUUID(), org = AUTHZ_ID.ORG_A;
    const identity = { provider: 'google', issuer: 'https://accounts.google.com', subject: SUBJECTS.ADMIN1 }, other = { ...identity, subject: SUBJECTS.ADMIN2 };
    const prepare = (who = identity, scope = org) => telegramHostedPrepare(staff, who, scope, service, { action: 'prepare' });
    const status = (who = identity, scope = org) => telegramHostedStatus(staff, who, scope, service);
    let leaseToken, requestId, workerId, token, tokenSha256;
    await t.test('runtime role gets only four control functions and no raw table access', async () => {
        for (const table of ['telegram_hosted_services', 'telegram_hosted_requests', 'telegram_workers', 'telegram_connections']) assert.equal(psql(db, `select has_table_privilege('app_telegram_hosted_service','app.${table}','SELECT')`).trim(), 'f');
        assert.equal(psql(db, "select count(*) from pg_proc where pronamespace='app'::regnamespace and has_function_privilege('app_telegram_hosted_service',oid,'EXECUTE') and proname like 'telegram_hosted_%'").trim(), '4');
        assert.equal(psql(db, "select has_function_privilege('app_staff','app.telegram_hosted_register_v1(uuid,uuid,uuid,uuid,uuid,text)','EXECUTE')").trim(), 'f');
        assert.equal(psql(db, "select rolcanlogin or rolinherit or rolbypassrls from pg_roles where rolname='app_telegram_hosted_service'").trim(), 'f');
    });
    await t.test('prepare is idempotent, private and owner scoped while service is offline', async () => {
        assert.equal((await status()).state, 'unavailable');
        const a = await prepare(); assert.equal(a.errorCode, 'SERVICE_OFFLINE'); assert.deepEqual(await prepare(), a);
        assert.equal(psql(db, `select count(*) from app.telegram_hosted_requests where service_id='${service}'`).trim(), '1');
        assert.equal((await status(other)).workerId, null);
        await prepare(other);
        assert.equal(psql(db, `select count(*) from app.telegram_hosted_requests where service_id='${service}'`).trim(), '2');
    });
    await t.test('live service lease refuses competing process, wrong proof and expired proof', async () => {
        const result = await telegramHostedControl(control, service, { action: 'heartbeat', instanceId });leaseToken = result.leaseToken;
        assert(result.leaseSeconds >= 88 && result.leaseSeconds <= 90);assert.equal(result.capacity, 10);
        assert.equal((await telegramHostedControl(control, service, { action: 'heartbeat', instanceId })).leaseToken, leaseToken);
        await assert.rejects(telegramHostedControl(control, service, { action: 'heartbeat', instanceId: randomUUID() }), { code: '40001' });
        await assert.rejects(telegramHostedControl(control, service, { action: 'heartbeat', instanceId, leaseToken: randomUUID() }), { code: '40001' });
        await assert.rejects(telegramHostedControl(control, service, { action: 'list', instanceId, leaseToken: randomUUID() }), { code: '40001' });
        psql(db, `update app.telegram_hosted_services set lease_expires_at=clock_timestamp()-interval '1 second' where service_id='${service}'`);
        await assert.rejects(telegramHostedControl(control, service, { action: 'heartbeat', instanceId, leaseToken }), { code: '40001' });
        leaseToken = (await telegramHostedControl(control, service, { action: 'heartbeat', instanceId })).leaseToken;
    });
    await t.test('control sees bounded scope and registers exact credential once; browser never sees hash', async () => {
        const listed = await telegramHostedControl(control, service, { action: 'list', instanceId, leaseToken });
        requestId = listed.requests.find(r => r.ownerUserId === AUTHZ_ID.USER_ADMIN1).requestId;
        assert.equal(listed.requests.length, 2);assert.equal(listed.nextAfter, null);
        workerId = randomUUID();token = randomBytes(48).toString('base64url');tokenSha256 = createHash('sha256').update(token).digest('hex');
        const input = { action: 'register', instanceId, leaseToken, requestId, workerId, tokenSha256 };
        assert.deepEqual(await telegramHostedControl(control, service, input), { workerId, state: 'registered' });
        assert.deepEqual(await telegramHostedControl(control, service, input), { workerId, state: 'registered' });
        await assert.rejects(telegramHostedControl(control, service, { ...input, tokenSha256: 'b'.repeat(64) }), { code: '40001' });
        await assert.rejects(telegramHostedControl(control, service, { ...input, workerId: randomUUID() }), { code: '40001' });
        const otherPending = listed.requests.find(r => r.ownerUserId === AUTHZ_ID.USER_ADMIN2);
        await assert.rejects(telegramHostedControl(control, service, { ...input, requestId: otherPending.requestId, workerId: randomUUID() }), { code: '23505' });
        assert.equal((await status()).state, 'pending');
        const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
        await telegramConnectorOperation(connector, token, 'heartbeat', { publicKeySpki: key });
        const ready = await status(); assert.equal(ready.state, 'ready');assert.equal(ready.workerId, workerId);
        assert(!JSON.stringify(ready).includes(tokenSha256));assert(!JSON.stringify(ready).includes(token));assert(!JSON.stringify(ready).includes(leaseToken));
        assert.equal((await status(other)).workerId, null);
        const otherService = randomUUID(), otherInstance = randomUUID();
        const otherLease = (await telegramHostedControl(control, otherService, { action: 'heartbeat', instanceId: otherInstance })).leaseToken;
        assert.equal((await telegramHostedControl(control, otherService, { action: 'list', instanceId: otherInstance, leaseToken: otherLease })).requests.length, 0);
        await assert.rejects(telegramHostedControl(control, otherService, { ...input, instanceId: otherInstance, leaseToken: otherLease }), { code: 'P0002' });
    });
    await t.test('sync and poll coalesce scoped control without claiming queue jobs', async () => {
        const sync = await telegramHostedControl(control, service, { action: 'sync', instanceId, leaseToken });
        assert.equal(sync.protocolVersion, 1); assert.equal(sync.leaseToken, leaseToken);
        assert.equal(sync.requests.length, 2);
        assert.deepEqual(Object.keys(sync.requests[0].runnable).sort(), ['cv','history','source']);
        assert.match(sync.requests[0].wakeEpoch, /^(0|[1-9][0-9]*)$/);
        const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
        const polled = await telegramConnectorOperation(connector, token, 'poll', { publicKeySpki: key });
        assert.equal(polled.protocolVersion, 1); assert.equal(polled.connection, null);
        assert.equal(polled.nextPollAfterSeconds, 60);
        assert.deepEqual(polled.plan, { history:false, cv:false, source:false, nativeAccount:false, nativeChannels:false });
        assert.equal(psql(db, "select has_function_privilege('app_telegram_worker','app.telegram_work_plan_v1(uuid)','EXECUTE')").trim(), 'f');
    });
    await t.test('connection mutations wake the owner and repeated validation throttles timestamps', async () => {
        const before = await telegramHostedControl(control, service, { action: 'sync', instanceId, leaseToken });
        const prior = before.requests.find(r => r.workerId === workerId).wakeEpoch;
        await telegramConnectionAction(staff, identity, org, { action:'connect', workerId });
        const after = await telegramHostedControl(control, service, { action: 'sync', instanceId, leaseToken });
        assert.ok(BigInt(after.requests.find(r => r.workerId === workerId).wakeEpoch) > BigInt(prior));
        const key = psql(db, `select public_key_spki from app.telegram_connector_workers where id='${workerId}'`).trim();
        const polled = await telegramConnectorOperation(connector, token, 'poll', { publicKeySpki: key });
        assert.equal(polled.connection.status, 'requested'); assert.equal(polled.nextPollAfterSeconds, 5);
        const timestamp = psql(db, `select last_seen_at::text from app.telegram_workers where id='${workerId}'`).trim();
        await telegramConnectorOperation(connector, token, 'claim', {});
        assert.equal(psql(db, `select last_seen_at::text from app.telegram_workers where id='${workerId}'`).trim(), timestamp);
        const expiry = psql(db, `select expires_at::text from app.telegram_workers where id='${workerId}'`).trim();
        await telegramHostedControl(control, service, { action:'sync', instanceId, leaseToken });
        assert.equal(psql(db, `select expires_at::text from app.telegram_workers where id='${workerId}'`).trim(), expiry);
    });
    await t.test('quiet native channel completion supplies the authoritative next sweep time', async () => {
        const accountId=randomUUID(), chatId=randomUUID(), jobId=randomUUID();
        psql(db, `update app.telegram_connections set status='connected',profile='{"telegramUserId":"123456789","displayName":"Synthetic"}'::jsonb where worker_id='${workerId}';
          insert into app.telegram_history_accounts(id,organization_id,owner_user_id,connection_id,account_user_id) select '${accountId}',organization_id,owner_user_id,id,'123456789' from app.telegram_connections where worker_id='${workerId}';
          insert into app.telegram_history_chats(id,organization_id,owner_user_id,account_id,peer_kind,peer_id,title,selected) select '${chatId}',organization_id,owner_user_id,id,'channel','99','Synthetic',true from app.telegram_history_accounts where id='${accountId}';
          insert into app.telegram_history_jobs(id,organization_id,owner_user_id,account_id,chat_id,kind,connection_generation,status,cursor) select '${jobId}',organization_id,owner_user_id,account_id,id,'history',1,'completed','{}' from app.telegram_history_chats where id='${chatId}';`);
        const key=psql(db, `select public_key_spki from app.telegram_connector_workers where id='${workerId}'`).trim();
        const {connection}=await telegramConnectorOperation(connector,token,'poll',{publicKeySpki:key});
        const proof={connectionId:connection.id,generation:connection.generation,connectionLeaseToken:connection.leaseToken,accountUserId:'123456789'};
        const state={pts:1,qts:0,date:0,seq:0};
        let {job}=await telegramNativeWorkerOperation(connector,token,'channelClaim',proof);
        await telegramNativeWorkerOperation(connector,token,'channelComplete',{...proof,feedId:job.id,leaseToken:job.leaseToken,pageId:randomUUID(),scopeDigest:job.scopeDigest,fromState:job.fromState,nextState:state,kind:'baseline',gapReason:'INITIAL_BASELINE',changes:[]});
        ({job}=await telegramNativeWorkerOperation(connector,token,'channelClaim',proof));
        const result=await telegramNativeWorkerOperation(connector,token,'channelComplete',{...proof,feedId:job.id,leaseToken:job.leaseToken,pageId:randomUUID(),scopeDigest:job.scopeDigest,fromState:job.fromState,nextState:state,kind:'empty',gapReason:null,changes:[]});
        assert.ok(Date.parse(result.nextPollAt)>Date.now()+50000);
        assert.equal((await telegramNativeWorkerOperation(connector,token,'channelClaim',proof)).job,null);
    });
    await t.test('expired supervisor lease fences hosted credentials while local credentials still work', async () => {
        const local = await registerTelegramWorker(staff, identity, org, 'Synthetic local worker');
        const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
        psql(db, `update app.telegram_hosted_services set lease_expires_at=clock_timestamp()-interval '1 second' where service_id='${service}'`);
        await assert.rejects(telegramConnectorOperation(connector, token, 'heartbeat', { publicKeySpki: key }), { code: '42501' });
        await telegramConnectorOperation(connector, local.token, 'heartbeat', { publicKeySpki: key });
        leaseToken = (await telegramHostedControl(control, service, { action: 'heartbeat', instanceId })).leaseToken;
        await telegramConnectorOperation(connector, token, 'claim', {});
    });
    await t.test('workspace scope separates the same user and inactive users cannot request service', async () => {
        psql(db, `insert into app.role_permissions values('${AUTHZ_ID.ORG_B}','${AUTHZ_ID.ROLE_B_ADMIN}','candidates.read'),('${AUTHZ_ID.ORG_B}','${AUTHZ_ID.ROLE_B_ADMIN}','candidates.write')`);
        const shared = { ...identity, subject: SUBJECTS.SHARED };
        await prepare(shared, AUTHZ_ID.ORG_A);await prepare(shared, AUTHZ_ID.ORG_B);
        const records = (await telegramHostedControl(control, service, { action: 'list', instanceId, leaseToken })).requests.filter(r => r.ownerUserId === AUTHZ_ID.USER_SHARED);
        assert.equal(records.length, 2);assert.notEqual(records[0].organizationId, records[1].organizationId);
        for (const subject of [SUBJECTS.DISABLED, SUBJECTS.REVOKED, SUBJECTS.INVITED]) await assert.rejects(prepare({ ...identity, subject }));
        psql(db, `update app.users set status='disabled' where id='${AUTHZ_ID.USER_SHARED}'`);
        try {
            const listed = await telegramHostedControl(control, service, { action: 'list', instanceId, leaseToken });
            assert(listed.requests.filter(r => r.ownerUserId === AUTHZ_ID.USER_SHARED).every(r => !r.canRun));
        } finally { psql(db, `update app.users set status='active' where id='${AUTHZ_ID.USER_SHARED}'`); }
    });
    await t.test('live permission removal stops runtime dispatch and denies browser prepare', async () => {
        psql(db, `delete from app.role_permissions where organization_id='${org}' and role_id='${AUTHZ_ID.ROLE_A_ADMIN}' and permission_key='candidates.write'`);
        try {
            const listed = await telegramHostedControl(control, service, { action: 'list', instanceId, leaseToken });
            assert(listed.requests.filter(r => [AUTHZ_ID.USER_ADMIN1, AUTHZ_ID.USER_ADMIN2].includes(r.ownerUserId)).every(r => r.state === 'stopped' && !r.canRun));
            await assert.rejects(prepare(), { code: 'FORBIDDEN' });
            await assert.rejects(telegramHostedControl(control, service, { action: 'register', instanceId, leaseToken, requestId, workerId, tokenSha256 }), { code: '42501' });
        } finally { psql(db, `insert into app.role_permissions values('${org}','${AUTHZ_ID.ROLE_A_ADMIN}','candidates.write')`); }
        psql(db, `update app.telegram_workers set revoked_at=clock_timestamp() where id='${workerId}'`);
        const listed = await telegramHostedControl(control, service, { action: 'list', instanceId, leaseToken });
        assert.equal(listed.requests.find(r => r.workerId === workerId).canRun, false);assert.equal((await status()).errorCode, 'WORKER_REVOKED');
    });
});
