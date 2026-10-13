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
import { STAFF_MFA_COOKIE, createStaffMfaProof } from '../../src/lib/staff-mfa-cookie.js';

import { totpCode, totpCounter } from '../../src/lib/totp.js';

const expect = baseExpect.configure({ timeout: 15000 });
const root = resolve(process.env.STAFF_SELECTION_TEST_ROOT || fileURLToPath(new URL('../../', import.meta.url)));

async function waitForServer(url) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) }).catch(() => null);
        if (response?.ok) return;
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Temporary Telegram connection server did not start');
}

test('workspace selection fences stale tabs and verifies MFA separately for the same Google identity', { timeout: 240_000 }, async t => {
    assertLocalTestEnvironment();
    const db = await startPostgresContainer('pgworkspaceselectionui', POSTGRES_17_IMAGE, { publish: true });
    t.after(() => stopAndRemoveContainer(db));
    const migrationsDir = join(root, 'supabase/migrations');
    const migrations = readdirSync(migrationsDir).filter(name => name >= '20260922090000_foundation_roles.sql' && name.endsWith('.sql')).sort();
    assert.ok(migrations.some(name => name.includes('staff_workspace_directory')), 'Workspace directory migration is required');
    for (const name of migrations) psql(db, readFileSync(join(migrationsDir, name), 'utf8'));
    const runtimePassword = installStaffFixture(db);
    psql(db, `update app.users set time_zone='UTC' where id='${AUTHZ_ID.USER_ADMIN2}';
        insert into app.role_permissions(organization_id,role_id,permission_key) values('${AUTHZ_ID.ORG_B}','${AUTHZ_ID.ROLE_B_ADMIN}','candidates.read') on conflict do nothing;`);

    psql(db, `insert into app.candidates(id,organization_id,full_name,identity_state,lifecycle) values
        ('${randomUUID()}','${AUTHZ_ID.ORG_A}','Workspace A candidate sentinel','established','active'),
        ('${randomUUID()}','${AUTHZ_ID.ORG_B}','Workspace B candidate sentinel','established','active');`);
    const secret = 'synthetic-telegram-connection-test-secret';
    const totpId = randomUUID();
    const otherTotpId = randomUUID();
    const otherSecret = 'GEZDGNBVGY3TQOJQ';
    psql(db, `insert into app.totp_credentials (id, organization_id, user_id, secret, status, verified_at)
        values ('${totpId}', '${AUTHZ_ID.ORG_B}', '${AUTHZ_ID.USER_ADMIN2}', 'JBSWY3DPEHPK3PXP', 'active', now()),
        ('${otherTotpId}', '${AUTHZ_ID.ORG_A}', '${AUTHZ_ID.USER_ADMIN2}', '${otherSecret}', 'active', now());`);
    const port = await findFreePort();
    const baseURL = `http://127.0.0.1:${port}`;
    const output = [];
    const server = spawn(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '-p', String(port), '-H', '127.0.0.1'], {
        cwd: root,
        env: {
            PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development',
            NEXT_TELEMETRY_DISABLED: '1', NODE_OPTIONS: `--require ${join(root, 'tests/staff-workspace/google-token-preload.cjs')}`,
            STAFF_DATABASE_URL: `postgresql://agora_authz_test:${runtimePassword}@127.0.0.1:${publishedPort(db, 5432)}/postgres`,
            STAFF_ORGANIZATION_ID: AUTHZ_ID.ORG_B, NEXTAUTH_URL: baseURL, NEXTAUTH_SECRET: secret,
            GOOGLE_CLIENT_ID: 'synthetic-workspace-client', GOOGLE_CLIENT_SECRET: 'synthetic-workspace-client-secret',
            STAFF_MULTI_WORKSPACE_ENABLED: '1', TELEGRAM_INTAKE_ENABLED: '1', GITHUB_ID: '', GITHUB_SECRET: '',
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
    const context = await browser.newContext({ timezoneId: 'UTC' });
    // Lazy development compilation broadcasts a reload to every tab. Silence
    // only the dev HMR transport; production has no such reload channel.
    await context.routeWebSocket('**/_next/webpack-hmr*', () => {});
    await context.addCookies([
        { name: 'next-auth.session-token', value: token, url: baseURL },
        { name: STAFF_MFA_COOKIE, value: proof, url: baseURL },
    ]);
    const names = JSON.parse(psql(db, `select jsonb_object_agg(id,name) from app.organizations where id in ('${AUTHZ_ID.ORG_A}','${AUTHZ_ID.ORG_B}');`));
    const oldTab = await context.newPage();
    const selector = await context.newPage();
    await oldTab.addInitScript(() => {
        window.__testWorkspaceStorageEvents = [];
        window.addEventListener('storage', event => window.__testWorkspaceStorageEvents.push(event.key));
        const original = window.addEventListener.bind(window);
        window.addEventListener = (type, listener, options) => {
            if (type === 'staff-workspace-changed') window.__testWorkspaceBoundaryReady = true;
            return original(type, listener, options);
        };
    });
    const errors = [];
    oldTab.on('pageerror', error => errors.push(error.message));
    selector.on('pageerror', error => errors.push(error.message));
    try {
        await oldTab.goto(`${baseURL}/staff`);
        await oldTab.waitForFunction(() => window.__testWorkspaceBoundaryReady === true);
        await expect(oldTab.locator('meta[name="staff-workspace-id"]')).toHaveAttribute('content', AUTHZ_ID.ORG_B);
        await oldTab.route('**/api/staff/**', route => route.abort());
        await selector.goto(`${baseURL}/staff/workspaces`);
        const selectionResponse = selector.waitForResponse(response => response.url().endsWith('/api/staff/workspaces') && response.request().method() === 'POST');
        await selector.getByRole('listitem').filter({ has: selector.getByRole('heading', { name: names[AUTHZ_ID.ORG_A], exact: true }) }).getByRole('button', { name: 'Open workspace', exact: true }).click();
        const selected = await selectionResponse;
        assert.equal(selected.status(), 200, selected.status() === 200 ? undefined : await selected.text().catch(() => 'Selection failed'));
        await expect(selector).toHaveURL(`${baseURL}/staff/mfa/verify`);
        await expect(selector.getByRole('link', { name: 'Choose another workspace', exact: true })).toHaveAttribute('href', '/staff/workspaces');
        await expect(selector.getByText(names[AUTHZ_ID.ORG_A], { exact: true })).toBeVisible();
        await oldTab.bringToFront();
        await oldTab.waitForFunction(() => window.__testWorkspaceStorageEvents.includes('staff-workspace-selection-changed'));
        await expect(oldTab.getByRole('heading', { name: 'Your workspace changed', exact: true })).toBeVisible();
        // A hard navigation must escape the preserved invalidated layout.
        await oldTab.getByRole('link', { name: 'Choose workspace', exact: true }).click();
        await expect(oldTab.getByRole('heading', { name: 'Choose your workspace', exact: true })).toBeVisible();
        await expect(oldTab.getByRole('heading', { name: 'Your workspace changed', exact: true })).toHaveCount(0);
        await oldTab.unroute('**/api/staff/**');
        // The old workspace's signed MFA proof is not sufficient for this one.
        await context.addCookies([{ name: STAFF_MFA_COOKIE, value: proof, url: baseURL }]);
        await selector.goto(`${baseURL}/staff`);
        await expect(selector).toHaveURL(`${baseURL}/staff/mfa/verify`);
        await selector.getByLabel('Authenticator code', { exact: true }).fill(totpCode(otherSecret, totpCounter()));
        await selector.getByRole('button', { name: 'Verify', exact: true }).click();
        await expect(selector).toHaveURL(`${baseURL}/staff`);
        await expect(selector.locator('meta[name="staff-workspace-id"]')).toHaveAttribute('content', AUTHZ_ID.ORG_A);
        const checked = await context.request.get(`${baseURL}/api/staff/workspace`, { headers: { 'x-staff-workspace-id': AUTHZ_ID.ORG_A } });
        assert.equal(checked.status(), 200, await checked.text());
        const stale = await context.request.get(`${baseURL}/api/staff/workspace`, { headers: { 'x-staff-workspace-id': AUTHZ_ID.ORG_B } });
        assert.equal(stale.status(), 409);
        assert.equal(stale.headers()['x-staff-workspace-changed'], '1');
        // No localStorage broadcast: a staff link must still discard the old
        // App Router layout and form scope before presenting the new workspace.
        await oldTab.goto(`${baseURL}/staff/candidates`);
        await oldTab.waitForFunction(() => window.__testWorkspaceBoundaryReady === true);
        await expect(oldTab.getByText('Workspace A candidate sentinel', { exact: true })).toBeVisible();
        await oldTab.getByLabel('Name/email lookup', { exact: true }).fill('Workspace A');
        await expect(oldTab).toHaveURL(new RegExp(`q=Workspace\\+A.*_workspace=${AUTHZ_ID.ORG_A}`));
        const oldDocument = await oldTab.evaluate(() => performance.timeOrigin);
        await oldTab.route('**/api/staff/**', route => route.abort());
        await selector.goto(`${baseURL}/staff/workspaces`);
        await selector.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('Synthetic storage disabled'); }; });
        await selector.getByRole('listitem').filter({ has: selector.getByRole('heading', { name: names[AUTHZ_ID.ORG_B], exact: true }) }).getByRole('button', { name: 'Open workspace', exact: true }).click();
        await expect(selector).toHaveURL(`${baseURL}/staff/mfa/verify`);
        await context.addCookies([{ name: STAFF_MFA_COOKIE, value: proof, url: baseURL }]);
        await selector.goto(`${baseURL}/staff`);
        await expect(selector.locator('meta[name="staff-workspace-id"]')).toHaveAttribute('content', AUTHZ_ID.ORG_B);
        await expect(oldTab.locator('meta[name="staff-workspace-id"]')).toHaveAttribute('content', AUTHZ_ID.ORG_A);
        await expect(oldTab.getByRole('heading', { name: 'Your workspace changed', exact: true })).toHaveCount(0);
        const fencedForm = await context.request.post(`${baseURL}/api/staff/telegram-history`, { headers: { 'x-staff-workspace-id': AUTHZ_ID.ORG_A }, data: { action: 'discover' } });
        assert.equal(fencedForm.status(), 409);
        assert.equal(fencedForm.headers()['x-staff-workspace-changed'], '1');
        await oldTab.getByRole('link', { name: 'Candidates', exact: true }).click();
        await expect(oldTab.locator('meta[name="staff-workspace-id"]')).toHaveAttribute('content', AUTHZ_ID.ORG_B);
        assert.ok(await oldTab.evaluate(() => performance.timeOrigin) > oldDocument, 'A new document must replace the stale workspace layout');
        await expect(oldTab.getByText('Workspace B candidate sentinel', { exact: true })).toBeVisible();
        await expect(oldTab.getByText('Workspace A candidate sentinel', { exact: true })).toHaveCount(0);
        await expect(oldTab.getByLabel('Name/email lookup', { exact: true })).toHaveValue('');
        await expect(oldTab.locator('aside').getByText(names[AUTHZ_ID.ORG_B], { exact: true })).toBeVisible();
        await oldTab.unroute('**/api/staff/**');
        // Repeat the stale-cookie case with a debounced, programmatic RSC
        // filter update. Its old expectation must reject before reading A data.
        await oldTab.goto(`${baseURL}/staff/candidates`);
        await oldTab.waitForFunction(() => window.__testWorkspaceBoundaryReady === true);
        await expect(oldTab.getByText('Workspace B candidate sentinel', { exact: true })).toBeVisible();
        await oldTab.route('**/api/staff/**', route => route.abort());
        await selector.goto(`${baseURL}/staff/workspaces`);
        await selector.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('Synthetic storage disabled'); }; });
        await selector.getByRole('listitem').filter({ has: selector.getByRole('heading', { name: names[AUTHZ_ID.ORG_A], exact: true }) }).getByRole('button', { name: 'Open workspace', exact: true }).click();
        await expect(selector).toHaveURL(`${baseURL}/staff/mfa/verify`);
        const proofA = createStaffMfaProof(secret, { subject: '1002', userId: AUTHZ_ID.USER_ADMIN2, credentialId: otherTotpId });
        await context.addCookies([{ name: STAFF_MFA_COOKIE, value: proofA, url: baseURL }]);
        await selector.goto(`${baseURL}/staff`);
        await expect(selector.locator('meta[name="staff-workspace-id"]')).toHaveAttribute('content', AUTHZ_ID.ORG_A);
        await expect(oldTab.locator('meta[name="staff-workspace-id"]')).toHaveAttribute('content', AUTHZ_ID.ORG_B);
        const scopedFilter = oldTab.waitForRequest(request => {
            const url = new URL(request.url());
            return url.pathname === '/staff/candidates' && url.searchParams.get('_workspace') === AUTHZ_ID.ORG_B;
        });
        await oldTab.getByLabel('Name/email lookup', { exact: true }).fill('candidate');
        await scopedFilter;
        await expect(oldTab.getByRole('heading', { name: 'Choose your workspace', exact: true })).toBeVisible();
        await expect(oldTab.getByText('Workspace A candidate sentinel', { exact: true })).toHaveCount(0);
        await expect(oldTab.getByText('Workspace B candidate sentinel', { exact: true })).toHaveCount(0);
        await oldTab.unroute('**/api/staff/**');
        assert.deepEqual(errors, []);
        mkdirSync(join(root, 'test-results'), { recursive: true });
        await selector.screenshot({ path: join(root, 'test-results/staff-workspace-selection.png'), fullPage: true });
    } catch (error) {
        console.error(output.join('').slice(-12000));
        throw error;
    }
});
