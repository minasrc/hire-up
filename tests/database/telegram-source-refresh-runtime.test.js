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
import { getTelegramDraft } from '../../src/lib/telegram-intake-operations.js';
import { telegramExtractionAction, telegramExtractionWorkerOperation } from '../../src/lib/telegram-extraction-operations.js';
import { telegramSourceUpdateWorkerOperation, telegramSourceUpdateStatus } from '../../src/lib/telegram-source-update-operations.js';
import { createVault } from '../../services/telegram-connector/vault.mjs';
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

test('automatic source refresh integrates with retained history and durable checkpoints', { timeout: 180000 }, async t => {
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
    let loseHistoryAck = false; let historyReads = 0; const completions = [];
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
            historyReads++;
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

    await t.test('lost page acknowledgement survives encrypted-vault restart without another Telegram read', async () => {
        loseHistoryAck = true;
        await runtime.tick(context).catch(error => assert.match(error.message, /SYNTHETIC_ACK_LOST|HOST_UNAVAILABLE/));
        assert.equal((await status()).totals.messages, 2);
        assert.equal(historyReads, 1);
        psql(db, `update app.telegram_connections set lease_expires_at=now()-interval '1 second' where id='${lease.id}'`);
        const renewed = await connector('claim');
        assert.notEqual(renewed.leaseToken, context.connectionLeaseToken);
        context.connectionLeaseToken = renewed.leaseToken;
        context.connectionLeaseExpiresAt = renewed.leaseExpiresAt;
        vault = createVault(vaultConfig);
        runtime = createHistoryWorker({ host, vault, now });
        await runtime.tick(context);
        assert.equal(historyReads, 1, 'Restart must replay the pending page before requesting another');
        assert.equal((await status()).totals.messages, 2);
        const historyCompletions = completions.filter(row => row.body.records.some(record => record.messageId));
        assert.equal(historyCompletions.length, 2);
        const { connectionLeaseToken: previousProof, ...originalPage } = historyCompletions[0].body;
        const { connectionLeaseToken: renewedProof, ...retriedPage } = historyCompletions[1].body;
        assert.notEqual(previousProof, renewedProof, 'Retry uses the freshly claimed connection proof');
        assert.deepEqual(originalPage, retriedPage);
        assert.equal(historyCompletions[1].result.replayed, true);
    });

    await t.test('pause halts reads and resume completes text and attachment-only history exactly once', async () => {
        chat = (await status()).chats[0];
        await action({ action: 'pause', chatId: chat.id, expectedVersion: chat.version });
        await runtime.tick(context);
        assert.equal(historyReads, 1);
        chat = (await status()).chats[0];
        assert.equal(chat.import.status, 'paused');
        await action({ action: 'resume', chatId: chat.id, expectedVersion: chat.version });
        clock += 5001;
        await runtime.tick(context);
        assert.equal((await status()).totals.messages, 4);
        await runtime.tick(context);
        const final = await status();
        assert.equal(final.chats[0].import.status, 'completed');
        assert.equal(final.totals.messages, 4);
        assert.equal(historyReads, 3, 'Two data pages and one genuinely empty page');
        const attachmentPage = completions.find(row => row.body.records.some(record => record.messageId === '102'));
        assert.equal(attachmentPage.body.records.find(record => record.messageId === '102').attachments[0].filename, 'synthetic-cv.pdf');
    });

    // Apply the new migration to an already imported chat, matching production rollout.
    psql(db, readFileSync(join(migrationsDir, migration), 'utf8'));
    const due = () => { psql(db, `update app.telegram_history_chats set next_sync_at=now()-interval '1 second' where id='${chat.id}'`); clock += 5001; };
    const savedCheckpoint = () => psql(db, `select sync_checkpoint from app.telegram_history_chats where id='${chat.id}'`).trim();
    await t.test('new text and CV suggestions queue extraction, with a replayed acknowledgement', async () => {
        assert.equal(savedCheckpoint(), '103');
        chat = (await status()).chats[0];
        await telegramExtractionAction(pool, owner, org, { action: 'setExtraction', chats: [{ chatId: chat.id, expectedVersion: chat.version }], enabled: true });
        const initial = (await telegramExtractionWorkerOperation(workerPool, token, 'claim', {})).job;
        await telegramExtractionWorkerOperation(workerPool, token, 'complete', { jobId: initial.id, leaseToken: initial.leaseToken, sourceDigest: initial.sourceDigest, result: { subjects: [] }, metadata: { model: 'synthetic-sync', promptVersion: 'candidate-extraction-prompt-v1', reportedModel: null } });
        incoming = [message('104', 'I am Alex Smith, email alex@example.test.'), message('105', '', [{ id: '12346', kind: 'document', filename: 'new-cv.pdf', mimeType: 'application/pdf', sizeBytes: 512 }])];
        due(); loseHistoryAck = true;
        await assert.rejects(runtime.tick(context), /SYNTHETIC_ACK_LOST/);
        assert.equal(savedCheckpoint(), '103', 'A data page cannot advance the full-pass checkpoint');
        const reads = historyReads;
        runtime = createHistoryWorker({ host, vault: createVault(vaultConfig), now });
        await runtime.tick(context);
        assert.equal(historyReads, reads, 'Lost acknowledgement replays before another provider read');
        await runtime.tick(context);
        assert.equal(savedCheckpoint(), '105');
        const synced = (await status()).chats[0].sync;
        assert.equal(synced.status, 'up_to_date'); assert.ok(synced.lastSyncedAt);
        const batch = (await telegramExtractionWorkerOperation(workerPool, token, 'claim', {})).job;
        assert.ok(batch.source.messages.some(m => m.messageId === '104'));
        assert.equal(batch.source.messages.find(m => m.messageId === '105').attachments[0].filename, 'new-cv.pdf');
        const result = { subjects: [{ key: 'alex', identity: { kind: 'telegram_sender', messageId: '104', quote: incoming[0].text }, facts: [['firstName','Alex'],['lastName','Smith'],['primaryEmail','alex@example.test']].map(([field,value]) => ({ field,value,evidence: [{ messageId: '104',quote: incoming[0].text }] })), attachments: [{ messageId: '105', attachmentIndex: 0 }] }] };
        const payload = { jobId: batch.id, leaseToken: batch.leaseToken, sourceDigest: batch.sourceDigest, result, metadata: { model: 'synthetic-sync', promptVersion: 'candidate-extraction-prompt-v1', reportedModel: null } };
        const extracted = await telegramExtractionWorkerOperation(workerPool, token, 'complete', payload);
        assert.equal(extracted.draftIds.length, 1);
        const draft = await getTelegramDraft(pool, owner, org, extracted.draftIds[0]);
        assert.equal(draft.fields.primaryEmail, 'alex@example.test');
        assert.deepEqual(await telegramExtractionWorkerOperation(workerPool, token, 'complete', payload), extracted, 'Extraction completion also replays without duplicating the draft');
        assert.equal((await status()).totals.messages, 6);
        await runtime.tick(context);
        assert.equal(historyReads, reads + 1, 'Completed sync waits for its scheduled poll');
    });
    await t.test('downtime backlog uses bounded pages and freezes arrivals for the next pass', async () => {
        incoming.push(...Array.from({ length: 205 }, (_, i) => message(String(106+i), `Missed message ${i}`)));
        due(); runtime = createHistoryWorker({ host, vault: createVault(vaultConfig), now });
        await runtime.tick(context);
        assert.equal(savedCheckpoint(), '105');
        incoming.push(message('311', 'Arrived during the current pass'));
        await runtime.tick(context); await runtime.tick(context); await runtime.tick(context);
        assert.equal(savedCheckpoint(), '310');
        assert.equal(psql(db, `select count(*) from app.telegram_history_messages where chat_id='${chat.id}' and message_id=311`).trim(), '0');
        due(); await runtime.tick(context); await runtime.tick(context);
        assert.equal(savedCheckpoint(), '311');
        assert.equal((await status()).totals.messages, 212);
    });
    await t.test('pause and deselection fence reads; resume recovers missed messages', async () => {
        chat = (await status()).chats[0];
        await action({ action: 'pause', chatId: chat.id, expectedVersion: chat.version });
        due(); const reads = historyReads; await runtime.tick(context);
        assert.equal(historyReads, reads); assert.equal((await status()).chats[0].sync.status, 'paused');
        incoming.push(message('312', 'While paused'));
        chat = (await status()).chats[0]; await action({ action: 'resume', chatId: chat.id, expectedVersion: chat.version });
        clock += 5001; await runtime.tick(context); await runtime.tick(context);
        assert.equal(savedCheckpoint(), '312');
        chat = (await status()).chats[0]; await action({ action: 'select', chatId: chat.id, expectedVersion: chat.version, selected: false });
        due(); const afterResume = historyReads; await runtime.tick(context); assert.equal(historyReads, afterResume);
        assert.equal((await status()).chats[0].sync.status, 'off');
        chat = (await status()).chats[0]; await action({ action: 'select', chatId: chat.id, expectedVersion: chat.version, selected: true });
        clock += 5001; await runtime.tick(context);
        assert.equal(savedCheckpoint(), '312');
    });
    await t.test('flood waits and expired job leases retain the same sync boundary', async () => {
        due();
        const proof = { connectionId: context.connectionId, generation: context.generation, connectionLeaseToken: context.connectionLeaseToken, accountUserId };
        const first = (await host('claim', proof)).job;
        await host('defer', { ...proof, jobId: first.id, jobLeaseToken: first.leaseToken, code: 'FLOOD_WAIT', retryAfterSeconds: 60 });
        assert.equal((await host('claim', proof)).job, null);
        assert.equal(savedCheckpoint(), '312');
        psql(db, `update app.telegram_history_accounts set cooldown_until=now()-interval '1 second'; update app.telegram_history_jobs set retry_at=now()-interval '1 second' where id='${first.id}'`);
        const second = (await host('claim', proof)).job;
        assert.deepEqual(second.cursor, first.cursor);
        psql(db, `update app.telegram_history_jobs set lease_expires_at=now()-interval '1 second' where id='${second.id}'`);
        const third = (await host('claim', proof)).job;
        assert.notEqual(third.leaseToken, second.leaseToken); assert.deepEqual(third.cursor, second.cursor);
        await assert.rejects(host('complete', { ...proof, jobId: second.id, jobLeaseToken: second.leaseToken, pageId: randomUUID(), fromCursor: second.cursor, nextCursor: second.cursor, done: true, records: [] }), { code: '40001' });
        await host('complete', { ...proof, jobId: third.id, jobLeaseToken: third.leaseToken, pageId: randomUUID(), fromCursor: third.cursor, nextCursor: third.cursor, done: true, records: [] });
    });
    await t.test('invalid lower bounds and quota rejection leave the checkpoint unchanged', async () => {
        due();
        const proof = { connectionId: context.connectionId, generation: context.generation, connectionLeaseToken: context.connectionLeaseToken, accountUserId };
        const j = (await host('claim', proof)).job;
        await assert.rejects(host('complete', { ...proof, jobId: j.id, jobLeaseToken: j.leaseToken, pageId: randomUUID(), fromCursor: j.cursor, nextCursor: { ...j.cursor, beforeMessageId: '312', upperMessageId: '312' }, done: false, records: [message('312','Cannot replay checkpoint')] }), { code: '22023' });
        await assert.rejects(host('complete', { ...proof, jobId: j.id, jobLeaseToken: j.leaseToken, pageId: randomUUID(), fromCursor: j.cursor, nextCursor: { ...j.cursor, afterMessageId: '0', beforeMessageId: '313', upperMessageId: '313' }, done: false, records: [message('313','Wrong lower bound')] }), { code: '22023' });
        psql(db, 'update app.telegram_history_limits set max_messages=stored_messages');
        incoming.push(message('313', 'Capacity must pause before advancing'));
        await runtime.tick(context);
        assert.equal((await status()).chats[0].sync.status, 'capacity_paused'); assert.equal(savedCheckpoint(), '312');
        psql(db, 'update app.telegram_history_limits set max_messages=200000');
        chat = (await status()).chats[0]; await action({ action: 'resume', chatId: chat.id, expectedVersion: chat.version });
        await runtime.tick(context); await runtime.tick(context); assert.equal(savedCheckpoint(), '313');
    });
    psql(db, readFileSync(join(migrationsDir, '20261011130000_telegram_source_updates.sql'), 'utf8'));
    psql(db, readFileSync(join(migrationsDir, '20261011140000_telegram_source_refresh.sql'), 'utf8'));
    await t.test('retained reconciliation commits edits, replays ACKs, sweeps old IDs, and fences pause', async () => {
      const sourceHost = (action,body) => telegramSourceUpdateWorkerOperation(workerPool,token,action,body);
      const proof = {connectionId:context.connectionId,generation:context.generation,connectionLeaseToken:context.connectionLeaseToken,accountUserId};
      const j=(await sourceHost('claim',proof)).job;
      assert.ok(j.messageIds.length>0); assert.ok(Number(j.messageIds[0])<=100, 'Starts at old retained IDs');
      async function direct(sql,args) {
        const client=await workerPool.connect();
        try {await client.query('begin;set local role app_telegram_worker');return await client.query(sql,args);}
        finally {await client.query('rollback');client.release();}
      }
      const directProof=[token,proof.connectionId,proof.generation,proof.connectionLeaseToken,proof.accountUserId];
      await assert.rejects(direct('select app.telegram_source_updates_defer_v1($1,$2,$3,$4,$5,$6,$7,$8,$9)',[...directProof,j.id,j.leaseToken,null,60]),{code:'22023'});
      await assert.rejects(direct('select app.telegram_source_updates_defer_v1($1,$2,$3,$4,$5,$6,$7,$8,$9)',[...directProof,j.id,j.leaseToken,'FLOOD_WAIT',null]),{code:'22023'});
      await assert.rejects(direct('select app.telegram_source_updates_complete_v1($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',[...directProof,j.id,null,JSON.stringify({pageId:randomUUID(),records:[]})]),{code:'40001'});
      await assert.rejects(direct('select app.telegram_source_updates_complete_v1($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',[...directProof,j.id,j.leaseToken,null]),{code:'22023'});
      await assert.rejects(withStaffTransaction(pool,owner,org,['candidates.read'],({client})=>client.query('select app.telegram_source_updates_status_v1(null::uuid[])')),{code:'22023'});

      const bodies=JSON.parse(psql(db,`select jsonb_agg(body order by message_id) from app.telegram_history_messages where chat_id='${chat.id}' and message_id in (${j.messageIds.join(',')})`).trim());
      bodies[0].text='Edited retained message'; bodies[0].editedAt=sentAt;
      const page={...proof,jobId:j.id,jobLeaseToken:j.leaseToken,pageId:randomUUID(),records:bodies};
      const total=(await status()).totals.messages;
      assert.equal((await sourceHost('complete',page)).status,'checked');
      assert.equal((await sourceHost('complete',page)).replayed,true);
      assert.equal((await status()).totals.messages,total);
      assert.equal(psql(db,`select stored_bytes=(select sum(stored_bytes) from app.telegram_history_messages) from app.telegram_history_limits`).trim(),'t');
      const next=(await sourceHost('claim',proof)).job;
      assert.ok(Number(next.messageIds[0])>Number(j.messageIds.at(-1)));
      chat=(await status()).chats[0];await action({action:'pause',chatId:chat.id,expectedVersion:chat.version});
      await assert.rejects(sourceHost('complete',{...proof,jobId:next.id,jobLeaseToken:next.leaseToken,pageId:randomUUID(),records:bodies}),{code:'40001'});
      assert.equal((await sourceHost('claim',proof)).job,null);
      assert.equal((await telegramSourceUpdateStatus(pool,owner,org,[chat.id]))[0].mode,'retained_message_reconciliation');
      chat=(await status()).chats[0];await action({action:'resume',chatId:chat.id,expectedVersion:chat.version});
      const affectedDraft=psql(db,`select draft_id from app.telegram_extraction_proposals where job_id=(select job_id from app.telegram_extraction_sources where chat_id='${chat.id}' and message_id=104) limit 1`).trim();
      const independentJob=randomUUID();
      psql(db,`insert into app.telegram_extraction_jobs(id,organization_id,owner_user_id,chat_id,source,source_digest,message_count,status) select '${independentJob}',organization_id,owner_user_id,id,'{"messages":[]}',sha256(convert_to('synthetic independent batch','UTF8')),0,'completed' from app.telegram_history_chats where id='${chat.id}';insert into app.telegram_extraction_proposals(organization_id,owner_user_id,job_id,draft_id,field,suggested_value,evidence,status) select organization_id,owner_user_id,'${independentJob}','${affectedDraft}','firstName','"Alex"','[]','applied' from app.telegram_history_chats where id='${chat.id}';update app.telegram_drafts set fields=fields||'{"location":"Remote"}',human_fields=array['lastName'] where id='${affectedDraft}'`);
      const changed=(await sourceHost('claim',proof)).job;
      const affected=JSON.parse(psql(db,`select jsonb_agg(body order by message_id) from app.telegram_history_messages where chat_id='${chat.id}' and message_id in (${changed.messageIds.join(',')})`).trim());
      assert.ok(affected.some(m=>m.messageId==='104'));
      affected.find(m=>m.messageId==='104').text='Updated identity';
      const missing=affected.find(m=>m.messageId==='105');
      Object.assign(missing,{kind:'unavailable',sentAt:null,editedAt:null,sender:null,replyToMessageId:null,forwardedFrom:null,text:'',attachments:[]});
      await sourceHost('complete',{...proof,jobId:changed.id,jobLeaseToken:changed.leaseToken,pageId:randomUUID(),records:affected});
      assert.equal(psql(db,`select source_invalidated_at is not null and source_purged_at is null and error_code='SOURCE_CHANGED' from app.telegram_extraction_jobs where id=(select job_id from app.telegram_extraction_sources where chat_id='${chat.id}' and message_id=104)`).trim(),'t');
      assert.equal(psql(db,`select count(*) from app.telegram_evidence where extraction_job_id=(select job_id from app.telegram_extraction_sources where chat_id='${chat.id}' and message_id=104)`).trim(),'0');
      assert.equal((await telegramSourceUpdateStatus(pool,owner,org,[chat.id])).find(c=>c.chatId===chat.id).needsReextraction,true);
      const protectedDraft=await getTelegramDraft(pool,owner,org,affectedDraft);
      assert.equal(protectedDraft.fields.firstName,'Alex','Independent current applied proposal preserves matching fact');
      assert.equal(protectedDraft.fields.lastName,'Smith','Human field preserved');
      assert.equal(protectedDraft.fields.location,'Remote','Unrelated machine field preserved');
      assert.equal(protectedDraft.fields.primaryEmail,undefined,'Affected machine fact cleared');

      assert.equal(psql(db,`select body->>'kind' from app.telegram_history_messages where chat_id='${chat.id}' and message_id=105`).trim(),'unavailable');
      const flood=(await sourceHost('claim',proof)).job;
      await sourceHost('defer',{...proof,jobId:flood.id,jobLeaseToken:flood.leaseToken,code:'FLOOD_WAIT',retryAfterSeconds:60});
      assert.equal((await sourceHost('claim',proof)).job,null);
      psql(db,`update app.telegram_history_accounts set cooldown_until=now()-interval '1 second';update app.telegram_source_sweeps set due_at=now()-interval '1 second' where chat_id='${chat.id}'`);
      const resumed=(await sourceHost('claim',proof)).job;
      assert.deepEqual(resumed.messageIds,flood.messageIds);
      psql(db,`update app.telegram_source_sweeps set lease_expires_at=now()-interval '1 second' where chat_id='${chat.id}'`);
      const expiredBodies=JSON.parse(psql(db,`select jsonb_agg(body order by message_id) from app.telegram_history_messages where chat_id='${chat.id}' and message_id in (${resumed.messageIds.join(',')})`).trim());
      await assert.rejects(sourceHost('complete',{...proof,jobId:resumed.id,jobLeaseToken:resumed.leaseToken,pageId:randomUUID(),records:expiredBodies}),{code:'40001'});
      let last=0;
      for(let i=0;i<60;i++) {
        const sweep=(await sourceHost('claim',proof)).job;if(!sweep)break;
        const records=JSON.parse(psql(db,`select jsonb_agg(body order by message_id) from app.telegram_history_messages where chat_id='${chat.id}' and message_id in (${sweep.messageIds.join(',')})`).trim());
        last=Number(sweep.messageIds.at(-1));await sourceHost('complete',{...proof,jobId:sweep.id,jobLeaseToken:sweep.leaseToken,pageId:randomUUID(),records});
      }
      assert.equal(last,313,'Full sweep includes latest retained ID, without permanent recent window');
      assert.ok((await telegramSourceUpdateStatus(pool,owner,org,[chat.id])).find(c=>c.chatId===chat.id).lastCycleAt);
      const oldJob=psql(db,`select job_id from app.telegram_extraction_sources where chat_id='${chat.id}' and message_id=100`).trim();
      psql(db,`update app.telegram_extraction_jobs set source_release_requested_at=now() where id='${oldJob}'`);
      const purged=JSON.parse(psql(db,`select app.telegram_retention_purge_v1('${oldJob}')`).trim());
      assert.equal(purged.purged,true,'Changed source remains eligible for real retention purge');
      assert.equal(psql(db,`select count(*) from app.telegram_history_messages where chat_id='${chat.id}' and message_id=100`).trim(),'0');
      assert.equal(psql(db,`select count(*) from app.telegram_extraction_sources where chat_id='${chat.id}' and message_id=100`).trim(),'1','Durable import tombstone survives purge');
      assert.equal(psql(db,`select stored_bytes=(select sum(stored_bytes) from app.telegram_history_messages) from app.telegram_history_limits`).trim(),'t');

    });
    await t.test('automatic bounded extraction refresh drains source changes and keeps immutable origin tombstones', async () => {
      let refreshed=null;
      const metadata={model:'synthetic-refresh',promptVersion:'candidate-extraction-prompt-v1',reportedModel:null};
      for(let i=0;i<10;i++) {
        const j=(await telegramExtractionWorkerOperation(workerPool,token,'claim',{})).job;if(!j)break;
        const isRefresh=psql(db,`select source_refresh from app.telegram_extraction_jobs where id='${j.id}'`).trim()==='t';
        if(isRefresh) {refreshed=j;assert.equal(j.source.messages.find(m=>m.messageId==='104').text,'Updated identity');}
        const payload={jobId:j.id,leaseToken:j.leaseToken,sourceDigest:j.sourceDigest,result:{subjects:[]},metadata};
        const result=await telegramExtractionWorkerOperation(workerPool,token,'complete',payload);
        assert.deepEqual(await telegramExtractionWorkerOperation(workerPool,token,'complete',payload),result,'Lost refresh ACK replays exactly');
      }
      assert.ok(refreshed,'Automatic existing scheduler eventually reaches changed retained sources');
      assert.equal((await telegramSourceUpdateStatus(pool,owner,org,[chat.id])).find(c=>c.chatId===chat.id).needsReextraction,false);
      assert.equal(psql(db,`select job_id='${refreshed.id}' and origin_job_id<>'${refreshed.id}' from app.telegram_extraction_sources where chat_id='${chat.id}' and message_id=104`).trim(),'t');
      const sourceHost=(action,body)=>telegramSourceUpdateWorkerOperation(workerPool,token,action,body);
      const proof={connectionId:context.connectionId,generation:context.generation,connectionLeaseToken:context.connectionLeaseToken,accountUserId};
      async function edit(text) {
        psql(db,`update app.telegram_source_sweeps set cursor=103,due_at=now()-interval '1 second',lease_token=null,lease_expires_at=null where chat_id='${chat.id}'`);
        const j=(await sourceHost('claim',proof)).job;
        const records=JSON.parse(psql(db,`select jsonb_agg(body order by message_id) from app.telegram_history_messages where chat_id='${chat.id}' and message_id in (${j.messageIds.join(',')})`).trim());
        records.find(m=>m.messageId==='104').text=text;
        await sourceHost('complete',{...proof,jobId:j.id,jobLeaseToken:j.leaseToken,pageId:randomUUID(),records});
      }
      const payload=j=>({jobId:j.id,leaseToken:j.leaseToken,sourceDigest:j.sourceDigest,result:{subjects:[]},metadata});
      await edit('Refresh revision two');
      const oldVersion=psql(db,`select source_version from app.telegram_extraction_jobs where id='${refreshed.id}'`).trim();
      let inFlight=(await telegramExtractionWorkerOperation(workerPool,token,'claim',{})).job;
      assert.ok(inFlight.source.messages.some(m=>m.messageId==='104'));
      await edit('Refresh changed while model leased');
      assert.equal(psql(db,`select source_version from app.telegram_extraction_jobs where id='${refreshed.id}'`).trim(),oldVersion,'Already invalidated snapshots do not churn on repeated edits');
      await assert.rejects(telegramExtractionWorkerOperation(workerPool,token,'complete',payload(inFlight)),{code:'40001'});
      inFlight=(await telegramExtractionWorkerOperation(workerPool,token,'claim',{})).job;
      assert.equal(inFlight.source.messages.find(m=>m.messageId==='104').text,'Refresh changed while model leased');
      chat=(await status()).chats[0];await action({action:'pause',chatId:chat.id,expectedVersion:chat.version});
      await assert.rejects(telegramExtractionWorkerOperation(workerPool,token,'complete',payload(inFlight)),{code:'40001'});
      assert.equal((await telegramExtractionWorkerOperation(workerPool,token,'claim',{})).job,null);
      chat=(await status()).chats[0];await action({action:'resume',chatId:chat.id,expectedVersion:chat.version});
      inFlight=(await telegramExtractionWorkerOperation(workerPool,token,'claim',{})).job;
      psql(db,`update app.telegram_connections set generation=generation+1 where id='${context.connectionId}'`);
      await assert.rejects(telegramExtractionWorkerOperation(workerPool,token,'complete',payload(inFlight)),{code:'40001'});
      const rebound=(await telegramExtractionWorkerOperation(workerPool,token,'claim',{})).job;
      assert.notEqual(rebound.id,inFlight.id);
      psql(db,`update app.telegram_connections set generation=${context.generation} where id='${context.connectionId}'`);
      inFlight=(await telegramExtractionWorkerOperation(workerPool,token,'claim',{})).job;
      await telegramExtractionWorkerOperation(workerPool,token,'fail',{jobId:inFlight.id,leaseToken:inFlight.leaseToken,code:'INVALID_RESULT',retryAfterSeconds:1});
      assert.equal((await telegramExtractionWorkerOperation(workerPool,token,'claim',{})).job,null,'Failed refresh remains explicit and bounded');
      await telegramExtractionAction(pool,owner,org,{action:'retry',jobId:inFlight.id});
      inFlight=(await telegramExtractionWorkerOperation(workerPool,token,'claim',{})).job;
      await telegramExtractionWorkerOperation(workerPool,token,'complete',payload(inFlight));
      await edit('Source requested for disposal');
      const origin=psql(db,`select origin_job_id from app.telegram_extraction_sources where chat_id='${chat.id}' and message_id=104`).trim();
      psql(db,`update app.telegram_extraction_jobs set source_release_requested_at=now() where id='${origin}'`);
      for(let i=0;i<5;i++){const unrelated=(await telegramExtractionWorkerOperation(workerPool,token,'claim',{})).job;if(!unrelated)break;assert.ok(!unrelated.source.messages.some(m=>m.messageId==='104'||m.messageId==='105'),'Pending release excludes its source from refresh');await telegramExtractionWorkerOperation(workerPool,token,'complete',payload(unrelated));}
      assert.equal(psql(db,`select count(*) from app.telegram_history_messages where chat_id='${chat.id}' and message_id=104`).trim(),'1');
      psql(db,`update app.telegram_drafts set status='discarded',fields='{}',document=null,reviewed_at=now() where id in(select id from app.telegram_retention_drafts_v1('${origin}'))`);
      const purged=JSON.parse(psql(db,`select app.telegram_retention_purge_v1('${origin}')`).trim());
      assert.equal(purged.purged,true,'Original source release disposes reassigned refresh rows');
      assert.equal(psql(db,`select count(*) from app.telegram_history_messages where chat_id='${chat.id}' and message_id in(104,105)`).trim(),'0');
      assert.equal(psql(db,`select count(*) from app.telegram_extraction_sources where chat_id='${chat.id}' and message_id=104`).trim(),'1');
      const afterPurge=(await telegramExtractionWorkerOperation(workerPool,token,'claim',{})).job;
      assert.ok(afterPurge===null || !afterPurge.source.messages.some(m=>m.messageId==='104'||m.messageId==='105'),'Purged source never refreshed or resurrected');
      if(afterPurge)await telegramExtractionWorkerOperation(workerPool,token,'complete',payload(afterPurge));
      assert.equal(psql(db,`select stored_bytes=(select sum(stored_bytes) from app.telegram_history_messages) from app.telegram_history_limits`).trim(),'t');

    });
    chat = (await status()).chats[0]; await action({ action: 'pause', chatId: chat.id, expectedVersion: chat.version });
    const beforeDisconnect = historyReads;
    await t.test('disconnect prevents stale runtime from making additional Telegram reads', async () => {
        await telegramConnectionAction(pool, owner, org, { action: 'disconnect', connectionId: lease.id, generation: lease.generation });
        await runtime.tick(context).catch(error => assert.ok(error.code === '40001' || /HOST_UNAVAILABLE|STALE/.test(error.message)));
        assert.equal(historyReads, beforeDisconnect);
        assert.equal((await status()).totals.messages, 208, 'Disconnect retains private imported history');
    });
    await t.test('same-account reconnect resumes automatic sync; a different account cannot claim it', async () => {
        let connection = await connector('claim');
        await connector('update', { connectionId: connection.id, generation: connection.generation, leaseToken: connection.leaseToken, status: 'disconnected' });
        await telegramConnectionAction(pool, owner, org, { action: 'connect', workerId: registered.id });
        connection = await connector('claim');
        await connector('update', { connectionId: connection.id, generation: connection.generation, leaseToken: connection.leaseToken, status: 'connected', profile: { telegramUserId: accountUserId, username: 'synthetic_owner', displayName: 'Synthetic Owner' } });
        Object.assign(context, { generation: connection.generation, connectionLeaseToken: connection.leaseToken, connectionLeaseExpiresAt: connection.leaseExpiresAt });
        due(); runtime = createHistoryWorker({ host, vault: createVault(vaultConfig), now });
        assert.equal((await runtime.tick(context)).status, 'idle', 'Reconnect must preserve an explicit pause');
        chat = (await status()).chats[0]; await action({ action: 'resume', chatId: chat.id, expectedVersion: chat.version });
        clock += 5001;
        incoming.push(message('314', 'Recovered after reconnect')); await runtime.tick(context); await runtime.tick(context);
        assert.equal(savedCheckpoint(), '314');
        await telegramConnectionAction(pool, owner, org, { action: 'disconnect', connectionId: connection.id, generation: connection.generation });
        connection = await connector('claim'); await connector('update', { connectionId: connection.id, generation: connection.generation, leaseToken: connection.leaseToken, status: 'disconnected' });
        await telegramConnectionAction(pool, owner, org, { action: 'connect', workerId: registered.id });
        connection = await connector('claim');
        await connector('update', { connectionId: connection.id, generation: connection.generation, leaseToken: connection.leaseToken, status: 'connected', profile: { telegramUserId: accountUserId, username: 'synthetic_owner', displayName: 'Synthetic Owner' } });
        Object.assign(context, { generation: connection.generation, connectionLeaseToken: connection.leaseToken, connectionLeaseExpiresAt: connection.leaseExpiresAt });
        due(); runtime = createHistoryWorker({ host, vault: createVault(vaultConfig), now });
        incoming.push(message('315', 'Recovered automatically after reconnect')); await runtime.tick(context); await runtime.tick(context);
        assert.equal(savedCheckpoint(), '315', 'Automatic sync rebinds without requiring a manual Resume');
        await telegramConnectionAction(pool, owner, org, { action: 'disconnect', connectionId: connection.id, generation: connection.generation });
        connection = await connector('claim'); await connector('update', { connectionId: connection.id, generation: connection.generation, leaseToken: connection.leaseToken, status: 'disconnected' });
        await telegramConnectionAction(pool, owner, org, { action: 'connect', workerId: registered.id });
        connection = await connector('claim');
        await connector('update', { connectionId: connection.id, generation: connection.generation, leaseToken: connection.leaseToken, status: 'connected', profile: { telegramUserId: '987654321', username: 'other_account', displayName: 'Other account' } });
        assert.equal((await host('claim', { connectionId: connection.id, generation: connection.generation, connectionLeaseToken: connection.leaseToken, accountUserId: '987654321' })).job, null);
        assert.equal((await status()).chats.length, 0);
        assert.equal(savedCheckpoint(), '315', 'Other account cannot change the original checkpoint');
        Object.assign(context, { generation: connection.generation, connectionLeaseToken: connection.leaseToken, connectionLeaseExpiresAt: connection.leaseExpiresAt, accountUserId: '987654321' });
        runtime = createHistoryWorker({ host, vault: createVault(vaultConfig), now });
        await action({ action: 'discover' });
        for (let i = 0; i < 6 && (await status()).discovery.status !== 'completed'; i++) await runtime.tick(context);
        const emptyChat = (await status()).chats[0];
        await action({ action: 'select', chatId: emptyChat.id, expectedVersion: emptyChat.version, selected: true });
        telegram.history = async ({ cursor }) => cursor.afterMessageId == null || cursor.beforeMessageId != null
            ? { records: [], nextCursor: cursor, done: true }
            : { records: [message('1', 'First message in previously empty chat')], nextCursor: { ...cursor, beforeMessageId: '1', upperMessageId: '1' }, done: false };
        await runtime.tick(context); await runtime.tick(context); await runtime.tick(context);
        assert.equal((await status()).chats[0].sync.checkpoint, '1', 'Empty histories start sync from zero');
        assert.equal(savedCheckpoint(), '315', 'Sync for another account leaves the original cursor unchanged');

    });
});
