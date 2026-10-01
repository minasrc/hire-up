import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, webcrypto } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium, expect as baseExpect } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { POSTGRES_17_IMAGE, assertLocalTestEnvironment, findFreePort, psql, publishedPort, startPostgresContainer, stopAndRemoveContainer } from '../support/foundation-docker.js';
import { AUTHZ_ID, installStaffFixture } from '../support/staff-authorization.js';
import { clientJobFixtureSql } from '../support/client-job-workflows.js';
import { STAFF_MFA_COOKIE, createStaffMfaProof } from '../../src/lib/staff-mfa-cookie.js';

const expect = baseExpect.configure({ timeout: 15000 });
const root = resolve(process.env.TELEGRAM_RETENTION_TEST_ROOT || fileURLToPath(new URL('../../', import.meta.url)));

async function waitForServer(url) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) }).catch(() => null);
        if (response?.ok) return;
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Temporary Telegram connection server did not start');
}

test('Automatic extraction pauses and resumes; source release remains an explicit reversible choice until cleanup', { timeout: 240_000 }, async t => {
    assertLocalTestEnvironment();
    const db = await startPostgresContainer('pgtelegramextractui', POSTGRES_17_IMAGE, { publish: true });
    t.after(() => stopAndRemoveContainer(db));
    const migrationsDir = join(root, 'supabase/migrations');
    const migrations = readdirSync(migrationsDir).filter(name => name >= '20260922090000_foundation_roles.sql' && name.endsWith('.sql')).sort();
    assert.ok(migrations.some(name => name.includes('telegram_extraction')), 'Extraction migration is required');
    for (const name of migrations) psql(db, readFileSync(join(migrationsDir, name), 'utf8'));
    const runtimePassword = installStaffFixture(db);
    const workerPassword = randomUUID();
    psql(db, clientJobFixtureSql);
    psql(db, `create role telegram_connector_ui_test login noinherit nosuperuser nocreatedb nocreaterole nobypassrls password '${workerPassword}';
        grant app_telegram_worker to telegram_connector_ui_test;`);
    const secret = 'synthetic-telegram-connection-test-secret';
    const totpId = randomUUID();
    psql(db, `insert into app.totp_credentials (id, organization_id, user_id, secret, status, verified_at)
        values ('${totpId}', '${AUTHZ_ID.ORG_B}', '${AUTHZ_ID.USER_ADMIN2}', 'JBSWY3DPEHPK3PXP', 'active', now());`);
    const files = new Map();
    const storageKey = 'synthetic-storage-service-key';
    const storage = createServer(async (request, response) => {
        const requestUrl = new URL(request.url, 'http://localhost');
        const prefix = '/storage/v1/object/';
        const signed = requestUrl.pathname.startsWith(`${prefix}sign/cv-submissions/`);
        const key = decodeURIComponent(requestUrl.pathname.slice((signed ? `${prefix}sign/cv-submissions/` : `${prefix}cv-submissions/`).length));
        const json = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
        if (signed && request.method === 'GET' && requestUrl.searchParams.get('token') === 'synthetic') {
            const file = files.get(key);
            if (!file) { json(404, { error: 'missing synthetic object' }); return; }
            response.writeHead(200, { 'content-type': 'application/pdf' }); response.end(file); return;
        }
        if (request.headers.authorization !== `Bearer ${storageKey}`) { json(403, { error: 'synthetic credentials required' }); return; }
        try {
            const chunks = []; let length = 0;
            for await (const chunk of request) {
                length += chunk.length;
                if (length > 4 * 1024 * 1024 + 65536) { json(413, { error: 'too large' }); return; }
                chunks.push(chunk);
            }
            if (signed && request.method === 'POST' && files.has(key)) {
                json(200, { signedURL: `/object/sign/cv-submissions/${key}?token=synthetic` });
            } else if (request.method === 'POST' && requestUrl.pathname.startsWith(`${prefix}cv-submissions/`)) {
                files.set(key, Buffer.concat(chunks)); json(200, { Key: `cv-submissions/${key}` });
            } else if (request.method === 'DELETE' && requestUrl.pathname === `${prefix}cv-submissions`) {
                const { prefixes = [] } = JSON.parse(Buffer.concat(chunks).toString());
                for (const item of prefixes) files.delete(item);
                json(200, prefixes.map(name => ({ name })));
            } else json(404, { error: 'unsupported synthetic storage request' });
        } catch { json(500, { error: 'synthetic storage failed' }); }
    });
    await new Promise((resolve, reject) => { storage.once('error', reject); storage.listen(0, '127.0.0.1', resolve); });
    t.after(() => { storage.closeAllConnections(); storage.close(); });
    const storageURL = `http://127.0.0.1:${storage.address().port}`;
    const port = await findFreePort();
    const baseURL = `http://127.0.0.1:${port}`;
    const output = [];
    const server = spawn(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '-p', String(port), '-H', '127.0.0.1'], {
        cwd: root,
        env: {
            PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development',
            NEXT_TELEMETRY_DISABLED: '1', NODE_OPTIONS: `--require ${join(root, 'tests/staff-workspace/google-token-preload.cjs')}`,
            STAFF_DATABASE_URL: `postgresql://agora_authz_test:${runtimePassword}@127.0.0.1:${publishedPort(db, 5432)}/postgres`,
            TELEGRAM_WORKER_DATABASE_URL: `postgresql://telegram_connector_ui_test:${workerPassword}@127.0.0.1:${publishedPort(db, 5432)}/postgres`,
            STAFF_ORGANIZATION_ID: AUTHZ_ID.ORG_B, NEXTAUTH_URL: baseURL, NEXTAUTH_SECRET: secret,
            GOOGLE_CLIENT_ID: 'synthetic-workspace-client', GOOGLE_CLIENT_SECRET: 'synthetic-workspace-client-secret',
            TELEGRAM_INTAKE_ENABLED: '1', NEXT_PUBLIC_SUPABASE_URL: storageURL, SUPABASE_SERVICE_ROLE_KEY: storageKey, GITHUB_ID: '', GITHUB_SECRET: '',
        }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', chunk => output.push(String(chunk)));
    server.stderr.on('data', chunk => output.push(String(chunk)));
    t.after(async () => {
        if (server.exitCode !== null) return;
        server.kill('SIGTERM');
        await new Promise(resolve => {
            const timer = setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 10_000);
            server.once('exit', () => { clearTimeout(timer); resolve(); });
        });
    });
    await waitForServer(`${baseURL}/staff/sign-in`);
    const token = await encode({ token: {
        name: 'Admin Two', email: 'admin-two@synthetic.test', sub: '1002', provider: 'google',
        providerAccountId: '1002', googleRefreshToken: 'SYNTHETIC-WORKSPACE-TEST', emailVerified: true,
        iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
    }, secret });
    const proof = createStaffMfaProof(secret, { subject: '1002', userId: AUTHZ_ID.USER_ADMIN2, credentialId: totpId });
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const context = await browser.newContext();
    await context.addCookies([
        { name: 'next-auth.session-token', value: token, url: baseURL },
        { name: STAFF_MFA_COOKIE, value: proof, url: baseURL },
    ]);
    const registration = await context.request.post(`${baseURL}/api/staff/telegram-intake/workers`, { data: { name: 'Synthetic Mac' } });
    assert.equal(registration.status(), 201, await registration.text());
    const registered = (await registration.json()).result;
    const keys = await webcrypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
    const publicKeySpki = Buffer.from(await webcrypto.subtle.exportKey('spki', keys.publicKey)).toString('base64');
    const worker = async (action, data = {}) => {
        const response = await fetch(`${baseURL}/api/telegram-connection/worker/${action}`, {
            method: 'POST', headers: { authorization: `Bearer ${registered.token}`, 'content-type': 'application/json' }, body: JSON.stringify(data),
        });
        assert.equal(response.status, 200, await response.clone().text());
        return response.json();
    };
    await worker('heartbeat', { publicKeySpki });
    let accountUserId = '123456789';
    const staffURL = `${baseURL}/api/staff/telegram-history`;
    const connectionURL = `${baseURL}/api/staff/telegram-connection`;
    async function connectAccount() {
        const response = await context.request.post(connectionURL, { data: { action: 'connect', workerId: registered.id } });
        assert.equal(response.status(), 200, await response.text());
        const task = (await worker('claim')).connection;
        await worker('update', { connectionId: task.id, generation: task.generation, leaseToken: task.leaseToken, status: 'connected', profile: { telegramUserId: accountUserId, username: 'synthetic_recruiter', displayName: 'Synthetic Recruiter' } });
    }
    async function disconnectAccount() {
        const current = (await (await context.request.get(connectionURL)).json()).connection;
        const response = await context.request.post(connectionURL, { data: { action: 'disconnect', connectionId: current.id, generation: current.generation } });
        assert.equal(response.status(), 200, await response.text());
        const task = (await worker('claim')).connection;
        await worker('update', { connectionId: task.id, generation: task.generation, leaseToken: task.leaseToken, status: 'disconnected' });
    }
    const historyWorker = async (action, data = {}) => {
        const connection = (await worker('claim')).connection;
        const response = await fetch(`${baseURL}/api/telegram-history/worker/${action}`, {
            method: 'POST', headers: { authorization: `Bearer ${registered.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ connectionId: connection.id, generation: connection.generation, connectionLeaseToken: connection.leaseToken, accountUserId, ...data }),
        });
        assert.equal(response.status, 200, await response.clone().text());
        return response.json();
    };
    const completePage = (job, records, nextCursor = job.cursor, done = false) => historyWorker('complete', {
        jobId: job.id, jobLeaseToken: job.leaseToken, pageId: randomUUID(), fromCursor: job.cursor, nextCursor, done, records,
    });
    const getChats = async query => {
        const response = await context.request.get(`${staffURL}${query || ''}`);
        assert.equal(response.status(), 200, await response.text());
        return response.json();
    };
    await connectAccount();
    const extractionURL = `${baseURL}/api/staff/telegram-extraction`;
    const extractWorker = async (action, data = {}) => {
        const response = await fetch(`${baseURL}/api/telegram-extraction/worker/${action}`, {
            method: 'POST', headers: { authorization: `Bearer ${registered.token}`, 'content-type': 'application/json' }, body: JSON.stringify(data),
        });
        assert.equal(response.status, 200, await response.clone().text());
        return response.json();
    };
    const discovery = await context.request.post(staffURL, { data: { action: 'discover' } });
    assert.equal(discovery.status(), 200, await discovery.text());
    let dialogPages = 0;
    while ((await getChats()).discovery.status !== 'completed') {
        const job = (await historyWorker('claim')).job;
        if (job.cursor.folder === 0 && job.cursor.offsetId === '0') {
            await completePage(job, [{ peer: { kind: 'user', id: '777' }, title: 'Synthetic candidate conversation', username: 'ada_demo', lastMessageAt: null }], { folder: 0, offsetDate: 1700000000, offsetId: '160', offsetPeer: { kind: 'user', id: '777' }, excludePinned: true });
        } else await completePage(job, [], job.cursor, true);
        assert.ok(++dialogPages < 6);
    }
    const chat = (await getChats()).chats[0];
    const select = await context.request.post(staffURL, { data: { action: 'select', chatId: chat.id, expectedVersion: chat.version, selected: true } });
    assert.equal(select.status(), 200, await select.text());
    const records = Array.from({ length: 160 }, (_, index) => {
        const id = 160 - index;
        const city = id <= 80 ? 'London' : id <= 120 ? 'Berlin' : 'Rome';
        const salary = id <= 80 ? '100000' : id <= 120 ? '120000' : '140000';
        return { messageId: String(id), kind: 'message', sentAt: new Date(Date.UTC(2025, 0, 1, 0, 0, id)).toISOString(), editedAt: null,
            sender: { peer: { kind: 'user', id: '777' }, username: 'ada_demo', displayName: 'Ada Lovelace' }, replyToMessageId: null, forwardedFrom: null,
            text: id <= 40 ? 'General recruiting discussion without a candidate profile.' : `I am Ada Lovelace. My email is ada-extraction@example.test. I live in ${city} and want EUR ${salary}. My role is Protocol engineer.`,
            attachments: id % 40 === 1 ? [{ id: String(10000 + id), kind: 'document', filename: 'Ada-shared-resume.pdf', mimeType: 'application/pdf', sizeBytes: 1234 }] : [],
        };
    });
    let historyJob = (await historyWorker('claim')).job;
    await completePage(historyJob, records.slice(0, 100), { beforeMessageId: '61', upperMessageId: '160' });
    historyJob = (await historyWorker('claim')).job;
    await completePage(historyJob, records.slice(100), { beforeMessageId: '1', upperMessageId: '160' });
    historyJob = (await historyWorker('claim')).job;
    await completePage(historyJob, [], historyJob.cursor, true);
    await disconnectAccount();

    const completeExtraction = (job) => extractWorker('complete', { jobId: job.id, leaseToken: job.leaseToken, sourceDigest: job.sourceDigest, result: { subjects: [] }, metadata: { model: 'synthetic-model', promptVersion: job.promptVersion, reportedModel: null } });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    async function action(button, kind) {
        const response = page.waitForResponse(response => response.url() === extractionURL && response.request().method() === 'POST' && response.request().postDataJSON()?.action === kind);
        await button.click(); assert.equal((await response).status(), 200);
    }
    async function refresh() {
        await page.getByRole('button', { name: 'Refresh progress', exact: true }).click();
        await expect(page.getByText('Loading extraction progress…', { exact: true })).toHaveCount(0);
    }
    try {
        await page.goto(`${baseURL}/staff/telegram-intake/chats`);
        const row = page.getByRole('row').filter({ hasText: 'Synthetic candidate conversation' });
        await expect(row).toBeVisible();
        mkdirSync(join(root, 'test-results'), { recursive: true });
        await page.screenshot({ path: join(root, 'test-results/staff-workspace-telegram-retention-chats.png'), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: join(root, 'test-results/staff-workspace-telegram-retention-chats-mobile.png'), fullPage: true });
        await page.setViewportSize({ width: 1280, height: 900 });
        await action(row.getByRole('button', { name: 'Start automatic extraction', exact: true }), 'setExtraction');
        await expect(row.getByText(/Automatic extraction/).first()).toBeVisible();
        const leased = (await extractWorker('claim')).job;
        await action(row.getByRole('button', { name: 'Pause automatic extraction', exact: true }), 'setExtraction');
        await expect(row.getByText('Automatic extraction off', { exact: true })).toBeVisible();
        const completed = await completeExtraction(leased);
        assert.equal(completed.nextQueued, false);
        assert.equal((await extractWorker('claim')).job, null, 'Paused extraction cannot claim the remaining imported history');
        await page.getByRole('link', { name: 'Extraction progress', exact: true }).click();
        await expect(page.getByText('Context kept', { exact: true })).toBeVisible();
        await expect(page.getByText(/The model suggested no candidates/)).toBeVisible();
        await page.getByRole('button', { name: 'Review source messages', exact: true }).click();
        const source = page.getByRole('region', { name: 'Private batch source', exact: true });
        await expect(source.getByText(/I am Ada Lovelace/).first()).toBeVisible();
        const release = source.getByRole('button', { name: 'Release after candidate review', exact: true });
        await expect(release).toBeDisabled();
        mkdirSync(join(root, 'test-results'), { recursive: true });
        await release.scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(root, 'test-results/staff-workspace-telegram-retention-controls.png') });
        await page.setViewportSize({ width: 390, height: 844 });
        await release.scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(root, 'test-results/staff-workspace-telegram-retention-controls-mobile.png') });
        await page.setViewportSize({ width: 1280, height: 900 });
        await source.getByRole('checkbox').check();
        await action(release, 'sourceRetention');
        await expect(page.getByText('Release requested', { exact: true })).toBeVisible();
        await action(source.getByRole('button', { name: 'Keep context', exact: true }), 'sourceRetention');
        await expect(page.getByText('Context kept', { exact: true })).toBeVisible();
        psql(db, 'set role app_telegram_maintenance; select app.telegram_maintenance_v1(10);');
        assert.equal(psql(db, 'select count(*) from app.telegram_history_messages').trim(), '160', 'Withdrawing release retains all sources');
        await source.getByRole('checkbox').check();
        await action(source.getByRole('button', { name: 'Release after candidate review', exact: true }), 'sourceRetention');
        psql(db, 'set role app_telegram_maintenance; select app.telegram_maintenance_v1(10);');
        await refresh();
        await expect(page.getByText('Source messages deleted', { exact: true })).toBeVisible();
        await expect(page.getByText(/Review the whole batch before/)).toHaveCount(0);
        await expect(page.getByRole('region', { name: 'Private batch source', exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Review source messages', exact: true })).toHaveCount(0);
        const deleted = await (await context.request.get(`${extractionURL}?jobId=${leased.id}`)).json();
        assert.equal(deleted.source, null); assert.equal(deleted.sourceRetention.state, 'purged');
        assert.equal(psql(db, 'select count(*) from app.telegram_history_messages').trim(), '120');
        await page.goto(`${baseURL}/staff/telegram-intake/chats`);
        await action(row.getByRole('button', { name: 'Start automatic extraction', exact: true }), 'setExtraction');
        let remaining = 0;
        for (;;) { const job = (await extractWorker('claim')).job; if (!job) break; await completeExtraction(job); assert.ok(++remaining <= 3); }
        assert.equal(remaining, 3, 'Re-enable resumes every unprocessed batch without resurrecting deleted messages');
        await page.getByRole('link', { name: 'Extraction progress', exact: true }).click();
        await expect(page.getByText('Context kept', { exact: true })).toHaveCount(3);
        await expect(page.getByText('Source messages deleted', { exact: true })).toHaveCount(1);
        assert.equal(psql(db, 'select count(*) from app.telegram_history_messages').trim(), '120', 'Zero-result batches are kept without an explicit release');
        mkdirSync(join(root, 'test-results'), { recursive: true });
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: join(root, 'test-results/staff-workspace-telegram-retention.png'), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: join(root, 'test-results/staff-workspace-telegram-retention-mobile.png'), fullPage: true });
        assert.deepEqual(errors, []);
    } catch (error) { console.error(output.join('').slice(-14000)); throw error; }
});
