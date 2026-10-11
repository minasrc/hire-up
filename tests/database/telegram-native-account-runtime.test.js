import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import { POSTGRES_17_IMAGE, assertLocalTestEnvironment, psql, startPostgresContainer, stopAndRemoveContainer } from '../support/foundation-docker.js';
import { AUTHZ_ID, installStaffFixture, staffPoolOptions } from '../support/staff-authorization.js';
import { CJ_SUBJECTS, clientJobFixtureSql } from '../support/client-job-workflows.js';
import { withStaffTransaction } from '../../src/lib/staff-authorization.js';
import { telegramConnectionAction, telegramConnectorOperation } from '../../src/lib/telegram-connection-operations.js';
import { telegramHistoryAction, telegramHistoryStatus, telegramHistoryWorkerOperation } from '../../src/lib/telegram-history-operations.js';
import { telegramSourceUpdateStatus } from '../../src/lib/telegram-source-update-operations.js';
import { telegramExtractionAction, telegramExtractionWorkerOperation } from '../../src/lib/telegram-extraction-operations.js';
import { createVault } from '../../services/telegram-connector/vault.mjs';
import { createNativeWorker } from '../../services/telegram-connector/native-worker.mjs';
import { telegramNativeWorkerOperation } from '../../src/lib/telegram-native-update-operations.js';
import { createHistoryWorker } from '../../services/telegram-connector/history-worker.mjs';

const migrationsDir = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
const migration = '20261002230000_telegram_continuous_sync.sql';
const owner = { provider: 'google', issuer: 'https://accounts.google.com', subject: CJ_SUBJECTS.ADMIN };
const org = AUTHZ_ID.ORG_B;
const peer = { kind: 'user', id: '456789012345' };
const sentAt = '2026-09-29T12:00:00.000Z';
const message = (messageId, text, attachments = []) => ({
    messageId, kind: 'message', sentAt, editedAt: null,
    sender: { peer, username: 'synthetic_candidate', displayName: 'Synthetic Candidate' },
    replyToMessageId: null, forwardedFrom: null, text, attachments,
});

