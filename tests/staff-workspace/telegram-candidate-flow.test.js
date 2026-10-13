import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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

test('Candidate intake has a compact chat picker and approve/edit/reject review on desktop and mobile', { timeout: 240_000 }, async t => {
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
    // Production has no dev HMR reload when the removal route compiles for the first time.
    await context.routeWebSocket('**/_next/webpack-hmr*', () => {});
    await context.addCookies([
        { name: 'next-auth.session-token', value: token, url: baseURL },
        { name: STAFF_MFA_COOKIE, value: proof, url: baseURL },
    ]);
    const page = await context.newPage();
    const clientErrors = [];
    page.on('pageerror', error => clientErrors.push(error.message));
    const draftsURL = `${baseURL}/api/staff/telegram-intake/drafts`;
    const createDraft = async (name, headline) => {
        const response = await context.request.post(draftsURL, { data: { fields: { firstName: name, lastName: 'Candidate', headline }, sourceTitle: 'Synthetic Telegram' } });
        if (response.status() !== 201) throw new Error(`Draft creation failed: ${await response.text()}\n${output.join('')}`);
        return (await response.json()).result;
    };
    const first = await createDraft('Alice', 'Original headline');
    await createDraft('Bob', 'Reject me');
    await page.goto(`${baseURL}/staff/telegram-intake?draft=${first.id}`);
    await expect(page.getByRole('heading', { name: 'Review candidate', exact: true })).toBeVisible();
    await expect(page.getByRole('dialog').getByText('Original headline', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByLabel('Headline', { exact: true }).fill('Edited headline');
    await page.getByRole('button', { name: 'Save and approve', exact: true }).click();
    await expect(page.getByText('Alice Candidate saved.', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog').getByText('Bob Candidate', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Reject', exact: true }).click();
    await expect(page.getByText('Proposal rejected.', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Review candidate', exact: true })).not.toBeVisible();
    const chats = Array.from({ length: 60 }, (_, index) => ({ id: `a0000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, peer: { kind: 'user', id: String(index+1) }, title: `Chat ${index+1}`, username: null, selected: false, version: 1, extractionEnabled: false, extractionPending: false, import: null }));
    let started;
    await page.route('**/api/staff/telegram-history*', async route => {
        const req = route.request();
        if (req.method() === 'POST') { started = req.postDataJSON(); return route.fulfill({ json: { ok: true } }); }
        const params = new URL(req.url()).searchParams;
        const rows = params.get('view') === 'active' ? [] : params.get('q') ? chats.filter(chat => chat.title === params.get('q')) : params.get('after') ? chats.slice(50) : chats.slice(0,50);
        return route.fulfill({ json: { connection: { id: 'b0000000-0000-4000-8000-000000000001', generation: 1, status: 'connected', accountUserId: '123' }, account: { id: 'c0000000-0000-4000-8000-000000000001', accountUserId: '123' }, canImport: true, blockedReason: null, discovery: { status: 'completed', jobs: [] }, totals: { chats: 60, selected: 0, messages: 0, bytes: 0, maxMessages: 100000, maxBytes: 10000000 }, chats: rows, nextCursor: params.get('after') || params.get('q') ? null : 'next-page' } });
    });
    await page.goto(`${baseURL}/staff/telegram-intake/chats`);
    await expect(page.getByRole('heading', { name: 'Choose chats', exact: true })).toBeVisible();
    await page.getByRole('checkbox', { name: 'Select Chat 1', exact: true }).check();
    await page.getByRole('button', { name: 'More chats' }).click();
    await page.getByRole('checkbox', { name: 'Select Chat 51', exact: true }).check();
    await expect(page.getByText('2 selected', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect.poll(() => started?.action).toBe('start');
    assert.equal(started.chats.length, 2);
    assert.deepEqual(started.chats.map(chat => chat.chatId), [chats[0].id,chats[50].id]);
    await expect(page.getByText('Finding candidates…', { exact: true }).last()).toBeVisible();
    mkdirSync(join(root,'test-results'), { recursive: true });
    await page.screenshot({ path: join(root,'test-results/candidate-flow-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(root,'test-results/candidate-flow-mobile.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'mobile has no horizontal overflow');
    await page.goto(`${baseURL}/staff/candidates/search`);
    await expect(page.getByRole('heading', { name: 'Search candidates', exact: true })).toBeVisible();
    assert.equal(await page.locator('#profile-search-scope').inputValue(), 'approved');
    assert.deepEqual(clientErrors, []);
});
