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
    const createDraft = async (name, headline, extra = {}) => {
        const response = await context.request.post(draftsURL, { data: { fields: { firstName: name, lastName: 'Candidate', headline, ...(name === 'Alice' ? { primaryEmail: 'alice@example.test' } : {}), ...extra }, sourceTitle: 'Synthetic Telegram' } });
        if (response.status() !== 201) throw new Error(`Draft creation failed: ${await response.text()}\n${output.join('')}`);
        return (await response.json()).result;
    };
    await page.goto(`${baseURL}/staff/telegram-intake`);
    await expect(page).toHaveURL(`${baseURL}/staff/telegram-intake/chats`);
    await expect(page.getByRole('list', { name: 'Telegram onboarding steps' })).toBeVisible();
    const first = await createDraft('Alice', 'Original headline');
    await createDraft('Bob', 'Reject me');
    await page.goto(`${baseURL}/staff`);
    const reviewTasks = page.getByLabel('Candidate proposal tasks');
    await expect(reviewTasks.getByRole('link', { name: /Review candidate proposals/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'All 3', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Review 3', exact: true })).toBeVisible();
    await expect(page.getByText('You’re up to date', { exact: true })).not.toBeVisible();
    const applicationTasks = page.getByLabel('Application review tasks');
    await expect(applicationTasks.getByRole('link', { name: /Synthetic Candidate B/ })).toBeVisible();
    const proposalLink = reviewTasks.getByRole('link', { name: /Alice Candidate/ });
    await proposalLink.hover();
    await expect(proposalLink).toHaveCSS('background-color', 'rgb(250, 242, 223)');
    await page.screenshot({ path: join(root, 'test-results/overview-review-tasks.png'), fullPage: true });
    await page.getByRole('tab', { name: 'Review 3', exact: true }).click();
    await expect(reviewTasks.getByRole('link', { name: /Bob Candidate/ })).toBeVisible();
    await page.getByRole('tab', { name: 'Interviews 0', exact: true }).click();
    await expect(reviewTasks).not.toBeVisible();
    await expect(applicationTasks).not.toBeVisible();
    await page.getByRole('tab', { name: 'All 3', exact: true }).click();
    await reviewTasks.getByRole('link', { name: /Alice Candidate/ }).click();
    await expect(page).toHaveURL(`${baseURL}/staff/telegram-intake?draft=${first.id}`);
    const sidebar = page.locator('#staff-sidebar');
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
    await expect(sidebar).toHaveCSS('width', '64px');
    await expect(sidebar.getByRole('link', { name: 'Candidates', exact: true })).toHaveAttribute('title', 'Candidates');
    await page.getByRole('button', { name: 'Account menu', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Account settings', exact: true }).last()).toBeVisible();
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(sidebar).toHaveCSS('width', '64px');
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
    await expect(sidebar).toHaveCSS('width', '240px');
    const borderColor = await page.getByRole('region', { name: 'Candidate information' }).evaluate(el => getComputedStyle(el.parentElement).borderColor);
    assert.equal(borderColor, 'rgb(229, 231, 235)', 'workspace dividers use the soft border palette');

    await expect(page.getByRole('region', { name: 'Candidate information', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Candidate information' }).getByText('Original headline', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByLabel('Headline', { exact: true }).fill('Edited headline');
    await createDraft('Carol', 'Arrived while reviewing');
    await expect(page.getByRole('button', { name: /Carol Candidate/ })).toBeVisible();
    assert.equal(await page.getByLabel('Headline', { exact: true }).inputValue(), 'Edited headline', 'live arrivals preserve unsaved review edits');
    mkdirSync(join(root,'test-results'), { recursive: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: join(root,'test-results/candidate-review-columns.png'), fullPage: true });
    await page.getByRole('button', { name: 'Save and approve', exact: true }).click();
    await expect(page.getByText('Alice Candidate saved.', { exact: true })).toBeVisible();
    const savedAlice = (await (await context.request.get(`${draftsURL}/${first.id}`)).json()).result;
    const partial = await createDraft('Alice', 'Accepted update', { location: 'Rejected location', professionalSummary: 'Proposed summary' });
    await page.goto(`${baseURL}/staff/telegram-intake?draft=${partial.id}`);
    await expect(page.getByRole('button', { name: 'Save updates', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Approve Headline change', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save updates', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Reject Location change', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Reject Location change', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Edit Professional summary change', exact: true }).click();
    await page.getByRole('textbox', { name: 'Professional summary', exact: true }).fill('Edited summary');
    await page.getByRole('button', { name: 'Save change', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Candidate information' }).getByText('Edited summary')).toBeVisible();
    await page.getByRole('button', { name: 'Save updates', exact: true }).click();
    await expect(page.getByText('Alice Candidate saved.', { exact: true })).toBeVisible();
    const updatedAlice = (await (await context.request.get(`${baseURL}/api/staff/candidates/${savedAlice.candidateId}`)).json()).result;
    assert.equal(updatedAlice.candidate.headline, 'Accepted update');
    assert.equal(updatedAlice.candidate.professionalSummary, 'Edited summary', 'inline edited value is saved');
    assert.equal(updatedAlice.candidate.location, null, 'rejected change leaves canonical value unchanged');
    await page.getByRole('button', { name: /Bob Candidate/ }).click();
    await expect(page.getByRole('region', { name: 'Candidate information' }).getByText('Bob Candidate', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Reject', exact: true }).click();
    await expect(page.getByText('Proposal archived.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Bob Candidate/ })).not.toBeVisible();
    await page.locator('#proposal-view').selectOption('archived');
    await page.getByRole('button', { name: /Bob Candidate/ }).click();
    await expect(page.getByRole('region', { name: 'Candidate information' }).getByText('Reject me', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Restore proposal', exact: true }).click();
    await expect(page.getByText('Proposal restored.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Bob Candidate/ })).not.toBeVisible();
    await page.locator('#proposal-view').selectOption('all');
    await page.getByRole('button', { name: /Bob Candidate/ }).click();
    await page.getByRole('button', { name: 'Reject', exact: true }).click();
    await expect(page.getByText('Proposal archived.', { exact: true })).toBeVisible();
    await page.goto(`${baseURL}/staff`);
    await expect(page.getByLabel('Candidate proposal tasks').getByRole('link', { name: /Carol Candidate/ })).toBeVisible();
    await expect(page.getByLabel('Candidate proposal tasks').getByRole('link', { name: /Alice Candidate|Bob Candidate/ })).not.toBeVisible();
    psql(db, `insert into app.telegram_history_limits(organization_id,owner_user_id,onboarding_completed_at) values('${AUTHZ_ID.ORG_B}','${AUTHZ_ID.USER_ADMIN2}',now());`);
    await page.getByRole('link', { name: 'Telegram', exact: true }).first().click();
    await expect(page).toHaveURL(`${baseURL}/staff/telegram-intake`);
    await expect(page.getByRole('heading', { name: 'Candidate proposals', exact: true })).toBeVisible();
    const chats = Array.from({ length: 60 }, (_, index) => ({ id: `a0000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, peer: { kind: 'user', id: String(index+1) }, title: `Chat ${index+1}`, username: null, selected: false, version: 1, extractionEnabled: false, extractionPending: false, import: null }));
    let started;
    let releaseStart;
    let releaseHistory;
    const historyReady = new Promise(resolve => { releaseHistory = resolve; });
    await page.route('**/api/staff/telegram-history*', async route => {
        const req = route.request();
        if (req.method() === 'POST') {
            const action = req.postDataJSON();
            if (action.action === 'start') {
                started = action; await new Promise(resolve => { releaseStart = resolve; });
                for (const selected of action.chats) Object.assign(chats.find(chat => chat.id === selected.chatId), { selected: true, historyCompleted: true, import: { status: 'completed', errorCode: null }, version: 2 });
            } else {
                const chat = chats.find(chat => chat.id === action.chatId);
                chat.import.status = action.action === 'pause' ? 'paused' : 'completed'; chat.version += 1;
            }
            return route.fulfill({ json: { ok: true } });
        }
        await historyReady;
        const params = new URL(req.url()).searchParams;
        const available = chats.filter(chat => !chat.selected);
        const connected = chats.filter(chat => chat.selected);
        const group = params.get('view') === 'connected' ? connected : available;
        const filtered = params.get('q') ? group.filter(chat => chat.title === params.get('q')) : group;
        const rows = params.get('view') === 'active' ? [] : params.get('after') ? filtered.slice(50) : filtered.slice(0, 50);
        return route.fulfill({ json: { connection: { id: 'b0000000-0000-4000-8000-000000000001', generation: 1, status: 'connected', accountUserId: '123' }, account: { id: 'c0000000-0000-4000-8000-000000000001', accountUserId: '123' }, canImport: true, blockedReason: null, discovery: { status: 'completed', jobs: [] }, totals: { chats: 60, selected: connected.length, available: available.length, connected: connected.length, messages: 0, bytes: 0, maxMessages: 100000, maxBytes: 10000000 }, chats: rows, nextCursor: !params.get('after') && filtered.length > 50 ? 'next-page' : null } });
    });
    await page.goto(`${baseURL}/staff/telegram-intake/chats`);
    await expect(page.getByRole('status', { name: 'Loading Telegram chats' })).toBeVisible();
    await expect(page.getByLabel('Mac device pairing')).toHaveCount(0);
    releaseHistory();
    await expect(page.getByRole('status', { name: 'Loading Telegram chats' })).not.toBeVisible();
    await expect(page.getByRole('heading', { name: 'Pair your Mac', exact: true })).not.toBeVisible();
    await expect(page.getByRole('heading', { name: 'Choose chats', exact: true })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Telegram onboarding steps' })).not.toBeVisible();
    await page.getByRole('checkbox', { name: 'Select Chat 1', exact: true }).check();
    await page.getByRole('button', { name: 'More chats' }).click();
    await page.getByRole('checkbox', { name: 'Select Chat 51', exact: true }).check();
    await expect(page.getByText('2 selected', { exact: true })).toBeVisible();
    await expect(page.getByRole('status', { name: 'Telegram activity' })).toBeVisible();
    const startResponse = page.waitForResponse(response => response.url().includes('/api/staff/telegram-history') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect.poll(() => started?.action).toBe('start');
    await expect(page.getByRole('button', { name: 'Starting…', exact: true })).toBeDisabled();
    await expect(page.getByRole('progressbar', { name: 'Processing Telegram information' })).toBeVisible();
    releaseStart();
    await startResponse;
    await expect(page.getByRole('tab', { name: 'Connected (2)', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0);
    await expect(page.getByText('Synced', { exact: true })).toHaveCount(2);
    await page.getByRole('button', { name: 'Pause Chat 1', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Resume Chat 1', exact: true })).toBeVisible();
    await expect(page.getByText('Paused', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Resume Chat 1', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Pause Chat 1', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Available (58)', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: 'Select Chat 1', exact: true })).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: 'Select Chat 2', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Connected (2)', exact: true }).click();
    await expect(page.getByRole('status', { name: 'Telegram activity' })).toBeVisible();
    assert.equal(started.chats.length, 2);
    assert.deepEqual(started.chats.map(chat => chat.chatId), [chats[0].id,chats[50].id]);
    await expect(page.getByRole('link', { name: 'Review proposals', exact: true })).toHaveCount(1);
    await expect(page.getByRole('status', { name: 'Telegram activity' }).getByRole('link', { name: 'Review proposals', exact: true })).toBeVisible();
    await expect(page.getByText('1 proposal ready', { exact: true })).toBeVisible();
    mkdirSync(join(root,'test-results'), { recursive: true });
    await page.screenshot({ path: join(root,'test-results/candidate-flow-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(root,'test-results/candidate-flow-mobile.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'mobile has no horizontal overflow');
    let meaningQuery;
    const meaningRequests = [];
    const semanticId = randomUUID();
    await page.route('**/api/staff/profile-search*', route => {
        meaningRequests.push(route.request().url());
        if (route.request().method() === 'POST') { meaningQuery = route.request().postDataJSON(); return route.fulfill({ json: { queryId: semanticId, status: 'queued' } }); }
        if (new URL(route.request().url()).searchParams.has('queryId')) return route.fulfill({ json: { status: 'completed', workerAvailable: true, results: [{ sourceType: 'candidate', sourceId: savedAlice.candidateId, directoryRow: { candidateId: savedAlice.candidateId, fullName: 'Alice Candidate', email: 'alice@example.test', headline: 'Accepted update', ownerName: null, applicationCount: 0, hasCv: false, createdAt: new Date().toISOString() } }], nextAfter: null } });
        return route.fulfill({ json: { workerAvailable: true, cvAvailable: false } });
    });
    await page.goto(`${baseURL}/staff/candidates/search`);
    await expect(page).toHaveURL(`${baseURL}/staff/candidates`);
    await expect(page.getByRole('heading', { name: 'Candidates', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Review proposals (1)', exact: true })).toBeVisible();
    const unifiedSearch = page.getByRole('textbox', { name: 'Search candidates', exact: true });
    await unifiedSearch.fill('alice@example.test');
    await expect(page.getByRole('table').getByRole('link', { name: 'Alice Candidate', exact: true })).toBeVisible();
    assert.equal(meaningQuery, undefined, 'email lookup does not enqueue a meaning search');
    await expect(page.getByText('1 candidate', { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/q=alice%40example.test/);
    await unifiedSearch.fill('Remote Ethereum engineer');
    try { await expect.poll(() => meaningQuery?.query).toBe('Remote Ethereum engineer'); } catch (error) { t.diagnostic(JSON.stringify({ requests: meaningRequests, url: page.url(), input: await unifiedSearch.inputValue(), body: (await page.locator('body').innerText()).slice(-2200) })); throw error; }
    assert.equal(meaningQuery.scope, 'approved', 'unified search ranks candidate profiles');
    await expect(page.getByRole('table').getByRole('link', { name: 'Alice Candidate', exact: true })).toBeVisible();
    await expect(page.getByRole('table').getByText('alice@example.test', { exact: true })).toBeVisible();
    await expect(page.getByText('1 match · Best matches first', { exact: true })).toBeVisible();
    assert.equal(new URL(page.url()).pathname, '/staff/candidates');
    await page.screenshot({ path: join(root, 'test-results/candidate-unified-search.png'), fullPage: true });
    await page.goto(`${baseURL}/staff/telegram-intake`);
    await page.getByRole('button', { name: /Carol Candidate/ }).click();
    await page.getByRole('button', { name: 'Reject', exact: true }).click();
    await expect(page.getByText('Proposal archived.', { exact: true })).toBeVisible();
    await page.goto(`${baseURL}/staff/candidates`);
    await expect(page.getByRole('link', { name: /Review proposals/ })).toHaveCount(0);
    assert.deepEqual(clientErrors, []);
});