test('native account state commits atomically with selected retained mutations', { timeout: 120000 }, async t => {
    assertLocalTestEnvironment();
    const db = await startPostgresContainer('pgtelegramhistoryruntime', POSTGRES_17_IMAGE, { publish: true });
    const vaultRoot = mkdtempSync(join(tmpdir(), 'agora-history-runtime-'));
    let pool; let workerPool;
    t.after(async () => {
        await Promise.all([pool?.end(), workerPool?.end()]);
        stopAndRemoveContainer(db);
        rmSync(vaultRoot, { recursive: true, force: true });
    });
    for (const name of readdirSync(migrationsDir).filter(name => name >= '20260922090000_foundation_roles.sql' && name <= migration && name.endsWith('.sql')).sort()) {
        if (name !== migration) psql(db, readFileSync(join(migrationsDir, name), 'utf8'));
    }
    const password = installStaffFixture(db); psql(db, clientJobFixtureSql);
    pool = new pg.Pool(staffPoolOptions(db, password, 3));
    const workerPassword = randomUUID();
    psql(db, `create role telegram_history_runtime_test login noinherit nosuperuser nocreatedb nocreaterole nobypassrls password '${workerPassword}'; grant app_telegram_worker to telegram_history_runtime_test;`);
    workerPool = new pg.Pool({ ...staffPoolOptions(db, workerPassword, 3), user: 'telegram_history_runtime_test' });
    const token = randomBytes(48).toString('base64url');
    const registered = await withStaffTransaction(pool, owner, org, ['candidates.read', 'candidates.write'], async ({ client }) =>
        (await client.query('select app.telegram_register_worker_v1($1,$2) as result', ['Synthetic history Mac', token])).rows[0].result);
    const vaultConfig = { root: vaultRoot, server: 'https://synthetic.invalid', workerId: registered.id };
    let vault = createVault(vaultConfig);
    const connector = (action, body = {}) => telegramConnectorOperation(workerPool, token, action, body);
    await connector('heartbeat', { publicKeySpki: vault.publicKeySpki });
    await telegramConnectionAction(pool, owner, org, { action: 'connect', workerId: registered.id });
    const lease = await connector('claim');
    const accountUserId = '123456789012345';
    await connector('update', { connectionId: lease.id, generation: lease.generation, leaseToken: lease.leaseToken,
        status: 'connected', profile: { telegramUserId: accountUserId, username: 'synthetic_owner', displayName: 'Synthetic Owner' } });
    const action = body => telegramHistoryAction(pool, owner, org, body);
    const status = () => telegramHistoryStatus(pool, owner, org, { q: 'Synthetic candidate' });
    let loseHistoryAck = false; const completions = [];
    let clock = Date.now();
    const now = () => clock;
    const host = async (action, body) => {
        const result = await telegramHistoryWorkerOperation(workerPool, token, action, body).catch(error => {
            error.status = { '40001': 409, '42501': 403, P0002: 404 }[error.code];
            throw error;
        });
        if (action === 'complete') {
            completions.push({ body: structuredClone(body), result });
            if (loseHistoryAck && body.records.some(row => row.messageId)) {
                loseHistoryAck = false;
                throw new Error('SYNTHETIC_ACK_LOST');
            }
        }
        return result;
    };
    let incoming = [];
    const telegram = {
        async dialogs({ cursor }) {
            const offset = cursor.offsetId === '0' ? 0 : 1001 - Number(cursor.offsetId);
            if (cursor.folder === 1 || offset >= 301) return { records: [], nextCursor: cursor, done: true };
            const records = Array.from({ length: Math.min(100, 301 - offset) }, (_, index) => {
                const number = offset + index;
                return { peer: number === 0 ? peer : { kind: 'user', id: String(100000 + number) },
                    title: number === 0 ? 'Synthetic candidate' : `Volume chat ${number}`,
                    username: number === 0 ? 'synthetic_candidate' : `volume_${number}`, lastMessageAt: sentAt };
            });
            return { records, nextCursor: { ...cursor, offsetDate: Date.parse(sentAt) / 1000,
                offsetId: String(1001 - offset - records.length), offsetPeer: records.at(-1).peer, excludePinned: true }, done: false };
        },
        async history({ cursor }) {
            if (cursor.afterMessageId != null) {
                const records = incoming.filter(m => Number(m.messageId) > Number(cursor.afterMessageId) && (cursor.beforeMessageId == null || Number(m.messageId) < Number(cursor.beforeMessageId)) && (cursor.upperMessageId == null || Number(m.messageId) <= Number(cursor.upperMessageId))).sort((a,b) => Number(b.messageId)-Number(a.messageId)).slice(0,100);
                return { records, nextCursor: records.length ? { ...cursor, beforeMessageId: records.at(-1).messageId, upperMessageId: cursor.upperMessageId ?? records[0].messageId } : cursor, done: !records.length };
            }
            if (cursor.beforeMessageId === null) return {
                records: [message('103', 'Looking for a remote engineering role.'), message('102', '', [{ id: '12345', kind: 'document', filename: 'synthetic-cv.pdf', mimeType: 'application/pdf', sizeBytes: 512 }])],
                nextCursor: { beforeMessageId: '102', upperMessageId: '103' }, done: false,
            };
            if (cursor.beforeMessageId === '102') return {
                records: [{ ...message('101', ''), kind: 'unavailable', sentAt: null, sender: null }, message('100', 'Based in Madrid.')],
                nextCursor: { beforeMessageId: '100', upperMessageId: '103' }, done: false,
            };
            return { records: [], nextCursor: cursor, done: true };
        },
    };
    const context = { connectionId: lease.id, generation: lease.generation, connectionLeaseToken: lease.leaseToken,
        connectionLeaseExpiresAt: lease.leaseExpiresAt, accountUserId, telegram, signal: new AbortController().signal, isActive: () => true };
    let runtime = createHistoryWorker({ host, vault, now });
    await action({ action: 'discover' });
    for (let i = 0; i < 6 && (await status()).discovery.status !== 'completed'; i++) await runtime.tick(context);
    assert.equal((await status()).discovery.status, 'completed');
    assert.equal((await status()).totals.chats, 301, 'Hundreds of dialogs are committed across bounded pages');
    const page = await telegramHistoryStatus(pool, owner, org);
    assert.equal(page.chats.length, 50);
    assert.ok(page.nextCursor, 'Volume remains paginated at the hosted API');
    let chat = (await status()).chats[0];
    assert.equal(chat.username, 'synthetic_candidate');
    await action({ action: 'select', chatId: chat.id, expectedVersion: chat.version, selected: true });


    await runtime.tick(context); await runtime.tick(context); await runtime.tick(context);
    for(const name of readdirSync(migrationsDir).filter(name=>name>=migration&&name<='20261011200000_telegram_literal_boundaries.sql'&&name.endsWith('.sql')).sort()) psql(db,readFileSync(join(migrationsDir,name),'utf8'));
    chat=(await status()).chats[0];
    const proof={connectionId:context.connectionId,generation:context.generation,connectionLeaseToken:context.connectionLeaseToken,accountUserId};
    const native=(a,b={})=>telegramNativeWorkerOperation(workerPool,token,a,{...proof,...b});
    const nativePage=(j,kind,nextState,changes=[],gapReason=null)=>({leaseToken:j.leaseToken,pageId:randomUUID(),scopeDigest:j.scopeDigest,fromState:j.fromState,nextState,kind,gapReason,changes});
    const baseline={pts:10,qts:2,date:100,seq:1};
    let job=(await native('claim')).job;
    assert.equal(job.baseline,true);
    await native('complete',nativePage(job,'baseline',baseline,[],'INITIAL_BASELINE'));
    await t.test('missing state fields and absent direct SQL lease fail closed',async()=>{
      job=(await native('claim')).job;
      const client=await workerPool.connect();
      const direct=async(sql,params)=>{await client.query('begin');try{await client.query('set local role app_telegram_worker');return await client.query(sql,params);}finally{await client.query('rollback');}};
      const args=[token,proof.connectionId,proof.generation,proof.connectionLeaseToken,accountUserId];
      try{
       const p=nativePage(job,'empty',baseline);delete p.leaseToken;
       await assert.rejects(direct('select app.telegram_native_complete_v1($1,$2,$3,$4,$5,$6,$7::jsonb)',[...args,null,JSON.stringify(p)]),{code:'40001'});
       await assert.rejects(native('complete',nativePage(job,'difference',{...baseline,date:99})),{code:'22023'});
       await assert.rejects(native('complete',nativePage(job,'difference',{...baseline,qts:1})),{code:'22023'});
       const badReason=nativePage(job,'difference',baseline);badReason.gapReason={};delete badReason.leaseToken;await assert.rejects(direct('select app.telegram_native_complete_v1($1,$2,$3,$4,$5,$6,$7::jsonb)',[...args,job.leaseToken,JSON.stringify(badReason)]),{code:'22023'});
       const malformed=nativePage(job,'empty',{});delete malformed.leaseToken;
       await assert.rejects(direct('select app.telegram_native_complete_v1($1,$2,$3,$4,$5,$6,$7::jsonb)',[...args,job.leaseToken,JSON.stringify(malformed)]),{code:'22023'});
       await assert.rejects(direct('select app.telegram_native_defer_v1($1,$2,$3,$4,$5,$6,$7,$8)',[...args,job.leaseToken,null,60]),{code:'22023'});
      }finally{client.release();}
    });
    await t.test('selected edit and explicit deletion commit once with pts and exact quotas',async()=>{
      const resolved=await native('resolve',{leaseToken:job.leaseToken,scopeDigest:job.scopeDigest,candidates:[{action:'edit',peer,messageId:'103'},{action:'delete',peer:null,messageId:'102'},{action:'edit',peer:{kind:'user',id:'999'},messageId:'103'}]});
      assert.equal(resolved.targets.length,2);
      const changes=resolved.targets.map(target=>({action:target.index===0?'edit':'delete',chatId:target.chatId,chatVersion:target.chatVersion,messageId:target.messageId,record:target.index===0?message('103','Native changed text'):null}));
      const p=nativePage(job,'difference',{...baseline,pts:12},changes);
      assert.equal((await native('complete',p)).replayed,false);assert.equal((await native('complete',p)).replayed,true);
      assert.equal(psql(db,`select state->>'pts' from app.telegram_native_accounts`).trim(),'12');
      assert.equal(psql(db,`select body->>'text' from app.telegram_history_messages where chat_id='${chat.id}' and message_id=103`).trim(),'Native changed text');
      assert.equal(psql(db,`select source_availability from app.telegram_history_messages where chat_id='${chat.id}' and message_id=102`).trim(),'deleted');
      assert.equal(psql(db,`select stored_bytes=(select sum(stored_bytes) from app.telegram_history_messages) from app.telegram_history_limits`).trim(),'t');
    });
    await t.test('concurrent claim and complete use consistent owner quota lock ordering',async()=>{job=(await native('claim')).job;const p=nativePage(job,'difference',{...baseline,pts:12});const results=await Promise.all([native('claim'),native('complete',p)]);assert.equal(results[1].ok,true);});
    await t.test('native context-only deletion fences dependent v2 extraction and lost ACK survives origin disposal',async()=>{
      const previousFlag=process.env.TELEGRAM_EXTRACTION_CONTEXT_ENABLED;
      try{
        chat=(await status()).chats[0];
        await telegramExtractionAction(pool,owner,org,{action:'setExtraction',chats:[{chatId:chat.id,expectedVersion:chat.version}],enabled:true});
        const extract=(action,body)=>telegramExtractionWorkerOperation(workerPool,token,action,body);
        const extractionBody=j=>({jobId:j.id,leaseToken:j.leaseToken,sourceDigest:j.sourceDigest,result:{subjects:[]},metadata:{model:'synthetic-native-context',reportedModel:null,promptVersion:j.promptVersion}});
        const origin=(await extract('claim',{})).job;await extract('complete',extractionBody(origin));
        incoming=[{...message('104','I am a candidate based in Madrid.'),replyToMessageId:'100'}];
        psql(db,`update app.telegram_history_chats set next_sync_at=now()-interval '1 second' where id='${chat.id}'`);clock+=5001;
        await runtime.tick(context);await runtime.tick(context);
        process.env.TELEGRAM_EXTRACTION_CONTEXT_ENABLED='true';
        const dependent=(await extract('claim',{schemaVersions:['candidate-extraction-v1','candidate-extraction-v2']})).job;
        assert.equal(dependent.schemaVersion,'candidate-extraction-v2');
        assert.deepEqual(dependent.source.messages.map(m=>m.messageId),['104']);
        assert.ok(dependent.source.contextOnly.some(m=>m.messageId==='100'));
        const staleCompletion=extractionBody(dependent);let providerReads=0;let loseAck=true;const acknowledgements=[];
        context.telegram.native={account:async({fromState})=>{providerReads++;return{kind:'difference',nextState:{...fromState,pts:fromState.pts+1},gapReason:null,candidates:[{action:'delete',peer:null,messageId:'100'}],changes:targets=>targets.map(target=>({action:'delete',chatId:target.chatId,chatVersion:target.chatVersion,messageId:target.messageId,record:null}))};}};
        const nativeHost=async(action,body)=>{const result=await telegramNativeWorkerOperation(workerPool,token,action,body);if(action==='complete'){acknowledgements.push(result);if(loseAck){loseAck=false;throw new Error('SYNTHETIC_NATIVE_CONTEXT_ACK_LOST');}}return result;};
        await assert.rejects(createNativeWorker({host:nativeHost,vault,now}).tick(context),/SYNTHETIC_NATIVE_CONTEXT_ACK_LOST/);
        assert.equal(psql(db,`select source_invalidated_at is not null and error_code='SOURCE_CHANGED' and source->'contextOnly'='[]'::jsonb and encode(source_digest,'hex')<>'${dependent.sourceDigest}' from app.telegram_extraction_jobs where id='${dependent.id}'`).trim(),'t');
        assert.equal(psql(db,`select source_availability from app.telegram_history_messages where chat_id='${chat.id}' and message_id=100`).trim(),'deleted');
        await assert.rejects(extract('complete',staleCompletion),{code:'40001'});
        const disposed=JSON.parse(psql(db,`update app.telegram_extraction_jobs set source_release_requested_at=now() where id='${origin.id}';select app.telegram_retention_purge_v1('${origin.id}')`).trim());
        assert.equal(disposed.purged,true);
        await createNativeWorker({host:nativeHost,vault:createVault(vaultConfig),now}).tick(context);
        assert.equal(providerReads,1,'Encrypted native ACK replay must not read Telegram again after source disposal');
        assert.equal(acknowledgements[1].replayed,true);
        assert.equal(psql(db,`select count(*) from app.telegram_history_messages where chat_id='${chat.id}' and message_id=100`).trim(),'0');
        assert.equal(psql(db,`select count(*) from app.telegram_extraction_sources where chat_id='${chat.id}' and message_id=100`).trim(),'1','Disposed context keeps its import tombstone');
        assert.equal(psql(db,`select count(*) from app.telegram_history_messages where chat_id='${chat.id}' and message_id=104`).trim(),'1','Independent primary source remains retained');
        assert.equal(psql(db,`select stored_bytes=coalesce((select sum(stored_bytes) from app.telegram_history_messages),0) from app.telegram_history_limits`).trim(),'t');
        assert.equal(vault.loadHistory(context.connectionId,accountUserId,'pending-native-update'),null);
      }finally{if(previousFlag===undefined)delete process.env.TELEGRAM_EXTRACTION_CONTEXT_ENABLED;else process.env.TELEGRAM_EXTRACTION_CONTEXT_ENABLED=previousFlag;}
    });
    await t.test('pause fences pending completion; provider gap resets whole retained repair',async()=>{
      job=(await native('claim')).job;const old=nativePage(job,'difference',{...baseline,pts:13});
      chat=(await status()).chats[0];await action({action:'pause',chatId:chat.id,expectedVersion:chat.version});
      await assert.rejects(native('complete',old),{code:'40001'});
      chat=(await status()).chats[0];await action({action:'resume',chatId:chat.id,expectedVersion:chat.version});
      job=(await native('claim')).job;await native('defer',{leaseToken:job.leaseToken,code:'PROVIDER_GAP'});
      assert.equal(psql(db,`select needs_baseline from app.telegram_native_accounts`).trim(),'t');
      assert.equal(psql(db,`select cursor=0 from app.telegram_source_sweeps where chat_id='${chat.id}'`).trim(),'t');
      assert.equal((await telegramSourceUpdateStatus(pool,owner,org,[chat.id]))[0].gapReason,'PROVIDER_GAP');
    });
});
