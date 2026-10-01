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
const root = resolve(process.env.TELEGRAM_CONNECTION_TEST_ROOT || fileURLToPath(new URL('../../', import.meta.url)));

async function waitForServer(url) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) }).catch(() => null);
        if (response?.ok) return;
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Temporary Telegram connection server did not start');
}

test('Telegram browser connects with QR and encrypted 2FA, waits for logout acknowledgment', { timeout: 240_000 }, async t => {
    assertLocalTestEnvironment();
    const db = await startPostgresContainer('pgtelegramconnectui', POSTGRES_17_IMAGE, { publish: true });
    t.after(() => stopAndRemoveContainer(db));
    const migrationsDir = join(root, 'supabase/migrations');
    const migrations = readdirSync(migrationsDir).filter(name => name >= '20260922090000_foundation_roles.sql' && name.endsWith('.sql')).sort();
    assert.ok(migrations.some(name => name.includes('telegram_connection')), 'Connection migration is required');
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
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const connectionURL = `${baseURL}/api/staff/telegram-connection`;
    try {
        await page.goto(`${baseURL}/staff/telegram-intake`);
        await page.getByRole('link', { name: 'Connect Telegram', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Connect Telegram', exact: true })).toBeVisible();
        await expect(page.getByLabel('Mac connector', { exact: true })).toContainText('Synthetic Mac — Online');
        psql(db, `update app.telegram_connector_workers set last_seen_at=now()-interval '5 minutes' where id='${registered.id}'`);
        await page.reload();
        await expect(page.getByLabel('Mac connector', { exact: true })).toContainText('Synthetic Mac — Offline');
        await expect(page.getByRole('button', { name: 'Connect Telegram', exact: true })).toBeDisabled();
        await worker('heartbeat', { publicKeySpki });
        await page.reload();
        await expect(page.getByRole('button', { name: 'Connect Telegram', exact: true })).toBeEnabled();
        await page.getByRole('button', { name: 'Connect Telegram', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Preparing Telegram sign-in' })).toBeVisible();
        let hiddenReads = 0;
        const countReads = request => { if (request.url() === connectionURL && request.method() === 'GET') hiddenReads += 1; };
        await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
        page.on('request', countReads);
        await page.waitForTimeout(2500);
        assert.equal(hiddenReads, 0, 'Hidden pages must not poll');
        page.off('request', countReads);
        await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
        let task = (await worker('claim')).connection;
        const update = data => worker('update', { connectionId: task.id, generation: task.generation, leaseToken: task.leaseToken, challengeId: task.challengeId, ...data });
        await update({ status: 'qr_pending', qrLoginUrl: 'tg://login?token=synthetic_first_token', qrExpiresAt: new Date(Date.now() + 8000).toISOString() });
        await expect(page.getByRole('img', { name: 'Telegram sign-in QR code' })).toBeVisible();
        await expect(page.getByText('This code expired. Waiting for a fresh code from your Mac…')).toBeVisible();
        await expect(page.getByRole('img', { name: 'Telegram sign-in QR code' })).toHaveCount(0);
        await update({ status: 'qr_pending', qrLoginUrl: 'tg://login?token=synthetic_refreshed_token', qrExpiresAt: new Date(Date.now() + 90_000).toISOString() });
        await expect(page.getByRole('img', { name: 'Telegram sign-in QR code' })).toBeVisible();
        await update({ status: 'awaiting_password', passwordHint: 'Synthetic hint' });
        const password = page.getByLabel('Telegram two-step verification password', { exact: true });
        await expect(password).toBeVisible();
        await password.fill('synthetic browser secret 🔒');
        const submission = page.waitForRequest(request => request.url() === connectionURL && request.method() === 'POST' && request.postDataJSON()?.action === 'password');
        await page.getByRole('button', { name: 'Continue securely' }).click();
        const submitted = (await submission).postDataJSON();
        assert.deepEqual(Object.keys(submitted).sort(), ['action', 'challengeId', 'ciphertext', 'connectionId', 'generation']);
        assert.equal(JSON.stringify(submitted).includes('synthetic browser secret'), false);
        assert.equal(Buffer.from(submitted.ciphertext, 'base64').length, 256);
        await expect(password).toHaveValue('');
        const label = new TextEncoder().encode(`agora-telegram:${task.id}:${task.generation}:${task.challengeId}`);
        assert.equal(new TextDecoder().decode(await webcrypto.subtle.decrypt({ name: 'RSA-OAEP', label }, keys.privateKey, Buffer.from(submitted.ciphertext, 'base64'))), 'synthetic browser secret 🔒');
        await expect(page.getByRole('button', { name: 'Checking password…' })).toBeDisabled();
        task = (await worker('claim')).connection;
        assert.equal(task.passwordCiphertext, submitted.ciphertext);
        await update({ status: 'awaiting_password', errorCode: 'PASSWORD_INVALID', passwordHint: 'Synthetic hint', passwordSubmissionId: task.passwordSubmissionId });
        await expect(page.getByText('That Telegram password was not accepted. Try again.')).toBeVisible();
        await expect(password).toBeEnabled();
        await password.fill('synthetic corrected secret');
        const retry = page.waitForResponse(response => response.url() === connectionURL && response.request().postDataJSON()?.action === 'password');
        await page.getByRole('button', { name: 'Continue securely' }).click();
        assert.equal((await retry).status(), 200);
        await update({ status: 'connected', profile: { telegramUserId: '123456789', username: 'synthetic_recruiter', displayName: 'Synthetic Recruiter' } });
        await expect(page.getByRole('heading', { name: 'Telegram connected', exact: true })).toBeVisible();
        await expect(page.getByText('@synthetic_recruiter', { exact: true })).toBeVisible();
        await expect(page.getByText(/Chat selection and history import are not available yet/)).toBeVisible();
        await page.getByRole('button', { name: 'Disconnect Telegram', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Waiting for Telegram to disconnect' })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Telegram disconnected', exact: true })).toHaveCount(0);
        task = (await worker('claim')).connection;
        await update({ status: 'disconnecting', errorCode: 'LOGOUT_FAILED' });
        await expect(page.getByText(/Telegram has not confirmed logout/)).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Telegram disconnected', exact: true })).toHaveCount(0);
        await update({ status: 'disconnected' });
        await expect(page.getByRole('heading', { name: 'Telegram disconnected', exact: true })).toBeVisible();
        assert.deepEqual(pageErrors, []);
        mkdirSync(join(root, 'test-results'), { recursive: true });
        await page.screenshot({ path: join(root, 'test-results/staff-workspace-telegram-connection.png'), fullPage: true });
    } catch (error) {
        // Neither passwords nor ciphertexts are logged by the synthetic server.
        console.error(output.join('').slice(-12_000));
        throw error;
    }
});
