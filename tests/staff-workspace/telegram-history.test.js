import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, webcrypto } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium, expect as baseExpect } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { POSTGRES_17_IMAGE, assertLocalTestEnvironment, findFreePort, psql, publishedPort, startPostgresContainer, stopAndRemoveContainer } from '../support/foundation-docker.js';
import { AUTHZ_ID, installStaffFixture } from '../support/staff-authorization.js';
import { clientJobFixtureSql } from '../support/client-job-workflows.js';
import { STAFF_MFA_COOKIE, createStaffMfaProof } from '../../src/lib/staff-mfa-cookie.js';

const expect = baseExpect.configure({ timeout: 15000 });
const root = resolve(process.env.TELEGRAM_HISTORY_TEST_ROOT || fileURLToPath(new URL('../../', import.meta.url)));

async function waitForServer(url) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) }).catch(() => null);
        if (response?.ok) return;
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Temporary Telegram connection server did not start');
}

test('Telegram history UI discovers, selects and resumes private full-history imports', { timeout: 240_000 }, async t => {
    assertLocalTestEnvironment();
    const db = await startPostgresContainer('pgtelegramhistoryui', POSTGRES_17_IMAGE, { publish: true });
    t.after(() => stopAndRemoveContainer(db));
    const migrationsDir = join(root, 'supabase/migrations');
    const migrations = readdirSync(migrationsDir).filter(name => name >= '20260922090000_foundation_roles.sql' && name.endsWith('.sql')).sort();
    assert.ok(migrations.some(name => name.includes('telegram_history')), 'History migration is required');
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
            TELEGRAM_INTAKE_ENABLED: '1', GITHUB_ID: '', GITHUB_SECRET: '',
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
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    async function refresh() {
        const response = page.waitForResponse(response => response.url().startsWith(staffURL) && response.request().method() === 'GET');
        await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
        assert.equal((await response).status(), 200);
        await expect(page.getByText('Loading chats…', { exact: true })).toHaveCount(0);
    }
    async function clickAction(locator, status = 200) {
        const response = page.waitForResponse(response => response.url() === staffURL && response.request().method() === 'POST');
        await locator.click();
        const result = await response;
        assert.equal(result.status(), status);
        await expect(page.getByText('Loading chats…', { exact: true })).toHaveCount(0);
        return result.request().postDataJSON();
    }
    try {
        await page.goto(`${baseURL}/staff/telegram-intake`);
        await page.getByRole('link', { name: 'Telegram chats', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Telegram chats', exact: true })).toBeVisible();
        await clickAction(page.getByRole('button', { name: 'Discover chats', exact: true }));
        await expect(page.getByText(/Discovering chats in the background/)).toBeVisible();
        const dialogs = Array.from({ length: 55 }, (_, index) => ({
            peer: { kind: 'user', id: String(1000 + index) }, title: `Synthetic chat ${String(index + 1).padStart(2, '0')}`, username: null, lastMessageAt: null,
        }));
        let pages = 0;
        while ((await getChats()).discovery.status !== 'completed') {
            const job = (await historyWorker('claim')).job;
            assert.equal(job.kind, 'dialogs');
            if (job.cursor.folder === 0 && job.cursor.offsetId === '0') {
                await completePage(job, dialogs, { folder: 0, offsetDate: 1700000000, offsetId: '55', offsetPeer: dialogs.at(-1).peer, excludePinned: true });
            } else await completePage(job, [], job.cursor, true);
            assert.ok(++pages < 6, 'Discovery should complete in bounded pages');
        }
        await refresh();
        await expect(page.getByText(/55 chats found · 0 selected/)).toBeVisible();
        await expect(page.locator('tbody tr')).toHaveCount(50);
        await page.getByRole('button', { name: 'Next', exact: true }).click();
        await expect(page.locator('tbody tr')).toHaveCount(5);
        await page.getByRole('button', { name: 'Previous', exact: true }).click();
        await expect(page.locator('tbody tr')).toHaveCount(50);
        await page.getByLabel('Mark all chats on this page', { exact: true }).check();
        const selected = await clickAction(page.getByRole('button', { name: 'Import marked chats', exact: true }));
        assert.equal(selected.action, 'selectMany');
        assert.equal(selected.chats.length, 50);
        assert.equal((await getChats()).totals.selected, 50);
        await page.getByLabel('Mark all chats on this page', { exact: true }).check();
        await clickAction(page.getByRole('button', { name: 'Cancel marked imports', exact: true }));
        assert.equal((await getChats()).totals.selected, 0);

        await page.getByLabel('Search chats', { exact: true }).fill('Synthetic chat 01');
        await page.getByRole('button', { name: 'Search', exact: true }).click();
        await expect(page.locator('tbody tr')).toHaveCount(1);
        await clickAction(page.getByRole('button', { name: /^(Import full history|Resume import)$/ }));
        await refresh();
        const chat = (await getChats('?q=Synthetic%20chat%2001')).chats[0];
        const externalPause = await context.request.post(staffURL, { data: { action: 'pause', chatId: chat.id, expectedVersion: chat.version } });
        assert.equal(externalPause.status(), 200, await externalPause.text());
        await clickAction(page.getByRole('button', { name: 'Pause', exact: true }), 409);
        await expect(page.getByRole('alert').filter({ hasText: 'These chats changed.' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Resume import', exact: true })).toBeVisible();
        await clickAction(page.getByRole('button', { name: 'Resume import', exact: true }));
        let job = (await historyWorker('claim')).job;
        assert.equal(job.kind, 'history');
        assert.equal(job.peer.id, '1000');
        assert.deepEqual(job.cursor, { beforeMessageId: null, upperMessageId: null });
        const records = [
            { messageId: '3', kind: 'message', sentAt: '2025-01-01T00:00:03Z', editedAt: null, sender: null, text: 'Private message sentinel', attachments: [] },
            { messageId: '2', kind: 'message', sentAt: '2025-01-01T00:00:02Z', editedAt: null, sender: null, text: '', attachments: [{ id: '222', kind: 'document', filename: 'Synthetic-CV.pdf', mimeType: 'application/pdf', sizeBytes: 1234 }] },
            { messageId: '1', kind: 'service', sentAt: '2025-01-01T00:00:01Z', editedAt: null, sender: null, text: '', attachments: [] },
        ];
        psql(db, `update app.telegram_history_limits set max_messages=2 where organization_id='${AUTHZ_ID.ORG_B}' and owner_user_id='${AUTHZ_ID.USER_ADMIN2}'`);
        assert.equal((await completePage(job, records, { beforeMessageId: '1', upperMessageId: '3' })).status, 'capacity_paused');
        await refresh();
        await expect(page.getByText('Capacity reached', { exact: true })).toBeVisible();
        await expect(page.getByText('0 messages stored', { exact: true })).toBeVisible();
        psql(db, `update app.telegram_history_limits set max_messages=200000 where organization_id='${AUTHZ_ID.ORG_B}' and owner_user_id='${AUTHZ_ID.USER_ADMIN2}'`);
        await clickAction(page.getByRole('button', { name: 'Resume import', exact: true }));
        job = (await historyWorker('claim')).job;
        assert.deepEqual(job.cursor, { beforeMessageId: null, upperMessageId: null });
        await completePage(job, records, { beforeMessageId: '1', upperMessageId: '3' });
        await refresh();
        await expect(page.getByText('3 messages stored', { exact: true })).toBeVisible();
        await expect(page.getByText('Private message sentinel', { exact: true })).toHaveCount(0);
        await clickAction(page.getByRole('button', { name: 'Pause', exact: true }));
        await expect(page.getByText('Paused', { exact: true })).toBeVisible();
        await clickAction(page.getByRole('button', { name: 'Resume import', exact: true }));
        job = (await historyWorker('claim')).job;
        assert.deepEqual(job.cursor, { beforeMessageId: '1', upperMessageId: '3' });
        await historyWorker('defer', { jobId: job.id, jobLeaseToken: job.leaseToken, code: 'FLOOD_WAIT', retryAfterSeconds: 1 });
        await refresh();
        await expect(page.getByText(/Telegram requested a wait/)).toBeVisible();
        await clickAction(page.getByRole('button', { name: 'Cancel import', exact: true }));
        await expect(page.getByText('3 messages stored', { exact: true })).toBeVisible();
        await clickAction(page.getByRole('button', { name: 'Resume import', exact: true }));
        await new Promise(resolve => setTimeout(resolve, 1200));
        job = (await historyWorker('claim')).job;
        assert.deepEqual(job.cursor, { beforeMessageId: '1', upperMessageId: '3' });
        await completePage(job, [], job.cursor, true);
        await refresh();
        await expect(page.getByText('History imported', { exact: true })).toBeVisible();
        await expect(page.getByText(/CV files are not downloaded or validated/)).toBeVisible();

        mkdirSync(join(root, 'test-results'), { recursive: true });
        await page.screenshot({ path: join(root, 'test-results/staff-workspace-telegram-history-imported.png'), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2), 'Mobile page must not overflow horizontally');
        await page.screenshot({ path: join(root, 'test-results/staff-workspace-telegram-history-mobile.png'), fullPage: true });
        await page.setViewportSize({ width: 1280, height: 720 });

        await disconnectAccount();
        await refresh();
        await expect(page.getByRole('heading', { name: 'Connect Telegram to import chats' })).toBeVisible();
        await expect(page.getByText('3 messages stored', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Deselect chat', exact: true })).toBeDisabled();
        accountUserId = '987654321';
        await connectAccount();
        await refresh();
        await expect(page.getByText('3 messages stored', { exact: true })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Private storage across your accounts' })).toBeVisible();
        await expect(page.locator('tbody tr')).toHaveCount(0);
        await expect(page.getByText('Synthetic chat 01', { exact: true })).toHaveCount(0);
        assert.deepEqual(pageErrors, []);
        mkdirSync(join(root, 'test-results'), { recursive: true });
        await page.screenshot({ path: join(root, 'test-results/staff-workspace-telegram-history.png'), fullPage: true });
    } catch (error) {
        console.error(output.join('').slice(-12_000));
        throw error;
    }
});
