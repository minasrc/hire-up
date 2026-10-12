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
    const context = await browser.newContext();
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
        if (request.url() === hostedURL) prepares += 1;
        if (request.url() === connectionURL && request.postDataJSON()?.action === 'connect') starts += 1;
    });
    const noLocalSetup = async () => {
        await expect(page.getByLabel('Mac connector', { exact: true })).toHaveCount(0);
        await expect(page.getByText('Your Mac connector', { exact: true })).toHaveCount(0);
        await expect(page.getByRole('heading', { name: /Pair.*Mac|Telegram API credentials/i })).toHaveCount(0);
        assert.equal(/\bMac\b|API hash|API ID|worker token/.test(await page.locator('body').innerText()), false);
    };
    try {
        await page.goto(`${baseURL}/staff/telegram-intake/connect`);
        await expect(page.getByText('The Telegram service is temporarily offline or unavailable. Your imported history remains available.', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Connect Telegram', exact: true })).toBeDisabled();
        await noLocalSetup();
        assert.equal(prepares, 0, 'Page load must not provision a worker');
        assert.equal(starts, 0);
        await expect(page.getByRole('link', { name: 'Search imported conversations', exact: true })).toHaveAttribute('href', '/staff/telegram-intake/context');
        leaseToken = (await control('heartbeat')).leaseToken;
        const heartbeatTimer = setInterval(() => void control('heartbeat').catch(() => {}), 20000);
        t.after(() => clearInterval(heartbeatTimer));
        await page.getByRole('button', { name: 'Retry service status', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Connect Telegram', exact: true })).toBeEnabled();
        await page.getByRole('button', { name: 'Connect Telegram', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Cancel setup', exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Cancel setup', exact: true }).click();
        await expect(page.getByText('Setup cancelled. Click Connect Telegram when you are ready.', { exact: true })).toBeVisible();
        assert.equal(prepares, 1, 'Strict mode must not duplicate provisioning');
        assert.equal(starts, 0, 'Cancellation must not start a Telegram connection');
        const requests = (await control('list')).requests;
        assert.equal(requests.length, 1);
        await control('register', { requestId: requests[0].requestId, workerId, tokenSha256: createHash('sha256').update(workerToken).digest('hex') });
        await worker('heartbeat', { publicKeySpki });
        await page.getByRole('button', { name: 'Retry service status', exact: true }).click();
        await expect(page.getByText('Telegram service available.', { exact: true })).toBeVisible();
        assert.equal(starts, 0, 'A ready status after cancellation cannot restart sign-in');
        await page.getByRole('button', { name: 'Connect Telegram', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Preparing Telegram sign-in', exact: true })).toBeVisible();
        assert.equal(starts, 1);
        assert.equal(prepares, 2);
        let task = (await worker('claim')).connection;
        const update = data => worker('update', { connectionId: task.id, generation: task.generation, leaseToken: task.leaseToken, challengeId: task.challengeId, ...data });
        await update({ status: 'qr_pending', qrLoginUrl: 'tg://login?token=synthetic_hosted_token', qrExpiresAt: new Date(Date.now() + 90000).toISOString() });
        await expect(page.getByRole('img', { name: 'Telegram sign-in QR code', exact: true })).toBeVisible();
        await noLocalSetup();
        await update({ status: 'awaiting_password', passwordHint: 'Synthetic hint' });
        const password = page.getByLabel('Telegram two-step verification password', { exact: true });
        await expect(password).toBeVisible();
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
        await expect(page.getByRole('link', { name: 'Choose chats to import', exact: true })).toHaveAttribute('href', '/staff/telegram-intake/chats');
        await page.getByRole('button', { name: 'Disconnect Telegram', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Waiting for Telegram to disconnect', exact: true })).toBeVisible();
        task = (await worker('claim')).connection;
        await update({ status: 'disconnecting', errorCode: 'LOGOUT_FAILED' });
        await expect(page.getByText(/Telegram has not confirmed logout/)).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Telegram disconnected', exact: true })).toHaveCount(0);
        await noLocalSetup();
        await update({ status: 'disconnected' });
        await expect(page.getByRole('heading', { name: 'Telegram disconnected', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Connect again', exact: true })).toBeEnabled();
        assert.equal(starts, 1, 'Logout acknowledgment must not trigger automatic sign-in');
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
        await expect(page.getByRole('button', { name: 'Connect again', exact: true })).toHaveCount(0);
        await page.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Connection cancelled', exact: true })).toBeVisible();
        assert.equal(prepares, 2);
        await noLocalSetup();
        // Losing access removes challenge/password state and prevents provisioning.
        await page.evaluate(() => window.dispatchEvent(new Event('staff-session-invalidated')));
        await expect(page.getByRole('button', { name: 'Connect Telegram', exact: true })).toBeDisabled();
        await expect(page.getByRole('img', { name: 'Telegram sign-in QR code', exact: true })).toHaveCount(0);
        await expect(password).toHaveCount(0);
        assert.deepEqual(pageErrors, []);
        mkdirSync(join(root, 'test-results'), { recursive: true });
        await page.screenshot({ path: join(root, 'test-results/staff-workspace-telegram-hosted.png'), fullPage: true });
    } catch (error) {
        console.error(output.join('').slice(-12000));
        throw error;
    }
});
