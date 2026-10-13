import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import { POSTGRES_17_IMAGE, assertLocalTestEnvironment, psql, startPostgresContainer, stopAndRemoveContainer } from '../support/foundation-docker.js';
import { AUTHZ_ID, installStaffFixture, staffPoolOptions } from '../support/staff-authorization.js';
import { CJ_ID, CJ_SUBJECTS, clientJobFixtureSql } from '../support/client-job-workflows.js';
import { withStaffTransaction } from '../../src/lib/staff-authorization.js';
import { telegramConnectionAction, telegramConnectorOperation } from '../../src/lib/telegram-connection-operations.js';
import { telegramHistoryAction, telegramHistoryStatus, telegramHistoryWorkerOperation } from '../../src/lib/telegram-history-operations.js';

const directory = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
const owner = { provider: 'google', issuer: 'https://accounts.google.com', subject: CJ_SUBJECTS.ADMIN };
const other = { ...owner, subject: CJ_SUBJECTS.RECRUITER };
const org = AUTHZ_ID.ORG_B;
const message = (id, sentAt) => ({ messageId: String(id), kind: 'message', sentAt, editedAt: null,
    sender: null, replyToMessageId: null, forwardedFrom: null, text: 'Synthetic history progress', attachments: [] });

test('import progress reflects accepted pages, preserves replay timestamps and stays owner private', { timeout: 120000 }, async t => {
    assertLocalTestEnvironment();
    const db = await startPostgresContainer('pgtelegramprogress', POSTGRES_17_IMAGE, { publish: true });
    let pool; let workerPool;
    t.after(async () => { await Promise.all([pool?.end(), workerPool?.end()]); await stopAndRemoveContainer(db); });
    for (const name of readdirSync(directory).filter(name => name.endsWith('.sql')
        && name >= '20260922090000_foundation_roles.sql' && name <= '20261013100000_telegram_import_progress.sql').sort()) {
        psql(db, readFileSync(join(directory, name), 'utf8'));
    }
    const password = installStaffFixture(db); psql(db, clientJobFixtureSql);
    psql(db, `insert into app.role_permissions(organization_id,role_id,permission_key) values('${org}','${CJ_ID.ROLE_B_RECRUITER}','candidates.write');`);
    pool = new pg.Pool(staffPoolOptions(db, password, 3));
    const workerPassword = randomUUID();
    psql(db, `create role progress_test login noinherit nosuperuser nocreatedb nocreaterole nobypassrls password '${workerPassword}'; grant app_telegram_worker to progress_test;`);
    workerPool = new pg.Pool({ ...staffPoolOptions(db, workerPassword, 2), user: 'progress_test' });
    const token = randomBytes(48).toString('base64url');
    const registered = await withStaffTransaction(pool, owner, org, ['candidates.read', 'candidates.write'], async ({ client }) =>
        (await client.query('select app.telegram_register_worker_v1($1,$2) result', ['Synthetic progress worker', token])).rows[0].result);
    const connector = (action, body = {}) => telegramConnectorOperation(workerPool, token, action, body);
    const publicKeySpki = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    await connector('heartbeat', { publicKeySpki });
    await telegramConnectionAction(pool, owner, org, { action: 'connect', workerId: registered.id });
    const lease = await connector('claim');
    await connector('update', { connectionId: lease.id, generation: lease.generation, leaseToken: lease.leaseToken,
        status: 'connected', profile: { telegramUserId: '12345678', username: null, displayName: 'Synthetic Owner' } });
    const proof = { connectionId: lease.id, generation: lease.generation, connectionLeaseToken: lease.leaseToken, accountUserId: '12345678' };
    const call = (action, body = {}) => telegramHistoryWorkerOperation(workerPool, token, action, { ...proof, ...body });
    const action = body => telegramHistoryAction(pool, owner, org, body);
    const status = (who = owner) => telegramHistoryStatus(pool, who, org);
    const page = (job, records, nextCursor = job.cursor) => ({ jobId: job.id, jobLeaseToken: job.leaseToken,
        pageId: randomUUID(), fromCursor: job.cursor, nextCursor, done: records.length === 0, records });
    await action({ action: 'discover' });
    const dialog = (await call('claim')).job;
    const record = { peer: { kind: 'user', id: '87654321' }, title: 'Synthetic progress chat', username: null, lastMessageAt: null };
    await call('complete', page(dialog, [record], { ...dialog.cursor, offsetDate: 1, offsetId: '1', offsetPeer: record.peer, excludePinned: true }));
    for (let i = 0; i < 2; i++) { const job = (await call('claim')).job; await call('complete', page(job, [])); }
    let chat = (await status()).chats[0];
    assert.equal(chat.historyCompleted, false);
    assert.equal(chat.progress.lastProgressAt, null);
    await action({ action: 'select', chatId: chat.id, expectedVersion: chat.version, selected: true });
    const first = (await call('claim')).job;
    const submitted = page(first, [message(100, '2026-10-01T12:00:00.000Z'), message(90, '2026-09-01T12:00:00.000Z')], { beforeMessageId: '90', upperMessageId: '100' });
    await call('complete', submitted);
    chat = (await status()).chats[0];
    const progressedAt = chat.progress.lastProgressAt;
    assert.ok(Number.isFinite(Date.parse(progressedAt)));
    assert.equal(Date.parse(chat.progress.oldestImportedAt), Date.parse('2026-09-01T12:00:00.000Z'));
    assert.equal(Date.parse(chat.progress.newestImportedAt), Date.parse('2026-10-01T12:00:00.000Z'));
    await call('claim');
    assert.equal((await status()).chats[0].progress.lastProgressAt, progressedAt, 'claiming is not progress');
    assert.equal((await call('complete', submitted)).replayed, true);
    assert.equal((await status()).chats[0].progress.lastProgressAt, progressedAt, 'replay is not a new page');
    const final = (await call('claim')).job;
    await call('complete', page(final, []));
    chat = (await status()).chats[0];
    assert.equal(chat.historyCompleted, true);
    assert.equal(chat.sync.enabled, true);
    assert.equal((await status(other)).chats.length, 0);
});
