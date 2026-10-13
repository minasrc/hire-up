import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
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
import { hostedWakeCursor } from '../../src/lib/telegram-hosted-wake.js';
import { createWakeClient } from '../../services/telegram-hosted/wake.mjs';

const expect = baseExpect.configure({ timeout: 15000 });
const root = resolve(process.env.TELEGRAM_HOSTED_TEST_ROOT || fileURLToPath(new URL('../../', import.meta.url)));

async function waitForServer(url) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) }).catch(() => null);
        if (response?.ok) return;
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Temporary Telegram connection server did not start');
}

test('Hosted Telegram browser starts on demand, cancels setup and protects QR/password/logout', { timeout: 240_000 }, async t => {
    assertLocalTestEnvironment();
    const db = await startPostgresContainer('pgtelegramhostedui', POSTGRES_17_IMAGE, { publish: true });
    t.after(() => stopAndRemoveContainer(db));
    const migrationsDir = join(root, 'supabase/migrations');
    const migrations = readdirSync(migrationsDir).filter(name => name >= '20260922090000_foundation_roles.sql' && name.endsWith('.sql')).sort();
    assert.ok(migrations.some(name => name.includes('telegram_connection')), 'Connection migration is required');
    for (const name of migrations) psql(db, readFileSync(join(migrationsDir, name), 'utf8'));
    const runtimePassword = installStaffFixture(db);
    const workerPassword = randomUUID();
    const serviceId = randomUUID();
    const serviceSecret = 's'.repeat(64);
    const instanceId = randomUUID();
    psql(db, clientJobFixtureSql);
    psql(db, `create role telegram_connector_ui_test login noinherit nosuperuser nocreatedb nocreaterole nobypassrls password '${workerPassword}';
        grant app_telegram_worker, app_telegram_hosted_service to telegram_connector_ui_test;`);
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
            TELEGRAM_INTAKE_ENABLED: '1', TELEGRAM_HOSTED_ENABLED: '1',
            TELEGRAM_HOSTED_SERVICE_ID: serviceId, TELEGRAM_HOSTED_SERVICE_SECRET: serviceSecret,
            TELEGRAM_HOSTED_DATABASE_URL: `postgresql://telegram_connector_ui_test:${workerPassword}@127.0.0.1:${publishedPort(db, 5432)}/postgres`, GITHUB_ID: '', GITHUB_SECRET: '',
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
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await context.addCookies([
        { name: 'next-auth.session-token', value: token, url: baseURL },
        { name: STAFF_MFA_COOKIE, value: proof, url: baseURL },
    ]);
    let leaseToken;
    const control = async (action, data = {}) => {
        const response = await fetch(`${baseURL}/api/telegram-hosted/control`, {
            method: 'POST', headers: { authorization: `Bearer ${serviceSecret}`, 'content-type': 'application/json' },
            body: JSON.stringify({ action, instanceId, ...(leaseToken ? { leaseToken } : {}), ...data }),
        });
        assert.equal(response.status, 200, await response.clone().text());
        return response.json();
    };
    const keys = await webcrypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
    const publicKeySpki = Buffer.from(await webcrypto.subtle.exportKey('spki', keys.publicKey)).toString('base64');
    const workerId = randomUUID();
    const workerToken = 'w'.repeat(64);
    const worker = async (action, data = {}) => {
        const response = await fetch(`${baseURL}/api/telegram-connection/worker/${action}`, {
            method: 'POST', headers: { authorization: `Bearer ${workerToken}`, 'content-type': 'application/json' }, body: JSON.stringify(data),
        });
        assert.equal(response.status, 200, await response.clone().text());
        return response.json();
    };
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const connectionURL = `${baseURL}/api/staff/telegram-connection`;
    const hostedURL = `${baseURL}/api/staff/telegram-hosted`;
    let prepares = 0;
    let starts = 0;
    page.on('request', request => {
        if (request.method() !== 'POST') return;
        if (request.url() === hostedURL && request.postDataJSON()?.action === 'prepare') prepares += 1;
        if (request.url() === connectionURL && request.postDataJSON()?.action === 'connect') starts += 1;
    });
    const noLocalSetup = async () => {
        await expect(page.getByLabel('Mac connector', { exact: true })).toHaveCount(0);
        await expect(page.getByText('Your Mac connector', { exact: true })).toHaveCount(0);
        await expect(page.getByRole('heading', { name: /Pair.*Mac|Telegram API credentials/i })).toHaveCount(0);
        assert.equal(/\bMac\b|API hash|API ID|worker token/.test(await page.locator('body').innerText()), false);
    };
    try {
        const wakeURL = `${baseURL}/api/telegram-hosted/wake`;
        assert.equal((await fetch(wakeURL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
        assert.equal((await fetch(wakeURL, { method: 'POST', headers: { authorization: `Bearer ${serviceSecret}`, origin: baseURL, 'content-type': 'application/json' }, body: '{}' })).status, 401);
        assert.equal((await fetch(wakeURL, { method: 'POST', headers: { authorization: `Bearer ${serviceSecret}`, 'content-type': 'application/json' }, body: JSON.stringify({ instanceId, leaseToken: randomUUID(), cursor: 'a'.repeat(64), ownerUserId: AUTHZ_ID.USER_ADMIN2 }) })).status, 400);
        await page.goto(`${baseURL}/staff/telegram-intake/connect`);
        await expect(page).toHaveURL(`${baseURL}/staff/telegram-intake/chats#telegram-connection`);
        await expect(page.getByRole('heading', { name: 'Telegram', exact: true })).toBeVisible();
        await expect(page.getByText('The Telegram service is temporarily offline or unavailable. Your imported history remains available.', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Connect Telegram', exact: true })).toBeDisabled();
        await noLocalSetup();
        assert.equal(prepares, 0, 'Page load must not provision a worker');
        assert.equal(starts, 0);
        await expect(page.getByRole('link', { name: 'Search imported conversations', exact: true })).toHaveCount(0);
        await expect(page.getByRole('link', { name: 'Search conversations', exact: true })).toHaveCount(1);
        await expect(page.getByRole('link', { name: 'Search conversations', exact: true })).toHaveAttribute('href', '/staff/telegram-intake/context');
        leaseToken = (await control('heartbeat')).leaseToken;
        const heartbeatTimer = setInterval(() => void control('heartbeat').catch(() => {}), 20000);
        t.after(() => clearInterval(heartbeatTimer));
        await page.getByRole('button', { name: 'Check service status', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Connect Telegram', exact: true })).toBeEnabled();
        await expect(page.getByRole('button', { name: 'Check service status', exact: true })).toHaveCount(0);
        const wakeSnapshot = await control('sync');
        const wakeAbort = new AbortController();
        const pendingWake = createWakeClient({ server: baseURL, serviceToken: serviceSecret })({ instanceId, leaseToken, cursor: hostedWakeCursor(wakeSnapshot.requests) }, wakeAbort.signal);
        pendingWake.catch(() => {});
        await page.getByRole('button', { name: 'Connect Telegram', exact: true }).click();
        const actions = page.getByRole('group', { name: 'Telegram connection actions', exact: true });
        await expect(actions.getByRole('button', { name: 'Preparing sign-in…', exact: true })).toBeDisabled();
        await expect(actions.getByRole('button', { name: 'Cancel sign-in', exact: true })).toBeVisible();
        const wakeReceipt = await pendingWake;
        assert.equal(wakeReceipt.changed, true, 'The authenticated HTTP notification channel observes the browser action');
        assert.deepEqual(Object.keys(wakeReceipt).sort(), ['changed', 'cursor', 'protocolVersion']);
        wakeAbort.abort();
        for (const width of [390, 320]) {
            await page.setViewportSize({ width, height: 844 });
            await expect.poll(() => actions.evaluate(group => {
                const buttons = [...group.querySelectorAll('button')];
                return buttons[0].getBoundingClientRect().top - buttons[1].getBoundingClientRect().top;
            }), { message: `Preparing and cancel must share one action row at ${width}px` }).toBe(0);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Mobile action labels must not overflow');
        }
        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
        await expect(page.getByText('Setup cancelled. Click Connect Telegram when you are ready.', { exact: true })).toBeVisible();
        assert.equal(prepares, 1, 'Strict mode must not duplicate provisioning');
        assert.equal(starts, 0, 'Cancellation must not start a Telegram connection');
        const requests = (await control('list')).requests;
        assert.equal(requests.length, 1);
        await control('register', { requestId: requests[0].requestId, workerId, tokenSha256: createHash('sha256').update(workerToken).digest('hex') });
        await worker('heartbeat', { publicKeySpki });
        await expect(page.getByText('Setup cancelled. Click Connect Telegram when you are ready.', { exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Check service status', exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Connect Telegram', exact: true })).toBeEnabled();
        assert.equal(starts, 0, 'A ready status after cancellation cannot restart sign-in');
        await page.getByRole('button', { name: 'Connect Telegram', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Preparing Telegram sign-in', exact: true })).toBeVisible();
        assert.equal(starts, 1);
        await expect(page.getByRole('button', { name: 'Preparing sign-in…', exact: true })).toBeDisabled();
        const preparingBounds = await page.getByRole('heading', { name: 'Preparing Telegram sign-in', exact: true }).boundingBox();
        assert.ok(preparingBounds && preparingBounds.y >= 0 && preparingBounds.y + preparingBounds.height < await page.evaluate(() => window.innerHeight), 'An explicit connect brings sign-in progress into view');
        assert.equal(prepares, 2);
        let task = (await worker('claim')).connection;
        const update = data => worker('update', { connectionId: task.id, generation: task.generation, leaseToken: task.leaseToken, challengeId: task.challengeId, ...data });
        await update({ status: 'qr_pending', qrLoginUrl: 'tg://login?token=synthetic_hosted_token', qrExpiresAt: new Date(Date.now() + 90000).toISOString() });
        const qr = page.getByRole('img', { name: 'Telegram sign-in QR code', exact: true });
        await expect(qr).toBeVisible();
        await expect.poll(async () => {
            const bounds = await qr.boundingBox();
            return bounds && bounds.y >= 0 && bounds.y + bounds.height <= await page.evaluate(() => window.innerHeight);
        }, { message: 'The QR code is brought into view when ready' }).toBe(true);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2), 'Mobile sign-in must not overflow horizontally');
        mkdirSync(join(root, 'test-results'), { recursive: true });
        await page.screenshot({ path: join(root, 'test-results/staff-workspace-telegram-signin-mobile.png'), fullPage: true });
        assert.equal(starts, 1, 'One click must reach QR sign-in without opening recovery or starting again');
        await expect(page.getByRole('button', { name: 'Preparing sign-in…', exact: true })).toHaveCount(0);
        await expect(actions.getByRole('button', { name: 'Sign-in in progress', exact: true })).toBeDisabled();
        await expect(actions.getByRole('button', { name: 'Cancel sign-in', exact: true })).toBeEnabled();
        await expect(page.getByRole('button', { name: 'Check service status', exact: true })).toHaveCount(0);
        const actionBounds = await actions.boundingBox();
        const qrBounds = await qr.boundingBox();
        assert.ok(actionBounds.y >= qrBounds.y + qrBounds.height, 'Sign-in actions belong together below the QR code');
        const recovery = page.getByText('Advanced recovery options', { exact: true });
        assert.ok((await qr.boundingBox()).y < (await recovery.boundingBox()).y, 'Recovery belongs below the QR sign-in');
        await recovery.click();
        await expect(page.getByRole('checkbox', { name: /I revoked the old session/ })).toBeVisible();
        assert.ok((await qr.boundingBox()).y < (await recovery.boundingBox()).y, 'Even expanded recovery cannot precede sign-in');
        await recovery.click();
        assert.equal(starts, 1, 'Expanding recovery must never start a connection');
        await update({ status: 'failed', errorCode: 'LOGIN_EXPIRED' });
        await expect(page.getByText('This sign-in attempt expired. Start a new connection.', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Retry sign-in', exact: true })).toBeEnabled();
        await expect(page.getByRole('button', { name: 'Connect again', exact: true })).toHaveCount(0);
        const beforeRetry = page.url();
        await expect(page.getByRole('button', { name: 'Retry sign-in', exact: true })).toHaveCount(1);
        await expect(page.getByRole('link', { name: 'Retry sign-in', exact: true })).toHaveCount(0);
        await page.getByRole('button', { name: 'Retry sign-in', exact: true }).click();
        assert.equal(page.url(), beforeRetry, 'Retry starts sign-in directly without navigation');
        await expect(page.getByRole('heading', { name: 'Preparing Telegram sign-in', exact: true })).toBeVisible();
        assert.equal(starts, 2, 'Only an explicit retry starts the replacement attempt');
        task = (await worker('claim')).connection;
        await update({ status: 'qr_pending', qrLoginUrl: 'tg://login?token=synthetic_hosted_retry', qrExpiresAt: new Date(Date.now() + 90000).toISOString() });
        await expect(qr).toBeVisible();
        await noLocalSetup();
        await update({ status: 'awaiting_password', passwordHint: 'Synthetic hint' });
        const password = page.getByLabel('Telegram two-step verification password', { exact: true });
        await expect(password).toBeVisible();
        await expect(actions.getByRole('button', { name: 'Continue securely', exact: true })).toBeDisabled();
        await expect(actions.getByRole('button', { name: 'Cancel sign-in', exact: true })).toBeEnabled();
        assert.ok((await actions.boundingBox()).y > (await password.boundingBox()).y, 'Password actions belong together below the password field');
        assert.equal((await actions.getByRole('button', { name: 'Continue securely', exact: true }).boundingBox()).y,
            (await actions.getByRole('button', { name: 'Cancel sign-in', exact: true }).boundingBox()).y, 'Continue and cancel share one action row');
        await page.reload();
        await expect(page.getByRole('heading', { name: 'Complete Telegram two-step verification', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Discover chats', exact: true })).toBeDisabled();
        await expect(page.getByRole('link', { name: 'Continue sign-in', exact: true })).toHaveCount(0);
        await expect(page.getByRole('link', { name: 'Telegram connection', exact: true })).toHaveCount(0);
        await expect(password).toBeVisible();
        assert.equal(starts, 2, 'Continuing pending sign-in must reuse the existing connection');
        // Denial from the history endpoint clears both controllers. An explicit
        // retry must recover the same pending challenge, with no retained secret.
        await password.fill('synthetic discarded secret');
        const historyReadPattern = '**/api/staff/telegram-history?*';
        await page.route(historyReadPattern, route => route.fulfill({ status: 428, contentType: 'application/json', body: '{}' }));
        await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
        await expect(password).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Discover chats', exact: true })).toBeDisabled();
        await page.unroute(historyReadPattern);
        await page.getByRole('button', { name: 'Retry status', exact: true }).click();
        await expect(password).toBeVisible();
        await expect(password).toHaveValue('');
        assert.equal(starts, 2, 'Access recovery must not start a new Telegram connection');
        await password.fill('synthetic hosted secret');
        const submission = page.waitForResponse(response => response.url() === connectionURL && response.request().postDataJSON()?.action === 'password');
        await page.getByRole('button', { name: 'Continue securely', exact: true }).click();
        const submittedResponse = await submission;
        assert.equal(submittedResponse.status(), 200);
        const submitted = submittedResponse.request().postDataJSON();
        assert.deepEqual(Object.keys(submitted).sort(), ['action', 'challengeId', 'ciphertext', 'connectionId', 'generation']);
        assert.equal(JSON.stringify(submitted).includes('synthetic hosted secret'), false);
        const label = new TextEncoder().encode(`agora-telegram:${task.id}:${task.generation}:${task.challengeId}`);
        assert.equal(new TextDecoder().decode(await webcrypto.subtle.decrypt({ name: 'RSA-OAEP', label }, keys.privateKey, Buffer.from(submitted.ciphertext, 'base64'))), 'synthetic hosted secret');
        await expect(password).toHaveValue('');
        task = (await worker('claim')).connection;
        await update({ status: 'connected', profile: { telegramUserId: '123456789', username: 'synthetic_recruiter', displayName: 'Synthetic Recruiter' } });
        await expect(page.getByRole('heading', { name: 'Telegram connected', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Discover chats', exact: true })).toBeEnabled();
        await expect(page.getByRole('button', { name: 'Choose chats to import', exact: true })).toHaveCount(0);
        // Follow the real hosted browser journey through imported source context.
        const historyURL = `${baseURL}/api/staff/telegram-history`;
        const historyWorker = async (action, data = {}) => {
            const current = (await worker('claim')).connection;
            const response = await fetch(`${baseURL}/api/telegram-history/worker/${action}`, {
                method: 'POST', headers: { authorization: `Bearer ${workerToken}`, 'content-type': 'application/json' },
                body: JSON.stringify({ connectionId: current.id, generation: current.generation, connectionLeaseToken: current.leaseToken, accountUserId: '123456789', ...data }),
            });
            assert.equal(response.status, 200, await response.clone().text()); return response.json();
        };
        const completePage = (job, records, nextCursor = job.cursor, done = false) => historyWorker('complete', { jobId: job.id, jobLeaseToken: job.leaseToken, pageId: randomUUID(), fromCursor: job.cursor, nextCursor, done, records });
        const historyAction = async locator => { const response = page.waitForResponse(response => response.url() === historyURL && response.request().method() === 'POST'); await locator.click(); assert.equal((await response).status(), 200); };
        const beforeChooseChats = page.url();
        await historyAction(page.getByRole('button', { name: 'Discover chats', exact: true }));
        assert.equal(page.url(), beforeChooseChats, 'Discovering chats stays on the sign-in page');
        let dialogPageSent = false;
        for (let pages = 0; pages < 4; pages += 1) {
            const job = (await historyWorker('claim')).job;
            if (!job) break;
            assert.equal(job.kind, 'dialogs');
            if (job.cursor.folder === 0 && !dialogPageSent) {
                await completePage(job, [{ peer: { kind: 'user', id: '9001' }, title: 'Hosted journey chat', username: null, lastMessageAt: null }], { folder: 0, offsetDate: 1700000000, offsetId: '1', offsetPeer: { kind: 'user', id: '9001' }, excludePinned: true });
                dialogPageSent = true;
            } else await completePage(job, [], job.cursor, true);
        }
        await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
        await expect(page.getByText('Hosted journey chat', { exact: true })).toBeVisible();
        await historyAction(page.getByRole('button', { name: 'Import full history', exact: true }));
        let historyJob = (await historyWorker('claim')).job;
        await completePage(historyJob, [{ messageId: '1', kind: 'message', sentAt: '2025-01-01T00:00:00Z', editedAt: null, sender: null, text: 'Synthetic hosted Solidity history', attachments: [] }], { beforeMessageId: '1', upperMessageId: '1' });
        historyJob = (await historyWorker('claim')).job;
        await completePage(historyJob, [], historyJob.cursor, true);
        await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
        await page.getByText('Import progress details', { exact: true }).click();
        await expect(page.getByText(/Last progress:/)).toBeVisible();
        await expect(page.getByText(/History reached:/)).toBeVisible();
        await page.getByRole('link', { name: 'View conversation', exact: true }).click();
        await expect(page.getByRole('dialog')).toContainText('Synthetic hosted Solidity history');
        await page.getByRole('button', { name: 'Close', exact: true }).click();
        await page.getByLabel('Message words or phrase', { exact: true }).fill('Solidity');
        await page.getByRole('button', { name: 'Search messages', exact: true }).click();
        await expect(page.getByRole('button', { name: 'View conversation', exact: true })).toHaveCount(1);
        await page.getByRole('link', { name: 'Telegram chats', exact: true }).click();
        await historyAction(page.getByRole('button', { name: 'Pause sync', exact: true }));
        await expect(page.getByText('Sync paused', { exact: true })).toBeVisible();
        await historyAction(page.getByRole('button', { name: 'Resume sync', exact: true }));
        await page.getByRole('button', { name: 'Disconnect Telegram', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Waiting for Telegram to disconnect', exact: true })).toBeVisible();
        await expect(page.getByText(/To revoke access immediately, open Telegram on your phone/)).toBeVisible();
        task = (await worker('claim')).connection;
        await update({ status: 'disconnecting', errorCode: 'LOGOUT_FAILED' });
        await expect(page.getByText(/Telegram has not confirmed logout/)).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Telegram disconnected', exact: true })).toHaveCount(0);
        await noLocalSetup();
        await update({ status: 'disconnected' });
        await expect(page.getByRole('heading', { name: 'Telegram disconnected', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Connect Telegram', exact: true })).toBeEnabled();
        assert.equal(starts, 2, 'Logout acknowledgment must not trigger automatic sign-in');
        await page.getByRole('link', { name: 'Search conversations', exact: true }).click();
        await page.getByLabel('Message words or phrase', { exact: true }).fill('Solidity');
        await page.getByRole('button', { name: 'Search messages', exact: true }).click();
        await expect(page.getByRole('button', { name: 'View conversation', exact: true })).toHaveCount(1);
        await page.getByRole('link', { name: 'Telegram chats', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Connect Telegram', exact: true })).toBeEnabled();
        await page.getByRole('button', { name: 'Connect Telegram', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Preparing Telegram sign-in', exact: true })).toBeVisible();
        task = (await worker('claim')).connection;
        await update({ status: 'connected', profile: { telegramUserId: '123456789', username: 'synthetic_recruiter', displayName: 'Synthetic Recruiter' } });
        await expect(page.getByRole('heading', { name: 'Telegram connected', exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Choose chats to import', exact: true }).click();
        await expect(page.getByText('Hosted journey chat', { exact: true })).toBeVisible();
        await expect(page.getByRole('link', { name: 'View conversation', exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Disconnect Telegram', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Waiting for Telegram to disconnect', exact: true })).toBeVisible();
        task = (await worker('claim')).connection;
        await update({ status: 'disconnected' });
        await expect(page.getByRole('heading', { name: 'Telegram disconnected', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Check service status', exact: true })).toHaveCount(0);
        await page.getByText('Advanced recovery options', {exact:true}).click();
        await expect(page.getByRole('button', {name:'Reset registration',exact:true})).toBeEnabled();
        const retired=page.waitForResponse(response=>response.url()===hostedURL&&response.request().postDataJSON()?.action==='retire');
        await page.getByRole('button', {name:'Reset registration',exact:true}).click();
        assert.equal((await retired).status(),200);
        await expect(page.getByText('Registration reset. Imported history is preserved. Click Connect Telegram to create a new connection.', {exact:true})).toBeVisible();
        assert.equal(starts,3,'Retirement cannot start a replacement automatically');
        const retiredClaim=await fetch(`${baseURL}/api/telegram-connection/worker/claim`,{method:'POST',headers:{authorization:`Bearer ${workerToken}`,'content-type':'application/json'},body:'{}'});
        assert.equal(retiredClaim.status,403,'Retired worker credentials are immediately refused');

        // The existing physical-worker account must never be silently moved.
        const registration = await context.request.post(`${baseURL}/api/staff/telegram-intake/workers`, { data: { name: 'Synthetic existing device' } });
        assert.equal(registration.status(), 201);
        const physical = (await registration.json()).result;
        const beat = await fetch(`${baseURL}/api/telegram-connection/worker/heartbeat`, { method: 'POST', headers: { authorization: `Bearer ${physical.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ publicKeySpki }) });
        assert.equal(beat.status, 200);
        const physicalStart = await context.request.post(connectionURL, { data: { action: 'connect', workerId: physical.id } });
        assert.equal(physicalStart.status(), 200, await physicalStart.text());
        await page.reload();
        await expect(page.getByText('This account has an existing connection. Disconnect it below and wait for logout confirmation before starting a hosted connection.', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Connect Telegram', exact: true })).toHaveCount(0);
        await page.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Connection cancelled', exact: true })).toBeVisible();
        assert.equal(prepares, 4, 'Reconnect reuses the existing registration; physical-worker setup cannot provision another hosted worker');
        await noLocalSetup();
        // A revoked enrollment needs explicit Telegram-side confirmation.
        const newPrepare=await context.request.post(hostedURL,{data:{action:'prepare'}});assert.equal(newPrepare.status(),200);
        const freshRequest=(await control('list')).requests[0],lostWorker=randomUUID(),lostToken='l'.repeat(64);
        await control('register',{requestId:freshRequest.requestId,workerId:lostWorker,tokenSha256:createHash('sha256').update(lostToken).digest('hex')});
        const lostCall=async(action,data={})=>{
            const response=await fetch(`${baseURL}/api/telegram-connection/worker/${action}`,{method:'POST',headers:{authorization:`Bearer ${lostToken}`,'content-type':'application/json'},body:JSON.stringify(data)});
            assert.equal(response.status,200,await response.clone().text());return response.json();
        };
        await lostCall('heartbeat',{publicKeySpki});
        assert.equal((await context.request.post(connectionURL,{data:{action:'connect',workerId:lostWorker}})).status(),200);
        const lostTask=(await lostCall('claim')).connection;
        await lostCall('update',{connectionId:lostTask.id,generation:lostTask.generation,leaseToken:lostTask.leaseToken,status:'connected',profile:{telegramUserId:'123456789',displayName:'Synthetic recovered owner'}});
        psql(db,`update app.telegram_workers set revoked_at=clock_timestamp() where id='${lostWorker}'`);
        await page.reload();
        await page.getByText('Advanced recovery options',{exact:true}).click();
        const resetButton=page.getByRole('button',{name:'Reset registration',exact:true});await expect(resetButton).toBeDisabled();
        await page.getByRole('checkbox',{name:'I revoked the old session, or verified it is absent, in Telegram Settings → Devices.',exact:true}).check();
        await expect(resetButton).toBeEnabled();
        const externalReset=page.waitForResponse(response=>response.url()===hostedURL&&response.request().postDataJSON()?.action==='retire');
        await resetButton.click();assert.equal((await externalReset).status(),200);
        await expect(page.getByText('Registration reset after your confirmation of revocation in Telegram. Imported history is preserved. Click Connect Telegram to create a new connection.',{exact:true})).toBeVisible();
        await expect(page.getByText('You confirmed the old session was revoked in Telegram Settings → Devices. The service registration has been retired; imported history remains available.',{exact:true})).toBeVisible();
        // Losing access removes challenge/password state and prevents provisioning.
        await page.evaluate(() => window.dispatchEvent(new Event('staff-session-invalidated')));
        await expect(page.getByRole('button', { name: 'Connect Telegram', exact: true })).toHaveCount(0);
        await expect(page.getByRole('img', { name: 'Telegram sign-in QR code', exact: true })).toHaveCount(0);
        await expect(password).toHaveCount(0);
        await expect(page.getByText('Hosted journey chat', { exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Discover chats', exact: true })).toBeDisabled();
        assert.deepEqual(pageErrors, []);
        mkdirSync(join(root, 'test-results'), { recursive: true });
        await page.screenshot({ path: join(root, 'test-results/staff-workspace-telegram-hosted.png'), fullPage: true });
    } catch (error) {
        console.error(output.join('').slice(-12000));
        throw error;
    }
});
