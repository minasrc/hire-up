import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import { POSTGRES_17_IMAGE, assertLocalTestEnvironment, psql, startPostgresContainer, stopAndRemoveContainer } from '../support/foundation-docker.js';
import { AUTHZ_ID, installStaffFixture, staffPoolOptions } from '../support/staff-authorization.js';
import { telegramHostedControl, telegramHostedPrepare } from '../../src/lib/telegram-hosted-operations.js';
import { cleanupHostedTelegramStorage } from '../../src/lib/telegram-hosted-maintenance.js';

test('hosted cleanup requires a current service lease and commits private storage cleanup without exposing keys to the Mac', { timeout: 120000 }, async t => {
    assertLocalTestEnvironment();
    const db = await startPostgresContainer('pghostedmaintenance', POSTGRES_17_IMAGE, { publish: true });
    let staff; let control;
    t.after(async () => { await Promise.all([staff?.end(), control?.end()]); await stopAndRemoveContainer(db); });
    const directory = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
    for (const name of readdirSync(directory).filter(name => name.endsWith('.sql') && name >= '20260922090000'
        && name <= '20261013160000_telegram_hosted_maintenance.sql').sort()) psql(db, readFileSync(join(directory, name), 'utf8'));
    const password = installStaffFixture(db);
    staff = new pg.Pool(staffPoolOptions(db, password, 2));
    const runtimePassword = randomUUID();
    psql(db, `create role hosted_cleanup_test login noinherit password '${runtimePassword}'; grant app_telegram_hosted_service to hosted_cleanup_test;`);
    control = new pg.Pool({ ...staffPoolOptions(db, runtimePassword, 2), user: 'hosted_cleanup_test' });
    const ids = Object.fromEntries(['service', 'instance', 'worker', 'connection', 'account', 'chat', 'removal', 'operation', 'candidate', 'object'].map(key => [key, randomUUID()]));
    const org = AUTHZ_ID.ORG_A, user = AUTHZ_ID.USER_ADMIN1;
    const identity = { provider: 'google', issuer: 'https://accounts.google.com', subject: '1001' };
    await telegramHostedPrepare(staff, identity, org, ids.service, { action: 'prepare' });
    const lease = await telegramHostedControl(control, ids.service, { action: 'heartbeat', instanceId: ids.instance });
    const request = (await telegramHostedControl(control, ids.service, { action: 'list', instanceId: ids.instance, leaseToken: lease.leaseToken })).requests[0];
    await telegramHostedControl(control, ids.service, { action: 'register', instanceId: ids.instance, leaseToken: lease.leaseToken,
        requestId: request.requestId, workerId: ids.worker, tokenSha256: createHash('sha256').update(randomBytes(48)).digest('hex') });
    const key = `staff/${org}/${ids.candidate}/${ids.object}.pdf`;
    const publicKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    psql(db, `insert into app.telegram_connector_workers(id,organization_id,owner_user_id,public_key_spki)
        values('${ids.worker}','${org}','${user}','${publicKey}');
        insert into app.telegram_connections(id,organization_id,owner_user_id,worker_id,status,auth_expires_at,profile)
        values('${ids.connection}','${org}','${user}','${ids.worker}','disconnected',now()+interval '10 minutes','{"telegramUserId":"123456"}');
        insert into app.telegram_history_limits(organization_id,owner_user_id) values('${org}','${user}');
        insert into app.telegram_history_accounts(id,organization_id,owner_user_id,connection_id,account_user_id)
        values('${ids.account}','${org}','${user}','${ids.connection}','123456');
        insert into app.telegram_history_chats(id,organization_id,owner_user_id,account_id,peer_kind,peer_id,title,removal_state)
        values('${ids.chat}','${org}','${user}','${ids.account}','user','654321','Synthetic removed chat','device_pending');
        insert into app.telegram_chat_removals(id,organization_id,owner_user_id,chat_id,operation_id,expected_version,total_messages,total_bytes,server_purged_at,device_cleanup_at)
        values('${ids.removal}','${org}','${user}','${ids.chat}','${ids.operation}',1,1,20,now(),now());
        insert into app.telegram_chat_removal_objects values('${org}','${user}','${ids.removal}','${key}');
        insert into app.telegram_upload_cleanup(organization_id,owner_user_id,object_key) values('${org}','${user}','${key}');`);
    const input = { action: 'maintenance', instanceId: ids.instance, leaseToken: lease.leaseToken };
    await assert.rejects(telegramHostedControl(control, ids.service, { ...input, leaseToken: randomUUID() }), { code: '40001' });
    const receipt = await telegramHostedControl(control, ids.service, input);
    assert.equal(receipt.removalActionable, true);
    assert.equal(JSON.stringify(receipt).includes(key), false);
    for (const table of ['telegram_chat_removals', 'telegram_upload_cleanup', 'blob_locations']) {
        assert.equal(psql(db, `select has_table_privilege('app_telegram_hosted_service','app.${table}','SELECT')`).trim(), 'f');
    }
    assert.equal(psql(db, "select has_function_privilege('app_staff','app.telegram_hosted_storage_claim_v1(uuid,uuid,uuid)','EXECUTE')").trim(), 'f');
    let fail = true;
    const calls = [];
    const storage = { storage: { from: bucket => ({ remove: async keys => {
        assert.equal(bucket, 'cv-submissions'); calls.push(keys);
        return { error: fail ? new Error('synthetic storage outage') : null };
    } }) } };
    assert.deepEqual(await cleanupHostedTelegramStorage(control, ids.service, input, storage), { removed: 0, deferred: 1 });
    assert.throws(() => psql(db, `insert into app.blob_locations(id,organization_id,blob_id,backend_key,bucket,object_key,state)
        values('${randomUUID()}','${org}','${randomUUID()}','supabase_storage','cv-submissions','${key}','pending')`), /Private object removal already requested/, 'late binding is fenced after the deleting claim commits');
    assert.equal(psql(db, `select state from app.telegram_upload_cleanup where object_key='${key}'`).trim(), 'deleting');
    assert.equal(psql(db, `select completed_at is null from app.telegram_chat_removals where id='${ids.removal}'`).trim(), 't');
    assert.deepEqual(await cleanupHostedTelegramStorage(control, ids.service, input, storage), { removed: 0, deferred: 0 });
    assert.equal(calls.length, 1, 'durable provider backoff prevents immediate retries');
    psql(db, `update app.telegram_upload_cleanup set available_at=now() where object_key='${key}'`);
    fail = false;
    assert.deepEqual(await cleanupHostedTelegramStorage(control, ids.service, input, storage), { removed: 1, deferred: 0 });
    assert.deepEqual(calls, [[key], [key]]);
    assert.equal(psql(db, `select removal_state from app.telegram_history_chats where id='${ids.chat}'`).trim(), 'completed');
    assert.deepEqual(await cleanupHostedTelegramStorage(control, ids.service, input, storage), { removed: 0, deferred: 0 });
    const extra = Object.fromEntries(['chat', 'removal', 'operation', 'draft', 'protected', 'future', 'due', 'blob', 'location', 'approved'].map(name => [name, randomUUID()]));
    const keys = Object.fromEntries(['protected', 'future', 'due', 'approved'].map(name => [name, `staff/${org}/${ids.candidate}/${extra[name]}.pdf`]));
    psql(db, `insert into app.candidates(id,organization_id,full_name,identity_state,lifecycle)
        values('${ids.candidate}','${org}','Preserved approved candidate','established','active');
        insert into app.file_blobs(id,organization_id,candidate_id,sha256,size_bytes,mime_type,extension,lifecycle,scan_state)
        values('${extra.blob}','${org}','${ids.candidate}',sha256(convert_to('synthetic-file','UTF8')),1024,'application/pdf','pdf','live','unscanned');
        insert into app.blob_locations(id,organization_id,blob_id,backend_key,bucket,object_key,state)
        values('${extra.location}','${org}','${extra.blob}','supabase_storage','cv-submissions','${keys.approved}','pending');
        insert into app.telegram_history_chats(id,organization_id,owner_user_id,account_id,peer_kind,peer_id,title,removal_state)
        values('${extra.chat}','${org}','${user}','${ids.account}','user','654322','Second removal','device_pending');
        insert into app.telegram_chat_removals(id,organization_id,owner_user_id,chat_id,operation_id,expected_version,total_messages,total_bytes,server_purged_at,device_cleanup_at)
        values('${extra.removal}','${org}','${user}','${extra.chat}','${extra.operation}',1,0,0,now(),now());
        insert into app.telegram_drafts(id,organization_id,owner_user_id,document)
        values('${extra.draft}','${org}','${AUTHZ_ID.USER_ADMIN2}','{"objectKey":"${keys.protected}"}');
        update app.organization_memberships set status='revoked',revoked_at=now() where organization_id='${org}' and user_id='${user}';
        insert into app.telegram_upload_cleanup(organization_id,owner_user_id,object_key,available_at) values
        ('${org}','${user}','${keys.approved}',now()),
        ('${org}','${user}','${keys.protected}',now()),
        ('${org}','${user}','${keys.future}',now()+interval '1 hour'),
        ('${org}','${user}','${keys.due}',now());
        insert into app.telegram_chat_removal_objects values
        ('${org}','${user}','${extra.removal}','${keys.approved}'),
        ('${org}','${user}','${extra.removal}','${keys.protected}'),
        ('${org}','${user}','${extra.removal}','${keys.future}'),
        ('${org}','${user}','${extra.removal}','${keys.due}');`);
    assert.equal(psql(db, `select storage_pending and storage_due_at is not null from app.telegram_chat_removals where id='${extra.removal}'`).trim(), 't', 'reverse insert order and bypass seed context maintain the queue hint');
    const before = calls.length;
    const dispositionA = await cleanupHostedTelegramStorage(control, ids.service, input, storage);
    const dispositionB = await cleanupHostedTelegramStorage(control, ids.service, input, storage);
    assert.equal(dispositionA.removed + dispositionB.removed, 1);
    assert.equal(dispositionA.deferred + dispositionB.deferred, 0);
    assert.deepEqual(calls.slice(before), [[keys.due]], 'all-owner reference survives revoked removal owner; protected prefix does not starve due object');
    assert.equal(psql(db, `select count(*) from app.telegram_upload_cleanup where object_key='${keys.protected}'`).trim(), '0', 'retained copy only dispositions its cleanup record');
    assert.equal(psql(db, `select object_key from app.blob_locations where id='${extra.location}'`).trim(), keys.approved, 'approved blob remains even after owner revocation');
    psql(db, `update app.blob_locations set updated_at=now() where id='${extra.location}'`);
    assert.throws(() => psql(db, `insert into app.blob_locations(id,organization_id,blob_id,backend_key,bucket,object_key,state)
        values('${randomUUID()}','${org}','${extra.blob}','supabase_storage','cv-submissions','${keys.due}','pending')`), /Private object removal already requested/, 'late binding cannot reuse a removed key');
    assert.equal(psql(db, `select completed_at is null from app.telegram_chat_removals where id='${extra.removal}'`).trim(), 't', 'late upload reservation keeps completion honestly pending');
    const waiting = await telegramHostedControl(control, ids.service, input);
    assert.equal(waiting.removalActionable, false);
    assert.equal(waiting.nextMaintenanceAfterSeconds, 300);
    assert.deepEqual(await cleanupHostedTelegramStorage(control, ids.service, input, storage), { removed: 0, deferred: 0 });
    psql(db, `update app.telegram_upload_cleanup set available_at=now() where object_key='${keys.future}'`);
    assert.deepEqual(await cleanupHostedTelegramStorage(control, ids.service, input, storage), { removed: 1, deferred: 0 });
    assert.equal(psql(db, `select completed_at is not null from app.telegram_chat_removals where id='${extra.removal}'`).trim(), 't');
    psql(db, `update app.telegram_hosted_services set lease_expires_at=now()-interval '1 second' where service_id='${ids.service}'`);
    await assert.rejects(cleanupHostedTelegramStorage(control, ids.service, input, storage), { code: '40001' });
    assert.equal(calls.length, 4, 'expired lease never reaches the storage provider');
});
