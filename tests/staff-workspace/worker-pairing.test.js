import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
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
const root = resolve(process.env.WORKER_PAIRING_TEST_ROOT || fileURLToPath(new URL('../../', import.meta.url)));

async function waitForServer(url) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) }).catch(() => null);
        if (response?.ok) return;
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Temporary Telegram connection server did not start');
}

test('Mac pairing confirms fingerprints, recovers refreshes and manages scoped device access', { timeout: 240_000 }, async t => {
    assertLocalTestEnvironment();
    const db = await startPostgresContainer('pgworkerpairui', POSTGRES_17_IMAGE, { publish: true });
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
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
    const requests = []; const pairings = new Map(); let denied = false; let inviteUncertain = true; let approveUncertain = true; let renewalConflict = true; let inviteTtl = 600000; let readsOffline = false;
    const nearExpiry = new Date(Date.now() + 86400000).toISOString();
    const device = { id: randomUUID(), name: 'Recruiter Mac', createdAt: new Date().toISOString(), expiresAt: nearExpiry, revokedAt: null, lastSeenAt: null, connectorLastSeenAt: null, compatibleSearchLastSeenAt: null };
    const laterDevice = { ...device, id: randomUUID(), name: 'Older Mac', expiresAt: new Date(Date.now() - 10 * 86400000).toISOString() };
    const organization = { id: AUTHZ_ID.ORG_B, name: 'Synthetic Recruiting' };
    await page.route('**/api/staff/telegram-connection', route => route.fulfill({ json: { workers: [], connection: null } }));
    await page.route('**/api/staff/worker-devices*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (denied) { await route.fulfill({ status: 403, json: { code: 'FORBIDDEN' } }); return; }
        if (request.method() === 'GET') {
            if (readsOffline) { await route.fulfill({ status: 503, json: { code: 'PAIRING_UNAVAILABLE' } }); return; }
            const id = url.searchParams.get('pairingId');
            if (id) { const pairing = pairings.get(id); await route.fulfill({ status: pairing ? 200 : 404, json: pairing ? { ...pairing, organization } : { code: 'PAIRING_UNAVAILABLE' } }); return; }
            await route.fulfill({ json: { organization, devices: url.searchParams.has('after') ? [laterDevice] : [device], nextAfter: url.searchParams.has('after') ? null : 'synthetic-next-cursor', pairings: [...pairings.values()].filter(item => ['invited', 'claimed'].includes(item.status)) } }); return;
        }
        const body = request.postDataJSON(); requests.push(body);
        if (body.action === 'invite') {
            let pairing = [...pairings.values()].find(item => item.operationId === body.operationId);
            if (!pairing) { pairing = { pairingId: randomUUID(), operationId: body.operationId, name: body.name, status: 'invited', deviceName: null, deviceFingerprint: null, expiresAt: new Date(Date.now() + inviteTtl).toISOString(), worker: null }; pairings.set(pairing.pairingId, pairing); }
            if (inviteUncertain) { inviteUncertain = false; await route.fulfill({ status: 503, json: { code: 'PAIRING_UNAVAILABLE' } }); return; }
            await route.fulfill({ status: 201, json: { pairingId: pairing.pairingId, name: pairing.name, status: pairing.status, expiresAt: pairing.expiresAt } }); return;
        }
        const pairing = pairings.get(body.pairingId);
        if (body.action === 'approve') {
            assert.equal(body.deviceFingerprint, pairing.deviceFingerprint);
            if (approveUncertain) { approveUncertain = false; await route.fulfill({ status: 503, json: { code: 'PAIRING_UNAVAILABLE' } }); return; }
            pairing.status = 'approved'; pairing.worker = { id: device.id, name: pairing.name, expiresAt: device.expiresAt };
            await route.fulfill({ json: { pairingId: pairing.pairingId, status: 'approved', worker: pairing.worker } }); return;
        }
        if (body.action === 'cancel') { pairing.status = 'cancelled'; await route.fulfill({ json: { pairingId: pairing.pairingId, status: 'cancelled' } }); return; }
        if (body.action === 'renew') {
            assert.equal(body.expectedExpiresAt, device.expiresAt);
            if (renewalConflict) { renewalConflict = false; device.expiresAt = new Date(Date.now() + 2 * 86400000).toISOString(); await route.fulfill({ status: 409, json: { code: 'WORKER_CHANGED' } }); return; }
            device.expiresAt = new Date(Date.now() + 30 * 86400000).toISOString(); await route.fulfill({ json: { worker: { id: device.id, name: device.name, expiresAt: device.expiresAt } } }); return;
        }
        await route.fulfill({ status: 400, json: { code: 'INVALID_INPUT' } });
    });
    await page.route('**/api/staff/telegram-intake/workers/*', async route => { assert.equal(route.request().method(), 'DELETE'); device.revokedAt = new Date().toISOString(); await route.fulfill({ json: { ok: true } }); });
    await page.goto(`${baseURL}/staff/telegram-intake/connect`, { waitUntil: 'networkidle' });
    // Card has an accessible label but may render as a div, so scope to its label.
    const pairingPanel = page.locator('[aria-label="Mac device pairing"]');
    const refresh = async () => { await pairingPanel.getByRole('button', { name: 'Refresh devices' }).click(); await expect(pairingPanel.getByText('Loading devices…')).toHaveCount(0); };
    await expect(pairingPanel.getByText('Synthetic Recruiting', { exact: true })).toBeVisible();
    await pairingPanel.getByRole('button', { name: 'Pair this Mac', exact: true }).click();
    await expect(pairingPanel.getByRole('button', { name: 'Retry invitation', exact: true })).toBeVisible();
    await pairingPanel.getByRole('button', { name: 'Retry invitation', exact: true }).click();
    await expect(page.getByLabel('One-time invitation')).toBeVisible();
    const enrollment = await page.getByLabel('One-time invitation').inputValue();
    const [pairingId, secretValue] = enrollment.split('.');
    assert.match(secretValue, /^[A-Za-z0-9_-]{43}$/); assert.deepEqual(requests[0], requests[1]);
    assert.equal(requests[0].invitationSha256, createHash('sha256').update(secretValue).digest('hex'));
    assert.equal(JSON.stringify(requests).includes(secretValue), false);
    assert.equal(page.url().includes(pairingId), false); assert.equal(page.url().includes(secretValue), false);
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
    assert.equal(stored.includes(secretValue), false); assert.equal(stored.includes(pairingId), false);
    assert.equal((await pairingPanel.locator('code').innerText()).includes(secretValue), false);
    await page.reload({ waitUntil: 'networkidle' });
    await pairingPanel.getByRole('button', { name: 'Resume pairing' }).click();
    await expect(pairingPanel.getByText(/secret is no longer available/)).toBeVisible();
    await expect(page.getByLabel('One-time invitation')).toHaveCount(0);
    const current = pairings.get(pairingId); current.status = 'claimed'; current.deviceName = 'Synthetic MacBook'; current.deviceFingerprint = 'a1b2c3d4e5f6';
    await refresh();
    await expect(pairingPanel.getByRole('button', { name: 'Confirm device', exact: true })).toBeDisabled();
    await expect(pairingPanel.getByLabel('Device fingerprint')).toHaveText(current.deviceFingerprint);
    await expect(page.getByLabel('One-time invitation')).toHaveCount(0);
    mkdirSync(join(root, 'test-results'), { recursive: true });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(root, 'test-results/staff-workspace-worker-pairing.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(root, 'test-results/staff-workspace-worker-pairing-mobile.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    await page.setViewportSize({ width: 1280, height: 900 });
    await pairingPanel.getByRole('checkbox').check();
    await pairingPanel.getByRole('button', { name: 'Confirm device', exact: true }).click();
    await expect(pairingPanel.getByRole('alert')).toBeVisible();
    await pairingPanel.getByRole('button', { name: 'Confirm device', exact: true }).click();
    await expect(pairingPanel.getByText(/Mac paired. Keep the local/)).toBeVisible();
    const approvals = requests.filter(body => body.action === 'approve'); assert.equal(approvals.length, 2); assert.deepEqual(approvals[0], approvals[1]);
    await pairingPanel.locator('summary').click();
    await pairingPanel.getByRole('button', { name: 'Renew access for 30 days' }).click();
    await expect(pairingPanel.getByRole('alert')).toContainText('device changed');
    await expect(pairingPanel.getByRole('button', { name: 'Renew access for 30 days' })).toBeEnabled();
    await pairingPanel.getByRole('button', { name: 'Renew access for 30 days' }).click();
    await expect(pairingPanel.getByText(/existing credential and saved work are preserved/)).toBeVisible();
    await expect(pairingPanel.getByRole('button', { name: 'Renew access for 30 days' })).toHaveCount(0);
    const renewals = requests.filter(body => body.action === 'renew'); assert.notEqual(renewals[0].operationId, renewals[1].operationId); assert.notEqual(renewals[0].expectedExpiresAt, renewals[1].expectedExpiresAt);
    await pairingPanel.getByRole('button', { name: 'Revoke access', exact: true }).click();
    await expect(pairingPanel.getByText(/does not log out Telegram or delete files/)).toBeVisible();
    await pairingPanel.getByRole('button', { name: 'Confirm revoke' }).click();
    await expect(pairingPanel.getByText(/logout and deletion of local files are not confirmed/)).toBeVisible();
    await expect(pairingPanel.getByText('Revoked', { exact: true })).toBeVisible();
    await pairingPanel.getByRole('button', { name: 'Next devices' }).click();
    await expect(pairingPanel.getByText('Older Mac', { exact: true })).toBeVisible();
    await expect(pairingPanel.getByText(/expired more than seven days/)).toBeVisible();
    await expect(pairingPanel.getByRole('button', { name: 'Renew access for 30 days' })).toHaveCount(0);
    await pairingPanel.getByRole('button', { name: 'Previous devices' }).click();
    await expect(pairingPanel.getByText('Recruiter Mac', { exact: true })).toBeVisible();
    await pairingPanel.getByRole('button', { name: 'Pair this Mac', exact: true }).click();
    await expect(page.getByLabel('One-time invitation')).toBeVisible();
    await pairingPanel.getByRole('button', { name: 'Cancel invitation', exact: true }).click();
    await expect(page.getByLabel('One-time invitation')).toHaveCount(0);
    await expect(pairingPanel.getByText('Invitation cancelled.', { exact: true })).toBeVisible();
    inviteTtl = 2000;
    await pairingPanel.getByRole('button', { name: 'Pair this Mac', exact: true }).click();
    await expect(page.getByLabel('One-time invitation')).toBeVisible();
    readsOffline = true;
    await expect(page.getByLabel('One-time invitation')).toHaveCount(0);
    await expect(pairingPanel.getByText('expired', { exact: true })).toBeVisible();
    readsOffline = false;
    denied = true; await refresh();
    await expect(pairingPanel.getByRole('alert')).toContainText('no longer have access');
    await expect(pairingPanel.getByText('Recruiter Mac', { exact: true })).toHaveCount(0);
    await expect(pairingPanel.getByLabel('Device fingerprint')).toHaveCount(0);
    assert.deepEqual(pageErrors, [], output.join('').slice(-5000));
});
