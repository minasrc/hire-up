import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { chromium, expect } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import {
    POSTGRES_17_IMAGE,
    assertLocalTestEnvironment,
    findFreePort,
    psql,
    publishedPort,
    startPostgresContainer,
    stopAndRemoveContainer,
} from '../support/foundation-docker.js';
import {
    AUTHZ_ID,
    GOOGLE_MIGRATION,
    INVITES_MIGRATION,
    INVITE_DOMAINS_MIGRATION,
    installStaffFixture,
} from '../support/staff-authorization.js';
import { PRIVACY_MIGRATIONS } from '../support/privacy-foundation.js';
import { PRIVACY_OPS_MIGRATION } from '../support/privacy-operations.js';
import {
    CJ_ID,
    CJ_SUBJECTS,
    WORKFLOW_MIGRATION,
    clientJobFixtureSql,
} from '../support/client-job-workflows.js';
import {
    STAFF_MFA_COOKIE,
    createStaffMfaProof,
} from '../../src/lib/staff-mfa-cookie.js';
import { createSyntheticPdf } from '../support/cv-fixtures.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const migrationsDir = join(repoRoot, 'supabase', 'migrations');
const nextBin = join(repoRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
const preloadPath = join(repoRoot, 'tests', 'staff-workspace', 'google-token-preload.cjs');
const resultsDir = join(repoRoot, 'test-results');

const MIGRATIONS = [
    '20260922090000_foundation_roles.sql',
    '20260922090100_foundation_schema.sql',
    '20260922090200_foundation_seed.sql',
    '20260922130000_staff_authorization_core.sql',
    GOOGLE_MIGRATION,
    ...PRIVACY_MIGRATIONS,
    PRIVACY_OPS_MIGRATION,
    WORKFLOW_MIGRATION,
    '20260925100000_staff_totp.sql',
    '20260925110000_staff_listing.sql',
    INVITES_MIGRATION,
    INVITE_DOMAINS_MIGRATION,
    '20260925140000_application_pipeline.sql',
    '20260926140000_public_intake.sql',
    '20260928100000_staff_workspace.sql',
    '20260928220000_job_visibility.sql',
    '20260930090000_staff_candidate_management.sql',
    '20260930090100_staff_workspace_views.sql',
    '20260930090200_candidate_intake_safety.sql',
];

const NEXTAUTH_SECRET = 'synthetic-workspace-secret';
const GOOGLE_CLIENT_ID = 'synthetic-workspace-client';
const REFRESH_TOKEN = 'SYNTHETIC-WORKSPACE-TEST';
const ORG_ID = AUTHZ_ID.ORG_B;
const SUBJECT = '1002';
const TOTP_CREDENTIAL_ID = 'a5b1a111-0000-4000-8000-00000000c001';
const TOTP_CREDENTIAL_ID_REC = 'a5b1a111-0000-4000-8000-00000000c002';

const readMigration = (name) => readFileSync(join(migrationsDir, name), 'utf8');

const waitForServer = async (url, timeoutMs = 180_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const response = await fetch(url).catch(() => null);
        if (response?.ok) return;
        if (Date.now() > deadline) {
            throw new Error(`Next dev server did not become ready at ${url}.`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
};

const srgb = (value) => {
    const channel = value / 255;
    return channel <= 0.03928
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4;
};

const relativeLuminance = ({ r, g, b }) =>
    0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);

const gotoStaff = async (page, url) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.getByRole('main').last().waitFor();
    await page.waitForLoadState('networkidle');
};

const clickUntil = async (action, target, timeout = 30_000) =>
    expect(async () => {
        await action();
        await target.waitFor({ state: 'visible', timeout: 2000 });
    }).toPass({ timeout });

const fillWhenReady = async (locator, value, timeout = 30_000) =>
    expect(async () => {
        await locator.fill(value);
        await expect(locator).toHaveValue(value, { timeout: 1500 });
    }).toPass({ timeout });

const sampleContrast = (locator) => locator.first().evaluate((node) => {
    const parse = (value) => {
        const parts = String(value).match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 1];
        return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
    };
    const color = parse(getComputedStyle(node).color);
    let el = node;
    let background = parse(getComputedStyle(el).backgroundColor);
    while (background.a === 0 && el.parentElement) {
        el = el.parentElement;
        background = parse(getComputedStyle(el).backgroundColor);
    }
    const srgbLocal = (v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const lum = ({ r, g, b }) =>
        0.2126 * srgbLocal(r) + 0.7152 * srgbLocal(g) + 0.0722 * srgbLocal(b);
    const l1 = lum(color);
    const l2 = lum(background);
    return {
        color: getComputedStyle(node).color,
        background: getComputedStyle(el).backgroundColor,
        ratio: (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05),
    };
});

test('staff workspace end-to-end in a real browser', async (t) => {
    assertLocalTestEnvironment();
    const container = await startPostgresContainer('pgstaffbrowser', POSTGRES_17_IMAGE, {
        publish: true,
    });
    t.after(() => stopAndRemoveContainer(container));

    for (const fileName of MIGRATIONS) {
        psql(container, readMigration(fileName));
    }
    const runtimePassword = installStaffFixture(container);
    psql(container, clientJobFixtureSql);
    const privacyCaseId = randomUUID();
    psql(container, `
        insert into app.role_permissions (organization_id, role_id, permission_key)
            values ('${ORG_ID}', '${AUTHZ_ID.ROLE_B_ADMIN}', 'privacy.manage')
            on conflict do nothing;
        insert into app.privacy_requests
            (id, organization_id, candidate_id, kind, status, received_at,
             verified_at, verification_method, verified_by_membership_id, due_at)
            values
            ('${privacyCaseId}', '${ORG_ID}', '${CJ_ID.CANDIDATE_B}', 'access',
             'in_progress', now() - interval '2 days', now() - interval '1 day',
             'email match', '${CJ_ID.MEMBER_B_ADMIN}', now() + interval '28 days');
        insert into app.privacy_request_subjects
            (id, organization_id, request_id, candidate_id, candidate_version,
             reviewed_by_membership_id, reviewed_at) values
            ('${randomUUID()}', '${ORG_ID}', '${privacyCaseId}',
             '${CJ_ID.CANDIDATE_B}', 1, '${CJ_ID.MEMBER_B_ADMIN}', now());
        insert into app.privacy_events
            (id, organization_id, request_id, sequence, action,
             actor_membership_id, occurred_at, evidence_code) values
            ('${randomUUID()}', '${ORG_ID}', '${privacyCaseId}', 1,
             'privacy.request.created', '${CJ_ID.MEMBER_B_ADMIN}',
             now() - interval '2 days', 'intake-form'),
            ('${randomUUID()}', '${ORG_ID}', '${privacyCaseId}', 2,
             'privacy.request.verified', '${CJ_ID.MEMBER_B_ADMIN}',
             now() - interval '1 day', 'staff-review');
    `);
    psql(container, `
        insert into app.totp_credentials
            (id, organization_id, user_id, secret, status, verified_at)
        values ('${TOTP_CREDENTIAL_ID}', '${ORG_ID}', '${AUTHZ_ID.USER_ADMIN2}',
            'JBSWY3DPEHPK3PXP', 'active', now()),
            ('${TOTP_CREDENTIAL_ID_REC}', '${ORG_ID}', '${CJ_ID.USER_B_REC}',
            'JBSWY3DPEHPK3PXP', 'active', now());
    `);
    const intakePassword = randomUUID();
    psql(container, `
        create role agora_intake_test login password '${intakePassword}';
        grant app_intake to agora_intake_test;
    `);

    const port = await findFreePort();
    const baseURL = `http://127.0.0.1:${port}`;
    const databaseUrl = `postgresql://agora_authz_test:${runtimePassword}@127.0.0.1:${publishedPort(container, 5432)}/postgres`;

    const childEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        SHELL: process.env.SHELL,
        NODE_ENV: 'development',
        NEXT_TELEMETRY_DISABLED: '1',
        NODE_OPTIONS: `--require ${preloadPath}`,
        STAFF_DATABASE_URL: databaseUrl,
        STAFF_ORGANIZATION_ID: ORG_ID,
        NEXTAUTH_URL: baseURL,
        NEXTAUTH_SECRET,
        GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET: 'synthetic-workspace-client-secret',
        DATABASE_URL: '',
        INTAKE_DATABASE_URL: `postgresql://agora_intake_test:${intakePassword}@127.0.0.1:${publishedPort(container, 5432)}/postgres`,
        E2E_DATABASE_URL: '',
        E2E_REAL_BACKEND: '',
        RESEND_API_KEY: '',
        NEXT_PUBLIC_SUPABASE_URL: '',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: '',
        SUPABASE_SERVICE_ROLE_KEY: '',
        SUPABASE_DB_URL: '',
        GITHUB_ID: '',
        GITHUB_SECRET: '',
    };

    const serverOutput = [];
    const next = spawn(process.execPath,
        [nextBin, 'dev', '--webpack', '-p', String(port), '-H', '127.0.0.1'], {
            cwd: repoRoot,
            env: childEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    next.stdout.on('data', (chunk) => {
        serverOutput.push(String(chunk));
        if (serverOutput.length > 400) serverOutput.shift();
    });
    next.stderr.on('data', (chunk) => {
        serverOutput.push(String(chunk));
        if (serverOutput.length > 400) serverOutput.shift();
    });
    t.after(async () => {
        next.kill('SIGTERM');
        await new Promise((resolve) => {
            const timer = setTimeout(() => { next.kill('SIGKILL'); resolve(); }, 10_000);
            next.once('exit', () => { clearTimeout(timer); resolve(); });
        });
    });
    next.once('exit', (code) => {
        if (code !== null && code !== 0) {
            t.diagnostic(`next dev exited early with code ${code}:\n${serverOutput.join('')}`);
        }
    });

    await waitForServer(`${baseURL}/jobs`);

    const intake = new pg.Client({
        host: '127.0.0.1',
        port: publishedPort(container, 5432),
        user: 'agora_intake_test',
        password: intakePassword,
        database: 'postgres',
        connectionTimeoutMillis: 10_000,
    });
    intake.on('error', () => {});
    await intake.connect();
    t.after(async () => { await intake.end().catch(() => {}); });
    await intake.query('set role app_intake');
    await intake.query(
        `select pg_catalog.set_config('app.organization_id', '${ORG_ID}', false)`);
    const publicJobTitles = async () => {
        const { rows } = await intake.query(
            'select app.list_public_jobs_v1() as result');
        return (rows[0]?.result?.jobs ?? []).map((job) => job.title);
    };

    const staffCookiesFor = async (subject, userId, credentialId, name, email) => {
        const sessionToken = await encode({
            token: {
                name,
                email,
                sub: subject,
                provider: 'google',
                providerAccountId: subject,
                googleRefreshToken: REFRESH_TOKEN,
                emailVerified: true,
                iat: Math.floor(Date.now() / 1000),
                exp: Math.floor(Date.now() / 1000) + 3600,
            },
            secret: NEXTAUTH_SECRET,
        });
        const mfaProof = createStaffMfaProof(NEXTAUTH_SECRET, {
            subject,
            userId,
            credentialId,
        });
        return [
            {
                name: 'next-auth.session-token',
                value: sessionToken,
                url: baseURL,
                httpOnly: true,
                sameSite: 'Lax',
            },
            {
                name: STAFF_MFA_COOKIE,
                value: mfaProof,
                url: baseURL,
                httpOnly: true,
                sameSite: 'Lax',
            },
        ];
    };

    const staffCookies = await staffCookiesFor(
        SUBJECT,
        AUTHZ_ID.USER_ADMIN2,
        TOTP_CREDENTIAL_ID,
        'Admin Two',
        'admin-two@synthetic.test',
    );
    const recruiterCookies = await staffCookiesFor(
        CJ_SUBJECTS.RECRUITER,
        CJ_ID.USER_B_REC,
        TOTP_CREDENTIAL_ID_REC,
        'Recruiter Synthetic',
        'recruiter@synthetic.test',
    );
    const sessionOnlyCookies = [staffCookies[0]];
    const cookieHeader = (cookies) =>
        cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

    const browser = await chromium.launch();
    t.after(async () => { await browser.close().catch(() => {}); });
    mkdirSync(resultsDir, { recursive: true });

    const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await desktop.addCookies(staffCookies);
    const page = await desktop.newPage();
    page.setDefaultTimeout(90_000);

    await t.test('overview renders live metrics, tasks, review queue and clients hiring', async () => {
        const summaryRequests = [];
        const trackSummary = (request) => {
            if (new URL(request.url()).pathname === '/api/staff/workspace') {
                summaryRequests.push(request.url());
            }
        };
        page.on('request', trackSummary);
        try {
            await gotoStaff(page, `${baseURL}/staff`);
            assert.equal(summaryRequests.length, 0,
                'fresh server summary must not be fetched again during hydration');
        } finally {
            page.off('request', trackSummary);
        }
        await page.getByRole('heading', { name: 'Overview', level: 1 }).waitFor();

        await page.getByRole('link', { name: /^Candidates 1$/ }).waitFor();
        await page.getByRole('link', { name: /^Applications 1$/ }).waitFor();
        await page.getByRole('link', { name: /^Open roles 0$/ }).waitFor();

        await page.getByText('To-do').waitFor();
        await page.getByRole('heading', { name: 'Awaiting review' }).waitFor();
        await page.getByRole('heading', { name: 'Clients hiring' }).waitFor();
        await page.getByRole('link', { name: 'Synthetic Candidate B' }).waitFor();
        assert.match(await page.getByRole('main').last().innerText(), /You’re up to date/);
    });

    await t.test('tasks can be added, completed, reloaded and reopened', async () => {
        const tasksFetch = page.waitForResponse(
            (response) => response.url().includes('/api/staff/tasks?')
                && response.request().method() === 'GET' && response.ok(),
            { timeout: 90_000 },
        );
        await page.goto(`${baseURL}/staff`, { waitUntil: 'domcontentloaded' });
        await tasksFetch;

        const todo = page.locator('#tasks');
        const dialog = page.getByRole('dialog');
        await clickUntil(
            () => todo.getByRole('button', { name: 'Add task' }).click(),
            dialog,
        );
        await fillWhenReady(dialog.locator('#task-title'), 'Synthetic browser task');
        await clickUntil(
            () => dialog.getByRole('combobox', { name: 'Task category' }).click(),
            page.getByRole('listbox'),
        );
        await page.getByRole('option', { name: 'Notes' }).click();
        await dialog.getByRole('button', { name: 'Add task' }).click();
        await todo.getByText('Synthetic browser task').waitFor();

        const taskPosts = () => page.waitForResponse(
            (response) => response.url().includes('/api/staff/tasks')
                && response.request().method() === 'POST'
                && response.ok(),
        );
        await page.waitForLoadState('networkidle');
        const redundantReads = [];
        const trackCompletion = (request) => {
            const url = new URL(request.url());
            if (request.method() === 'GET' && (
                url.pathname === '/api/staff/tasks'
                || url.pathname === '/api/staff/recruitment/context'
                || (url.pathname === '/staff' && url.searchParams.has('_rsc'))
            )) redundantReads.push(request.url());
        };
        page.on('request', trackCompletion);
        let posted = taskPosts();
        try {
            await todo.getByRole('checkbox', {
                name: 'Mark Synthetic browser task complete',
            }).click();
            await posted;
            await todo.getByText('Synthetic browser task').waitFor({ state: 'detached' });
            await page.waitForLoadState('networkidle');
            assert.deepEqual(redundantReads, [],
                'task completion must not reload tasks, recruitment context or the page');
        } finally {
            page.off('request', trackCompletion);
        }

        let reloadFetch = page.waitForResponse(
            (response) => response.url().includes('/api/staff/tasks?')
                && response.request().method() === 'GET',
        );
        await page.reload({ waitUntil: 'domcontentloaded' });
        await reloadFetch;
        const todoAfter = page.locator('#tasks');
        await todoAfter.getByRole('button', { name: /Completed \(1\)/ }).waitFor();
        await todoAfter.getByRole('button', { name: /Completed \(\d+\)/ }).click();
        await todoAfter.getByText('Synthetic browser task').waitFor();

        posted = taskPosts();
        await todoAfter.getByRole('checkbox', {
            name: 'Reopen Synthetic browser task',
        }).click();
        await posted;

        reloadFetch = page.waitForResponse(
            (response) => response.url().includes('/api/staff/tasks?')
                && response.request().method() === 'GET',
        );
        await page.reload({ waitUntil: 'domcontentloaded' });
        await reloadFetch;
        await page.locator('#tasks')
            .getByRole('checkbox', { name: 'Mark Synthetic browser task complete' })
            .waitFor();
    });

    await t.test('attention bell reflects real counts and errors honestly', async () => {
        await gotoStaff(page, `${baseURL}/staff`);
        const bell = page.getByRole('button', { name: /Workspace updates, \d+ item/ });
        await bell.waitFor();
        const badge = await bell.getAttribute('aria-label');
        assert.match(badge, /Workspace updates, 2 items/);
        await clickUntil(() => bell.click(), page.getByText('Needs attention'));
        await page.getByRole('link', { name: /Applications awaiting review/ }).waitFor();
        await page.keyboard.press('Escape');

        await page.route('**/api/staff/workspace', (route) =>
            route.fulfill({ status: 403, body: '{}' }));
        try {
            const failedRefresh = page.waitForResponse(
                (response) => response.url().includes('/api/staff/workspace')
                    && response.status() === 403,
            );
            await page.goto(`${baseURL}/staff/jobs`, {
                waitUntil: 'domcontentloaded',
            });
            await page.waitForLoadState('networkidle');
            await page.evaluate(() => window.dispatchEvent(new Event('focus')));
            await failedRefresh;
            await page.getByRole('button', {
                name: 'Workspace updates unavailable',
            }).click();
            await page.getByText('Your staff session is no longer valid.').waitFor();
            await page.getByRole('link', { name: 'Sign in again' }).waitFor();
            assert.equal(
                await page.getByRole('link', { name: 'Members', exact: true })
                    .count(),
                0,
                'a denied session must drop privileged navigation',
            );
        } finally {
            await page.unroute('**/api/staff/workspace');
        }
        await page.keyboard.press('Escape');
    });

    await t.test('task list paginates, races safely and survives API failures', async () => {
        const batch = [];
        for (let index = 0; index < 24; index += 1) {
            batch.push(`('${randomUUID()}', '${ORG_ID}',
                '${AUTHZ_ID.MEMBER_B_ADMIN}',
                'Batch task ${String(index).padStart(3, '0')}', 'notes')`);
        }
        psql(container, `
            insert into app.staff_tasks
                (id, organization_id, owner_membership_id, title, category)
            values ${batch.join(',\n')};
        `);

        let tasksFetch = page.waitForResponse(
            (response) => response.url().includes('/api/staff/tasks?')
                && response.request().method() === 'GET' && response.ok(),
            { timeout: 90_000 },
        );
        await page.goto(`${baseURL}/staff`, { waitUntil: 'domcontentloaded' });
        await tasksFetch;

        const todo = page.locator('#tasks');
        await expect(todo.locator('ul li')).toHaveCount(20);
        const labels = () => todo.locator('ul li [role="checkbox"]')
            .evaluateAll(
                (nodes) => nodes.map((node) => node.getAttribute('aria-label')),
            );

        await page.route('**/api/staff/tasks?*offset=20*', async (route) => {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            await route.continue();
        });
        const showMore = todo.getByRole('button', { name: /Show more/ });
        const secondPage = page.waitForResponse(
            (response) => response.url().includes('offset=20')
                && response.request().method() === 'GET' && response.ok());
        await showMore.click();
        await showMore.click({ force: true });
        await secondPage;
        await page.unroute('**/api/staff/tasks?*offset=20*');
        await expect(todo.locator('ul li')).toHaveCount(25);
        const seen = await labels();
        assert.equal(
            new Set(seen).size, seen.length,
            'paginated tasks must never render the same task twice',
        );

        await page.route('**/api/staff/tasks?*', async (route) => {
            const requestUrl = new URL(route.request().url());
            if (requestUrl.searchParams.get('category') === 'notes') {
                await new Promise((resolve) => setTimeout(resolve, 2500));
            }
            await route.continue();
        });
        await todo.getByRole('tab', { name: /^Notes/ }).click();
        await todo.getByRole('tab', { name: /^Review/ }).click();
        await todo.getByText('No tasks in this category').waitFor();
        await page.waitForTimeout(3500);
        assert.equal(
            await todo.getByText('Batch task 000').count(), 0,
            'a stale Notes response must not overwrite the Review tab',
        );
        await page.unroute('**/api/staff/tasks?*');

        await page.route('**/api/staff/tasks?*', (route) =>
            route.fulfill({
                status: 401,
                contentType: 'application/json',
                body: '{}',
            }));
        await page.reload({ waitUntil: 'domcontentloaded' });
        await todo.getByRole('link', { name: 'Sign in' }).waitFor();
        assert.equal(await todo.locator('ul li').count(), 0);
        await page.unroute('**/api/staff/tasks?*');

        await page.route('**/api/staff/tasks?*', (route) =>
            route.fulfill({
                status: 503,
                contentType: 'application/json',
                body: '{}',
            }));
        await page.reload({ waitUntil: 'domcontentloaded' });
        await todo.getByText('Could not load tasks.').waitFor();
        const retry = todo.getByRole('button', { name: 'Retry' });
        await page.unroute('**/api/staff/tasks?*');
        tasksFetch = page.waitForResponse(
            (response) => response.url().includes('/api/staff/tasks?')
                && response.request().method() === 'GET' && response.ok());
        await retry.click();
        await tasksFetch;
        await todo.locator('ul li').first().waitFor();

        await page.route('**/api/staff/tasks', (route) => {
            if (route.request().method() === 'POST') {
                return route.fulfill({
                    status: 503,
                    contentType: 'application/json',
                    body: '{}',
                });
            }
            return route.continue();
        });
        const dialog = page.getByRole('dialog');
        await clickUntil(
            () => todo.getByRole('button', { name: 'Add task' }).click(),
            dialog,
        );
        await fillWhenReady(dialog.locator('#task-title'), 'Doomed task title');
        await dialog.getByRole('button', { name: 'Add task' }).click();
        await dialog.getByText('Could not save. Please try again.').waitFor();
        await expect(dialog.locator('#task-title')).toHaveValue('Doomed task title');
        await page.unroute('**/api/staff/tasks');
        const created = page.waitForResponse(
            (response) => response.url().includes('/api/staff/tasks')
                && response.request().method() === 'POST' && response.ok());
        await dialog.getByRole('button', { name: 'Add task' }).click();
        await created;
        await dialog.waitFor({ state: 'detached' });
        await todo.getByText('Doomed task title').waitFor();
    });

    let createdClientId;
    await t.test('client creation persists fields and social links', async () => {
        await gotoStaff(page, `${baseURL}/staff/clients/new`);
        await page.locator('#client-name').fill('Synthetic Browser Client');
        await page.locator('#client-contact-name').fill('Casey Example');
        await page.locator('#client-contact-email').fill('casey@synthetic.test');
        await page.locator('#client-website').fill('https://client.synthetic.test');
        await clickUntil(
            () => page.getByRole('button', { name: 'Add social link' }).click(),
            page.locator('#social-url-0'),
        );
        await clickUntil(
            () => page.getByRole('combobox', { name: 'Social link 1 platform' }).click(),
            page.getByRole('listbox'),
        );
        await page.getByRole('option', { name: 'LinkedIn' }).click();
        await page.locator('#social-url-0').fill('https://linkedin.com/company/synthetic');
        const saved = page.waitForResponse(
            (response) => response.url().includes('/api/staff/clients')
                && response.request().method() === 'POST' && response.ok(),
        );
        await page.getByRole('button', { name: 'Create client' }).click();
        await saved;
        await page.waitForURL(/\/staff\/clients\/[0-9a-f-]{36}$/);
        createdClientId = page.url().split('/').pop();
        await page.getByText('Synthetic Browser Client').first().waitFor();

        await page.reload({ waitUntil: 'domcontentloaded' });
        const body = page.getByRole('main').last();
        await expect(body).toContainText('Synthetic Browser Client');
        await expect(body).toContainText('Casey Example');
        await expect(body).toContainText('LinkedIn · https://linkedin.com/company/synthetic');
        await expect(page.getByRole('combobox', { name: 'Social link 1 platform' }))
            .toContainText('LinkedIn');
        await expect(page.locator('#social-url-0'))
            .toHaveValue('https://linkedin.com/company/synthetic');
    });

    await t.test('client update keeps social links and confirms the save', async () => {
        await gotoStaff(page, `${baseURL}/staff/clients/${createdClientId}`);
        await fillWhenReady(
            page.locator('#client-name'), 'Synthetic Browser Client Renamed');
        const updated = page.waitForResponse(
            (response) => response.url().includes('/api/staff/clients')
                && response.request().method() === 'POST' && response.ok());
        await page.getByRole('button', { name: 'Save changes' }).click();
        await updated;
        await page.getByRole('status').filter({ hasText: 'Changes saved.' })
            .waitFor();

        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.locator('#client-name'))
            .toHaveValue('Synthetic Browser Client Renamed');
        await expect(page.getByRole('combobox', { name: 'Social link 1 platform' }))
            .toContainText('LinkedIn');
        await expect(page.locator('#social-url-0'))
            .toHaveValue('https://linkedin.com/company/synthetic');
    });

    let createdJobId;
    await t.test('job creation persists rich description and survives reload', async () => {
        await gotoStaff(page, `${baseURL}/staff/jobs/new`);
        await page.locator('#job-client').selectOption(createdClientId);
        await expect(page.locator('#job-public-visibility')).toHaveValue('false');
        await page.locator('#job-public-visibility').selectOption('true');
        await page.locator('#job-title').fill('Synthetic Browser Job');
        await page.locator('#job-employment-type').selectOption('full_time');
        await page.locator('#job-workplace-mode').selectOption('remote');
        await page.locator('#job-locations').fill('Berlin');
        const editor = page.locator('[aria-label="Job description"]');
        await editor.click();
        await expect(async () => {
            if (!(await editor.innerText()).includes('Synthetic job description')) {
                await editor.pressSequentially('Synthetic job description');
            }
            await expect(editor).toContainText('Synthetic job description', { timeout: 1500 });
        }).toPass({ timeout: 30_000 });
        await editor.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+A`);
        await editor.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+B`);
        const jobPosted = page.waitForResponse(
            (response) => response.url().includes('/api/staff/jobs')
                && !response.url().includes('/draft')
                && !response.url().includes('/publish')
                && response.request().method() === 'POST' && response.ok(),
        );
        await page.getByRole('button', { name: 'Create job draft' }).click();
        await jobPosted;
        await page.waitForURL(/\/staff\/jobs\/[0-9a-f-]{36}$/);
        createdJobId = page.url().split('/').pop();
        await page.getByText('Synthetic Browser Job').first().waitFor();

        await page.reload({ waitUntil: 'domcontentloaded' });
        const main = page.getByRole('main').last();
        await main.getByText('Synthetic job description').waitFor();
        assert.match(await main.innerHTML(), /<strong[^>]*>Synthetic job description<\/strong>/);
    });

    await t.test('job edit preserves rich text and adds a bonus through the UI', async () => {
        await gotoStaff(page, `${baseURL}/staff/jobs/${createdJobId}/edit`);
        await fillWhenReady(
            page.locator('#job-title'), 'Synthetic Browser Job Edited');
        await clickUntil(
            () => page.getByRole('button', { name: 'Add bonus' }).click(),
            page.locator('#bonus-details-0'),
        );
        await clickUntil(
            () => page.getByRole('combobox', { name: 'Bonus 1 type' }).click(),
            page.getByRole('listbox'),
        );
        await page.getByRole('option', { name: 'equity' }).click();
        await fillWhenReady(
            page.locator('#bonus-details-0'), 'Synthetic equity bonus');
        const saved = page.waitForResponse(
            (response) => response.url().includes(`/api/staff/jobs/${createdJobId}/draft`)
                && response.request().method() === 'POST' && response.ok());
        await page.getByRole('button', { name: 'Save draft' }).click();
        await saved;
        await page.waitForURL(new RegExp(`/staff/jobs/${createdJobId}$`));
        await page.getByText('Synthetic Browser Job Edited').first().waitFor();

        await gotoStaff(page, `${baseURL}/staff/jobs/${createdJobId}/edit`);
        await expect(page.locator('#job-title'))
            .toHaveValue('Synthetic Browser Job Edited');
        const editor = page.locator('[aria-label="Job description"]');
        await expect(editor).toContainText('Synthetic job description');
        assert.match(
            await editor.innerHTML(),
            /<strong[^>]*>Synthetic job description<\/strong>/,
        );
        await expect(
            page.getByRole('combobox', { name: 'Bonus 1 type' }),
        ).toContainText('equity');
        await expect(page.locator('#bonus-details-0'))
            .toHaveValue('Synthetic equity bonus');
    });

    await t.test('publishing updates metrics, the public board and stays reviewable', async () => {
        await gotoStaff(page, `${baseURL}/staff/jobs/${createdJobId}/edit`);
        await fillWhenReady(page.locator('#job-remote-regions'), 'Worldwide');
        await fillWhenReady(page.locator('#job-comp-min'), '90000.00');
        await fillWhenReady(page.locator('#job-comp-max'), '130000.00');
        await fillWhenReady(page.locator('#job-currency'), 'EUR');
        await page.locator('#job-pay-period').selectOption('year');
        const completed = page.waitForResponse(
            (response) => response.url()
                .includes(`/api/staff/jobs/${createdJobId}/draft`)
                && response.request().method() === 'POST' && response.ok());
        await page.getByRole('button', { name: 'Save draft' }).click();
        await completed;
        await page.waitForURL(new RegExp(`/staff/jobs/${createdJobId}$`));

        await gotoStaff(page, `${baseURL}/staff/jobs/${createdJobId}`);
        await page.getByRole('heading', { name: 'Review before publishing' }).waitFor();
        await page.getByRole('button', { name: 'Publish this revision' }).waitFor();
        const published = page.waitForResponse(
            (response) => response.url()
                .includes(`/api/staff/jobs/${createdJobId}/publish`)
                && response.request().method() === 'POST' && response.ok());
        await page.getByRole('button', { name: 'Publish this revision' }).click();
        await published;
        await page.getByText('Current version').waitFor();
        await page.getByText('Listed', { exact: true }).first().waitFor();
        assert.ok(
            (await publicJobTitles()).includes('Synthetic Browser Job Edited'),
            'published and listed job must appear on the public board',
        );

        await gotoStaff(page, `${baseURL}/staff`);
        await page.getByRole('link', { name: /^Open roles 1$/ }).waitFor();

        await gotoStaff(page, `${baseURL}/staff/jobs/${createdJobId}`);
        let listing = page.waitForResponse(
            (response) => response.url()
                .includes(`/api/staff/jobs/${createdJobId}/listing`)
                && response.request().method() === 'POST' && response.ok());
        await page.getByRole('button', { name: 'Unlist job' }).click();
        await listing;
        await page.getByText('Unlisted', { exact: true }).first().waitFor();
        assert.ok(
            !(await publicJobTitles()).includes('Synthetic Browser Job Edited'),
            'a hidden job must leave the public board',
        );

        await gotoStaff(page, `${baseURL}/staff`);
        await page.getByRole('link', { name: /^Open roles 1$/ }).waitFor();

        await gotoStaff(page, `${baseURL}/staff/jobs/${createdJobId}`);
        listing = page.waitForResponse(
            (response) => response.url()
                .includes(`/api/staff/jobs/${createdJobId}/listing`)
                && response.request().method() === 'POST' && response.ok());
        await page.getByRole('button', { name: 'List job' }).click();
        await listing;
        await page.getByText('Listed', { exact: true }).first().waitFor();
        assert.ok(
            (await publicJobTitles()).includes('Synthetic Browser Job Edited'),
            're-listed job must return to the public board',
        );

        const nextRevision = page.waitForResponse(
            (response) => response.url()
                .includes(`/api/staff/jobs/${createdJobId}/revision`)
                && response.request().method() === 'POST' && response.ok());
        await page.getByRole('button', { name: 'Start new revision' }).click();
        await nextRevision;
        await page.waitForURL(/\/staff\/jobs\/[0-9a-f-]{36}\/edit/);
        await fillWhenReady(
            page.locator('#job-title'), 'Synthetic Browser Job v2');
        const draftSaved = page.waitForResponse(
            (response) => response.url()
                .includes(`/api/staff/jobs/${createdJobId}/draft`)
                && response.request().method() === 'POST' && response.ok());
        await page.getByRole('button', { name: 'Save draft' }).click();
        await draftSaved;
        await page.waitForURL(new RegExp(`/staff/jobs/${createdJobId}$`));
        await page.getByText('Unpublished draft', { exact: true }).first().waitFor();
        await page.getByText('Listed', { exact: true }).first().waitFor();
        const titles = await publicJobTitles();
        assert.ok(
            titles.includes('Synthetic Browser Job Edited')
                && !titles.includes('Synthetic Browser Job v2'),
            'an unpublished draft must not change the public projection',
        );
    });

    let unlistedJobId;
    await t.test('a job created unlisted publishes off the board until listed', async () => {
        await gotoStaff(page, `${baseURL}/staff/jobs/new`);
        await page.locator('#job-client').selectOption(createdClientId);
        await expect(page.locator('#job-public-visibility')).toHaveValue('false');
        await page.screenshot({
            path: join(resultsDir, 'staff-job-create-visibility.png'),
            fullPage: true,
        });
        await page.locator('#job-title').fill('Synthetic Private Role');
        await page.locator('#job-employment-type').selectOption('full_time');
        await page.locator('#job-workplace-mode').selectOption('remote');
        await page.locator('#job-remote-regions').fill('Worldwide');
        await page.locator('#job-comp-min').fill('80000.00');
        await page.locator('#job-comp-max').fill('120000.00');
        await page.locator('#job-currency').fill('USD');
        await page.locator('#job-pay-period').selectOption('year');
        const editor = page.locator('[aria-label="Job description"]');
        await editor.click();
        await expect(async () => {
            if (!(await editor.innerText()).includes('Private role description')) {
                await editor.pressSequentially('Private role description');
            }
            await expect(editor)
                .toContainText('Private role description', { timeout: 1500 });
        }).toPass({ timeout: 30_000 });
        const jobPosted = page.waitForResponse(
            (response) => response.url().includes('/api/staff/jobs')
                && !response.url().includes('/draft')
                && !response.url().includes('/publish')
                && response.request().method() === 'POST' && response.ok(),
        );
        await page.getByRole('button', { name: 'Create job draft' }).click();
        await jobPosted;
        await page.waitForURL(/\/staff\/jobs\/[0-9a-f-]{36}$/);
        unlistedJobId = page.url().split('/').pop();
        await page.getByText('Draft').first().waitFor();
        assert.equal(
            await page.getByText('Unpublished draft').count(), 0,
            'a brand-new draft is not an unpublished draft',
        );
        assert.ok(!(await publicJobTitles()).includes('Synthetic Private Role'));

        await page.getByRole('heading', { name: 'Review before publishing' })
            .waitFor();
        const published = page.waitForResponse(
            (response) => response.url()
                .includes(`/api/staff/jobs/${unlistedJobId}/publish`)
                && response.request().method() === 'POST' && response.ok());
        await page.getByRole('button', { name: 'Publish this revision' }).click();
        await published;
        await page.getByText('Current version').waitFor();
        await page.getByText('Unlisted', { exact: true }).first().waitFor();
        await page.screenshot({
            path: join(resultsDir, 'staff-job-unlisted.png'),
            fullPage: true,
        });
        assert.ok(
            !(await publicJobTitles()).includes('Synthetic Private Role'),
            'a published unlisted job stays off the public board',
        );

        const listing = page.waitForResponse(
            (response) => response.url()
                .includes(`/api/staff/jobs/${unlistedJobId}/listing`)
                && response.request().method() === 'POST' && response.ok());
        await page.getByRole('button', { name: 'List job' }).click();
        await listing;
        await page.getByText('Listed', { exact: true }).first().waitFor();
        await page.screenshot({
            path: join(resultsDir, 'staff-job-listed.png'),
            fullPage: true,
        });
        assert.ok(
            (await publicJobTitles()).includes('Synthetic Private Role'),
            'listing an already-published job puts it on the board',
        );
    });

    let boardPage;
    const boardCard = (title) => boardPage.locator('div.group').filter({
        has: boardPage.getByRole('heading', { name: title, exact: true }),
    });
    const boardListingResponse = () => boardPage.waitForResponse(
        (response) => response.url().includes('/api/public/jobs')
            && response.request().method() === 'GET',
        { timeout: 90_000 },
    );
    const openBoard = async () => {
        const listing = boardListingResponse();
        await boardPage.goto(`${baseURL}/jobs`, { waitUntil: 'domcontentloaded' });
        await listing;
    };
    const focusBoard = async () => {
        const listing = boardListingResponse();
        await boardPage.evaluate(() => window.dispatchEvent(new Event('focus')));
        await listing;
    };
    const withStaleBoard = async (action) => {
        await boardPage.evaluate(() => {
            Object.defineProperty(document, 'visibilityState', {
                configurable: true,
                value: 'hidden',
            });
        });
        try {
            await action();
        } finally {
            await boardPage.evaluate(() => {
                delete document.visibilityState;
            });
        }
    };

    await t.test('the public board revalidates and gates stale actions', async () => {
        const anonymous = await browser.newContext();
        boardPage = await anonymous.newPage();
        boardPage.setDefaultTimeout(90_000);
        await openBoard();
        const card = boardCard('Synthetic Browser Job Edited');
        await card.waitFor();

        const detailFetch = boardListingResponse();
        await card.getByRole('button', { name: 'Learn more' }).click();
        await detailFetch;
        const dialog = boardPage.getByRole('dialog');
        await dialog.waitFor();
        const dialogText = await dialog.innerText();
        assert.match(dialogText, /Role Overview/);
        assert.match(dialogText, /Synthetic job description/);
        assert.match(dialogText, /Posted on \w+ \d{1,2}, \d{4}/);
        assert.ok(!dialogText.includes('Posted 2 days ago'));
        assert.ok(!dialogText.includes('Key Responsibilities'));
        assert.ok(!dialogText.includes('Architect'));
        await dialog.getByRole('button', { name: 'Close' }).click();
        await dialog.waitFor({ state: 'hidden' });

        await withStaleBoard(async () => {
            await gotoStaff(page, `${baseURL}/staff/jobs/${createdJobId}`);
            const listing = page.waitForResponse(
                (response) => response.url()
                    .includes(`/api/staff/jobs/${createdJobId}/listing`)
                    && response.request().method() === 'POST' && response.ok());
            await page.getByRole('button', { name: 'Unlist job' }).click();
            await listing;

            await boardPage.evaluate(() => window.dispatchEvent(new Event('focus')));
            await expect(card).toBeVisible();

            const staleDetailFetch = boardListingResponse();
            await card.getByRole('button', { name: 'Learn more' }).dispatchEvent('click');
            await staleDetailFetch;
            await boardPage
                .getByText('This position is no longer available.').waitFor();
            assert.equal(await boardPage.getByRole('dialog').count(), 0,
                'a stale card must not open the detail modal');
            await expect(card).toHaveCount(0);
        });

        await gotoStaff(page, `${baseURL}/staff/jobs/${createdJobId}`);
        const listing = page.waitForResponse(
            (response) => response.url()
                .includes(`/api/staff/jobs/${createdJobId}/listing`)
                && response.request().method() === 'POST' && response.ok());
        await page.getByRole('button', { name: 'List job' }).click();
        await listing;
        await focusBoard();
        const restored = boardCard('Synthetic Browser Job Edited');
        await restored.waitFor();

        await withStaleBoard(async () => {
            await gotoStaff(page, `${baseURL}/staff/jobs/${createdJobId}`);
            const relisting = page.waitForResponse(
                (response) => response.url()
                    .includes(`/api/staff/jobs/${createdJobId}/listing`)
                    && response.request().method() === 'POST' && response.ok());
            await page.getByRole('button', { name: 'Unlist job' }).click();
            await relisting;

            await boardPage.evaluate(() => window.dispatchEvent(new Event('focus')));
            await expect(restored).toBeVisible();

            const staleApplyFetch = boardListingResponse();
            await restored.getByRole('button', { name: /APPLY/ }).dispatchEvent('click');
            await staleApplyFetch;
            await boardPage
                .getByText('This position is no longer available.').waitFor();
            assert.equal(await boardPage.getByRole('dialog').count(), 0,
                'a stale card must not open the application form');
            await expect(restored).toHaveCount(0);
        });
        assert.equal(await boardPage.evaluate(
            () => Object.prototype.hasOwnProperty.call(document, 'visibilityState'),
        ), false);
    });

    await t.test('an open application keeps entered data when the job vanishes', async () => {
        await gotoStaff(page, `${baseURL}/staff/jobs/${createdJobId}`);
        let listing = page.waitForResponse(
            (response) => response.url()
                .includes(`/api/staff/jobs/${createdJobId}/listing`)
                && response.request().method() === 'POST' && response.ok());
        await page.getByRole('button', { name: 'List job' }).click();
        await listing;

        await focusBoard();
        const card = boardCard('Synthetic Browser Job Edited');
        await card.waitFor();
        const applyFetch = boardListingResponse();
        await card.getByRole('button', { name: /APPLY/ }).click();
        await applyFetch;
        const dialog = boardPage.getByRole('dialog');
        await dialog.waitFor();
        await boardPage.getByLabel('Full name').fill('Ada Lovelace');
        await boardPage.getByLabel('Email address').fill('ada@example.com');
        await boardPage.getByLabel('Upload CV as PDF or DOCX, maximum 4 MB')
            .setInputFiles({
                name: 'ada-cv.pdf',
                mimeType: 'application/pdf',
                buffer: createSyntheticPdf(),
            });
        const submit = dialog.getByRole('button', { name: 'SUBMIT_SIGNAL' });
        await expect(submit).toBeEnabled();

        await gotoStaff(page, `${baseURL}/staff/jobs/${createdJobId}`);
        listing = page.waitForResponse(
            (response) => response.url()
                .includes(`/api/staff/jobs/${createdJobId}/listing`)
                && response.request().method() === 'POST' && response.ok());
        await page.getByRole('button', { name: 'Unlist job' }).click();
        await listing;
        await focusBoard();
        await boardPage
            .getByText('This position is no longer accepting applications.')
            .waitFor();
        await boardPage.screenshot({
            path: join(resultsDir, 'public-job-unavailable-form.png'),
            fullPage: true,
        });
        await expect(boardPage.getByLabel('Full name'))
            .toHaveValue('Ada Lovelace');
        await expect(submit).toBeDisabled();
        await card.waitFor({ state: 'detached' });

        await gotoStaff(page, `${baseURL}/staff/jobs/${createdJobId}`);
        listing = page.waitForResponse(
            (response) => response.url()
                .includes(`/api/staff/jobs/${createdJobId}/listing`)
                && response.request().method() === 'POST' && response.ok());
        await page.getByRole('button', { name: 'List job' }).click();
        await listing;
        await focusBoard();
        await expect(submit).toBeEnabled();
        await expect(boardPage.getByLabel('Full name'))
            .toHaveValue('Ada Lovelace');

        await boardPage.route('**/api/public/jobs', (route) => route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({
                code: 'JOBS_UNAVAILABLE',
                message: 'Job listings are temporarily unavailable.',
            }),
        }));
        try {
            await focusBoard();
            await boardPage
                .getByText('We could not confirm this position is still open.')
                .waitFor();
            await boardPage
                .getByText('Job listings are temporarily unavailable.').waitFor();
            await expect(submit).toBeDisabled();
            await expect(boardPage.getByLabel('Full name'))
                .toHaveValue('Ada Lovelace');
        } finally {
            await boardPage.unroute('**/api/public/jobs');
        }
        await focusBoard();
        await expect(submit).toBeEnabled();
        await dialog.getByRole('button', { name: 'Close application form' }).click();
    });

    await t.test('a hidden job refuses direct submissions with a truthful message', async () => {
        await gotoStaff(page, `${baseURL}/staff/jobs/${createdJobId}`);
        let listing = page.waitForResponse(
            (response) => response.url()
                .includes(`/api/staff/jobs/${createdJobId}/listing`)
                && response.request().method() === 'POST' && response.ok());
        await page.getByRole('button', { name: 'Unlist job' }).click();
        await listing;

        const slug = psql(container, `
            select slug from app.jobs where id = '${createdJobId}'`).trim();
        const result = await boardPage.evaluate(async (jobId) => {
            const form = new FormData();
            form.append('jobId', jobId);
            form.append('fullName', 'Ada Lovelace');
            form.append('email', 'ada@example.com');
            const response = await fetch(
                '/api/submit-signal', { method: 'POST', body: form });
            return { status: response.status, body: await response.json() };
        }, slug);
        assert.equal(result.status, 400);
        assert.equal(result.body.code, 'INVALID_JOB');
        assert.equal(
            result.body.message,
            'This position is no longer accepting applications.',
        );

        await gotoStaff(page, `${baseURL}/staff/jobs/${createdJobId}`);
        listing = page.waitForResponse(
            (response) => response.url()
                .includes(`/api/staff/jobs/${createdJobId}/listing`)
                && response.request().method() === 'POST' && response.ok());
        await page.getByRole('button', { name: 'List job' }).click();
        await listing;
        await page.getByText('Listed', { exact: true }).first().waitFor();
    });

    await t.test('jobs search filters and reset restores the list', async () => {
        await gotoStaff(page, `${baseURL}/staff/jobs`);
        await page.getByText('Synthetic Browser Job').first().waitFor();
        await page.getByText('Legacy Synthetic Job').first().waitFor();
        const search = page.locator('#job-search');
        await fillWhenReady(search, 'Browser');
        await page.getByText('Synthetic Browser Job').first().waitFor();
        assert.equal(
            await page.getByText('Legacy Synthetic Job').count(), 0,
            'search filters out non-matching jobs',
        );
        await fillWhenReady(search, '');
        await page.getByText('Legacy Synthetic Job').first().waitFor();
    });

    await t.test('overview links route to filtered staff lists', async () => {
        await gotoStaff(page, `${baseURL}/staff`);
        await page.getByRole('link', { name: /^Open roles/ }).first().click();
        await page.waitForURL(/\/staff\/jobs\?/);
        const jobsUrl = new URL(page.url());
        assert.equal(jobsUrl.searchParams.get('state'), 'published');
        assert.equal(jobsUrl.searchParams.get('intake'), 'open');
        await gotoStaff(page, `${baseURL}/staff`);
        await page.getByRole('link', { name: /^Candidates \d+$/ }).click();
        await page.waitForURL(/\/staff\/candidates$/);
        await gotoStaff(page, `${baseURL}/staff`);
        await page.locator('#review-queue')
            .getByRole('link', { name: 'Synthetic Candidate B' }).click();
        const preview = page.getByRole('dialog').last();
        await preview.getByText('Synthetic Candidate B').first().waitFor();
        await preview.getByRole('link', { name: 'Open full profile' }).click();
        await page.waitForURL(/\/staff\/candidates\/[0-9a-f-]{36}/);
    });

    await t.test('applications ?review=1 filters to the initial stage', async () => {
        await gotoStaff(page, `${baseURL}/staff/applications?review=1`);
        await page.getByRole('button', { name: 'Awaiting review' }).waitFor();
        assert.equal(
            await page.getByRole('button', { name: 'Awaiting review' })
                .getAttribute('aria-pressed'),
            'true',
        );
        await page.getByText('Synthetic Candidate B').waitFor();
    });

    await t.test('same-path workspace links re-sync filters and history restores them', async () => {
        await gotoStaff(page, `${baseURL}/staff/applications`);
        const reviewToggle = page.getByRole('button', { name: 'Awaiting review' });
        await reviewToggle.waitFor();
        await expect(reviewToggle).toHaveAttribute('aria-pressed', 'false');
        await page.getByText('Synthetic Candidate B').waitFor();

        const bell = page.getByRole('button', { name: /Workspace updates/ });
        await clickUntil(() => bell.click(), page.getByText('Needs attention'));
        await page.getByRole('link', { name: /Applications awaiting review/ }).click();
        await page.waitForURL(/\/staff\/applications\?review=1/);
        await expect(reviewToggle).toHaveAttribute('aria-pressed', 'true');
        await page.getByText('Synthetic Candidate B').waitFor();

        await page.goBack({ waitUntil: 'domcontentloaded' });
        await page.waitForURL(/\/staff\/applications$/);
        await expect(reviewToggle).toHaveAttribute('aria-pressed', 'false');
        await page.goForward({ waitUntil: 'domcontentloaded' });
        await page.waitForURL(/review=1/);
        await expect(reviewToggle).toHaveAttribute('aria-pressed', 'true');
    });

    await t.test('candidate stage select is readable and the transition persists', async () => {
        await gotoStaff(page, `${baseURL}/staff/candidates/${CJ_ID.CANDIDATE_B}`);
        await page.getByRole('tab', { name: /Applications/ }).click();
        await page.waitForURL(/tab=applications/);
        const trigger = page.getByRole('combobox', {
            name: 'Stage for application AG-AAAA00000001',
        });
        await trigger.waitFor();
        const listbox = page.getByRole('listbox');
        await clickUntil(() => trigger.click(), listbox);
        const option = listbox.getByRole('option', { name: 'Interview' });
        const sampled = await sampleContrast(option);
        assert.ok(
            sampled.ratio >= 4.5,
            `stage option contrast ${sampled.ratio} (${sampled.color} on ${sampled.background})`,
        );
        const contentBg = await listbox.evaluate(
            (node) => getComputedStyle(node).backgroundColor);
        assert.match(contentBg, /^rgb\(/, `listbox background should be opaque: ${contentBg}`);
        const stagePosted = page.waitForResponse(
            (response) => response.url().includes('/api/staff/applications')
                && response.request().method() === 'POST' && response.ok(),
        );
        await option.click();
        await stagePosted;
        await page.reload({ waitUntil: 'domcontentloaded' });
        const reloaded = page.getByRole('combobox', {
            name: 'Stage for application AG-AAAA00000001',
        });
        await reloaded.waitFor();
        await expect(reloaded).toContainText('Interview', { timeout: 30_000 });

        await page.goto(`${baseURL}/staff/applications?review=1`,
            { waitUntil: 'domcontentloaded' });
        await page.getByRole('button', { name: 'Awaiting review' }).waitFor();
        assert.equal(
            await page.getByText('Synthetic Candidate B').count(), 0,
            'the moved application drops out of the review filter',
        );

        psql(container, `
            update app.applications set stage_id = '${CJ_ID.STAGE_B_1}'
            where id = '${CJ_ID.APPLICATION_B}'`);
    });

    await t.test('candidate notes save and persist across reload', async () => {
        await gotoStaff(page, `${baseURL}/staff/candidates/${CJ_ID.CANDIDATE_B}?tab=notes`);
        await fillWhenReady(page.locator('#note-body'), 'Synthetic browser note');
        const notePosted = page.waitForResponse(
            (response) => response.url().includes('/api/staff/candidates')
                && response.request().method() === 'POST' && response.ok(),
        );
        await page.getByRole('tabpanel', { name: /Notes/ })
            .getByRole('button', { name: 'Add note' }).click();
        await notePosted;
        await page.getByText('Note added.').waitFor();
        await page.getByText('Synthetic browser note').waitFor();
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.getByText('Synthetic browser note').waitFor();
    });

    await t.test('candidate detail tabs follow the URL query', async () => {
        await gotoStaff(page, `${baseURL}/staff/candidates/${CJ_ID.CANDIDATE_B}`);
        const notesTab = page.getByRole('tab', { name: /Notes/ });
        const documentsTab = page.getByRole('tab', { name: /Documents/ });
        await expect(
            page.getByRole('tab', { name: /Overview/ }),
        ).toHaveAttribute('aria-selected', 'true');

        await documentsTab.click();
        await page.waitForURL(/tab=documents/);
        await expect(documentsTab).toHaveAttribute('aria-selected', 'true');
        await notesTab.click();
        await page.waitForURL(/tab=notes/);
        await expect(notesTab).toHaveAttribute('aria-selected', 'true');

        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle');
        await expect(notesTab).toHaveAttribute('aria-selected', 'true');
        await page.locator('#note-body').waitFor();
    });

    const addedEmail = `browser-add-${randomUUID().slice(0, 8)}@synthetic.test`;
    let addedCandidateId = null;

    await t.test('adding a candidate through the dialog lands on the overview', async () => {
        await gotoStaff(page, `${baseURL}/staff/candidates`);
        await clickUntil(
            () => page.getByRole('button', { name: 'Add candidate' }).first().click(),
            page.getByRole('dialog'));
        const dialog = page.getByRole('dialog');
        await fillWhenReady(
            dialog.locator('#add-candidate-name'), 'Browser Added Candidate');
        await fillWhenReady(
            dialog.locator('#add-candidate-headline'), 'Protocol Engineer');
        await fillWhenReady(
            dialog.locator('#add-candidate-location'), 'Berlin, Germany');
        await fillWhenReady(dialog.locator('#add-candidate-email'), addedEmail);
        await fillWhenReady(
            dialog.locator('#add-candidate-url'), 'https://added.synthetic.test');
        await dialog.locator('#add-candidate-availability').selectOption('open');
        await fillWhenReady(
            dialog.locator('#add-candidate-tags'), 'browser-e2e, priority');
        await fillWhenReady(
            dialog.locator('#add-candidate-skills'), 'typescript; rust');
        await fillWhenReady(
            dialog.locator('#add-candidate-summary'), 'Synthetic profile summary.');
        const noteField = dialog.locator('#add-candidate-note');
        if ((await noteField.count()) > 0) {
            await fillWhenReady(noteField, 'Added during browser coverage.');
        }
        const posted = page.waitForResponse(
            (response) => response.url().includes('/api/staff/candidates')
                && !response.url().includes('/import')
                && response.request().method() === 'POST' && response.ok());
        await dialog.getByRole('button', { name: 'Add candidate' }).click();
        await posted;
        await page.waitForURL(/\/staff\/candidates\/[0-9a-f-]{36}$/);
        addedCandidateId = page.url().split('/').pop();
        await page.getByText('Browser Added Candidate').first().waitFor();
        await page.getByText('Synthetic profile summary.').waitFor();
        await page.getByText('browser-e2e').first().waitFor();

        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.getByText('Browser Added Candidate').first().waitFor();
        await page.getByText(addedEmail).first().waitFor();
    });

    await t.test('the add dialog blocks invalid CV files before submission', async () => {
        await gotoStaff(page, `${baseURL}/staff/candidates`);
        await clickUntil(
            () => page.getByRole('button', { name: 'Add candidate' }).first().click(),
            page.getByRole('dialog'));
        const dialog = page.getByRole('dialog');
        await fillWhenReady(
            dialog.locator('#add-candidate-name'), 'File Guard Candidate');
        await dialog.locator('#add-candidate-cv').setInputFiles({
            name: 'notes.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('not a cv'),
        });
        await dialog.getByRole('alert').waitFor();
        const submit = dialog.getByRole('button', { name: 'Add candidate' });
        await expect(submit).toBeDisabled();
        await dialog.locator('#add-candidate-cv').setInputFiles([]);
        await expect(submit).toBeEnabled();
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();
    });

    await t.test('a duplicate email offers the existing record', async () => {
        await gotoStaff(page, `${baseURL}/staff/candidates`);
        await clickUntil(
            () => page.getByRole('button', { name: 'Add candidate' }).first().click(),
            page.getByRole('dialog'));
        const dialog = page.getByRole('dialog');
        await fillWhenReady(
            dialog.locator('#add-candidate-name'), 'Browser Added Candidate');
        await fillWhenReady(dialog.locator('#add-candidate-email'), addedEmail);
        const conflicted = page.waitForResponse(
            (response) => response.url().includes('/api/staff/candidates')
                && !response.url().includes('/import')
                && response.request().method() === 'POST'
                && response.status() === 409);
        await dialog.getByRole('button', { name: 'Add candidate' }).click();
        await conflicted;
        await page.getByText('A candidate with this email already exists.').waitFor();
        await page.getByRole('button', { name: 'View existing candidate' }).click();
        await page.waitForURL(`**/staff/candidates/${addedCandidateId}`);
        await page.getByText('Browser Added Candidate').first().waitFor();
    });

    await t.test('a candidate can be added to a job from the dialog', async () => {
        await gotoStaff(page, `${baseURL}/staff/candidates`);
        await clickUntil(
            () => page.getByRole('button', { name: 'Add candidate' }).first().click(),
            page.getByRole('dialog'));
        const dialog = page.getByRole('dialog');
        await fillWhenReady(
            dialog.locator('#add-candidate-name'), 'Applicant Via Job');
        await dialog.locator('#add-candidate-job').selectOption(unlistedJobId);
        const posted = page.waitForResponse(
            (response) => response.url().includes('/api/staff/candidates')
                && !response.url().includes('/import')
                && response.request().method() === 'POST' && response.ok());
        await dialog.getByRole('button', { name: 'Add candidate' }).click();
        await posted;
        await page.waitForURL(/\/staff\/candidates\/[0-9a-f-]{36}$/);
        const candidateId = page.url().split('/').pop();
        const count = psql(container, `
            select count(*)::text from app.applications
            where organization_id = '${ORG_ID}'
                and candidate_id = '${candidateId}'
                and job_id = '${unlistedJobId}'`).trim();
        assert.equal(count, '1', 'the selected job received one application');
        await page.getByRole('tab', { name: /Applications/ }).click();
        await page.waitForURL(/tab=applications/);
        await page.getByText('Synthetic Private Role').first().waitFor();
    });

    await t.test('the candidate drawer previews detail and opens the full record', async () => {
        await gotoStaff(page, `${baseURL}/staff/candidates`);
        const link = page.getByRole('link', {
            name: 'Browser Added Candidate',
        }).first();
        await link.click();
        const sheet = page.getByRole('dialog').last();
        await sheet.getByText('Browser Added Candidate').first().waitFor();
        assert.match(
            page.url(), /\/staff\/candidates$/,
            'the drawer must not navigate away from the list',
        );
        await page.keyboard.press('Escape');
        await expect(sheet).toBeHidden();
        await link.click();
        await sheet.getByText('Browser Added Candidate').first().waitFor();
        await sheet.getByRole('link', { name: 'Open full profile' }).click();
        await page.waitForURL(`**/staff/candidates/${addedCandidateId}`);
        await page.getByText('Browser Added Candidate').first().waitFor();
    });

    let duplicatedJobId = null;

    await t.test('duplicating a job through the UI creates a separate draft', async () => {
        const jobsBefore = Number(psql(container, `
            select count(*)::text from app.jobs
            where organization_id = '${ORG_ID}'`).trim());
        await gotoStaff(page, `${baseURL}/staff/jobs/${createdJobId}`);
        const duplicated = page.waitForResponse(
            (response) => response.url()
                .includes(`/api/staff/jobs/${createdJobId}/duplicate`)
                && response.request().method() === 'POST' && response.ok());
        await page.getByRole('button', { name: 'Duplicate job' }).click();
        await duplicated;
        await page.waitForURL(/\/staff\/jobs\/[0-9a-f-]{36}\/edit$/);
        duplicatedJobId = page.url().split('/').at(-2);
        assert.notEqual(
            duplicatedJobId, createdJobId,
            'the duplicate must be a new job, not the source',
        );
        const sourceTitle = psql(container, `
            select r.title from app.jobs j
            join app.job_revisions r
                on r.organization_id = j.organization_id
                and r.job_id = j.id
            where j.id = '${createdJobId}' and r.status = 'draft'`).trim();
        await expect(page.locator('#job-title')).toHaveValue(sourceTitle);
        await expect(
            page.getByRole('combobox', { name: 'Bonus 1 type' }),
        ).toContainText('equity');
        const jobsAfter = Number(psql(container, `
            select count(*)::text from app.jobs
            where organization_id = '${ORG_ID}'`).trim());
        assert.equal(
            jobsAfter, jobsBefore + 1,
            'duplicating adds exactly one job; the source remains',
        );
        const state = psql(container, `
            select publication_state, publicly_listed::text from app.jobs
            where organization_id = '${ORG_ID}' and id = '${duplicatedJobId}'`).trim();
        assert.match(state, /^draft\|/, 'the duplicate starts as a draft');
        assert.ok(
            !(await publicJobTitles()).includes('Synthetic Browser Job v2'),
            'a draft duplicate must not appear on the public board',
        );
    });

    await t.test('unsaved job edits warn on navigation and can be discarded', async () => {
        await gotoStaff(
            page, `${baseURL}/staff/jobs/${duplicatedJobId}/edit`);
        await fillWhenReady(
            page.locator('#job-title'), 'Duplicated Job dirty');
        await page.getByRole('link', { name: 'Overview', exact: true }).first()
            .click();
        await page.getByText('unsaved changes').first().waitFor();
        await page.getByRole('button', { name: 'Stay' }).click();
        assert.match(page.url(), /\/staff\/jobs\/.*\/edit$/);
        await page.getByRole('link', { name: 'Overview', exact: true }).first()
            .click();
        await page.getByText('unsaved changes').first().waitFor();
        await page.getByRole('button', { name: 'Discard and continue' }).click();
        await page.waitForURL(/\/staff$/);
    });

    await t.test('CSV import reviews, skips invalid rows and commits selected', async () => {
        const importedEmail =
            `imported-one-${randomUUID().slice(0, 8)}@synthetic.test`;
        const possibleEmail =
            `possible-${randomUUID().slice(0, 8)}@synthetic.test`;
        const csv = [
            'name,email,role,location,notes',
            `Imported One,${importedEmail},Engineer,Lisbon,first import note`,
            `Browser Added Candidate,${addedEmail},Engineer,,`,
            `,${possibleEmail},,,`,
            `Browser Added Candidate,${`pm-${randomUUID().slice(0, 8)}@synthetic.test`},,,`,
        ].join('\n');
        await gotoStaff(page, `${baseURL}/staff/candidates/import`);
        await page.locator('[data-testid="import-file-input"]').setInputFiles({
            name: 'candidates.csv',
            mimeType: 'text/csv',
            buffer: Buffer.from(csv, 'utf8'),
        });
        await page.getByRole('heading', { name: 'Map columns' }).waitFor();
        await expect(page.locator('#map-fullName')).toHaveValue('0');
        await expect(page.locator('#map-email')).toHaveValue('1');
        const reviewed = page.waitForResponse(
            (response) => response.url().includes('/api/staff/candidates/import')
                && response.request().method() === 'POST' && response.ok());
        await page.getByRole('button', { name: 'Review import' }).click();
        const reviewResponse = await reviewed;
        await expect(page.getByRole('heading', { name: 'Review rows' }))
            .toBeVisible({ timeout: 15_000 }).catch(async (error) => {
                t.diagnostic(JSON.stringify({
                    review: await reviewResponse.json(),
                    page: await page.getByRole('main').last().innerText(),
                }));
                throw error;
            });
        await page.getByText('invalid').first().waitFor();
        await expect(
            page.getByRole('checkbox', { name: 'Include row 3' }),
        ).toBeDisabled();
        await expect(
            page.getByRole('checkbox', { name: 'Include row 4' }),
        ).toBeDisabled();
        const importButton = page.getByRole('button', {
            name: /Import \d+ candidate/,
        });
        await expect(importButton).toBeDisabled();
        await page.locator('#import-confirm').click();
        await expect(importButton).toBeEnabled();
        const possibleRow = page.getByRole('checkbox', { name: 'Include row 5' });
        if (await possibleRow.isEnabled() && !(await possibleRow.isChecked())) {
            await possibleRow.click();
        }
        const committed = page.waitForResponse(
            (response) => response.url().includes('/api/staff/candidates/import')
                && response.request().method() === 'POST' && response.ok());
        await importButton.click();
        await committed;
        await page.getByRole('heading', { name: 'Import complete' }).waitFor();
        await page.getByText('Added').first().waitFor();
        const imported = psql(container, `
            select count(*)::text from app.candidate_identifiers
            where organization_id = '${ORG_ID}'
                and kind = 'email'
                and normalized_value = '${importedEmail}'`).trim();
        assert.equal(imported, '1', 'the ready row was imported once');
    });

    await t.test('applications stage cards clear the review-only filter', async () => {
        await gotoStaff(page, `${baseURL}/staff/applications?review=1`);
        await page.getByText('Synthetic Candidate B').waitFor();
        const cards = page.getByRole('group', { name: 'Stage filter cards' });
        const interview = cards.getByRole('button', { name: /Interview/ });
        await interview.click();
        await page.waitForURL((url) => !url.searchParams.has('review'));
        await page.waitForURL((url) => url.searchParams.get('stage') === 'interview');
        assert.equal(
            await page.getByText('Synthetic Candidate B').count(), 0,
            'the review-stage application is not under Interview',
        );
        await cards.getByRole('button', { name: /All applications/ }).click();
        await page.waitForURL((url) => url.searchParams.get('stage') === null
            && !url.searchParams.has('review'));
        await page.getByText('Synthetic Candidate B').waitFor();
    });

    await t.test('privacy cases show real statuses and audit events', async () => {
        await gotoStaff(page, `${baseURL}/staff/privacy`);
        await page.getByRole('heading', {
            name: /privacy|data requests/i,
        }).first().waitFor();
        await page.getByText('Access request').first().waitFor();
        await page.getByText('In progress').first().waitFor();
        await page.getByText('Request received').first().waitFor();
        await page.getByText('Identity verified').first().waitFor();
        await page.getByRole('button', {
            name: 'View reviewed records',
        }).waitFor();
    });

    await t.test('privacy denies members without privacy.manage', async () => {
        const context = await browser.newContext({
            viewport: { width: 1440, height: 1000 },
        });
        try {
            await context.addCookies(recruiterCookies);
            const recruiter = await context.newPage();
            recruiter.setDefaultTimeout(90_000);
            await gotoStaff(recruiter, `${baseURL}/staff/privacy`);
            await recruiter.getByText(/privacy\.manage permission/).waitFor();
            assert.equal(
                await recruiter.getByRole('link', {
                    name: /Privacy|Data requests/,
                }).count(),
                0,
                'the privacy nav entry is hidden without privacy.manage',
            );
        } finally {
            await context.close();
        }
    });

    await t.test('the mobile viewport keeps the candidate overview usable', async () => {
        const mobile = await browser.newContext({
            viewport: { width: 390, height: 844 },
        });
        try {
            await mobile.addCookies(staffCookies);
            const mPage = await mobile.newPage();
            mPage.setDefaultTimeout(90_000);
            await gotoStaff(
                mPage, `${baseURL}/staff/candidates/${addedCandidateId}`);
            await mPage.getByText('Browser Added Candidate').first().waitFor();
            await mPage.getByRole('tab', { name: /Overview/ }).waitFor();
            await mPage.getByRole('tab', { name: /Applications/ }).waitFor();
            const overflow = await mPage.evaluate(
                () => document.documentElement.scrollWidth
                    - document.documentElement.clientWidth);
            assert.ok(
                overflow <= 1,
                `horizontal overflow on mobile overview: ${overflow}px`,
            );
            await gotoStaff(mPage, `${baseURL}/staff/candidates`);
            await mPage.getByRole('link', {
                name: 'Browser Added Candidate',
            }).first().click();
            const sheet = mPage.getByRole('dialog').last();
            await sheet.getByText('Browser Added Candidate').first().waitFor();
            await mPage.keyboard.press('Escape');
        } finally {
            await mobile.close();
        }
    });

    await t.test('member invitation records locally without claiming email delivery', async () => {
        await gotoStaff(page, `${baseURL}/staff/members`);
        await page.locator('#invite-name').fill('Invited Synthetic');
        await page.locator('#invite-email').fill('invited@synthetic.test');
        await page.locator('#invite-role').selectOption({ index: 1 });
        const invited = page.waitForResponse(
            (response) => response.url().includes('/api/staff/members')
                && response.request().method() === 'POST' && response.ok(),
        );
        await page.getByRole('button', { name: 'Record invitation' }).click();
        await invited;
        await page.getByText(/Invitation recorded/).waitFor();
        await page.getByText('Invited Synthetic').waitFor();
        const directory = await page.getByRole('main').last().innerText();
        assert.doesNotMatch(directory, /email sent|invitation sent/i);
    });

    await t.test('the pending-invites bell entry filters the member directory', async () => {
        await gotoStaff(page, `${baseURL}/staff/members`);
        const statusTrigger = page.getByRole('combobox', {
            name: 'Filter members by status',
        });
        await expect(statusTrigger).toContainText('All statuses');
        const bell = page.getByRole('button', { name: /Workspace updates/ });
        await clickUntil(() => bell.click(), page.getByText('Needs attention'));
        await page.getByRole('link', { name: /Pending invites/ }).click();
        await page.waitForURL(/\/staff\/members\?status=invited/);
        await expect(statusTrigger).toContainText('Invited');
        await page.getByText('Invited Synthetic').waitFor();
    });

    await t.test('staff APIs enforce session, MFA, permission and input gates', async () => {
        const admin = cookieHeader(staffCookies);
        const sessionOnly = cookieHeader(sessionOnlyCookies);
        const recruiter = cookieHeader(recruiterCookies);
        const post = { 'content-type': 'application/json' };
        const cases = [
            ['GET', '/api/staff/workspace', null, null, 401],
            ['GET', '/api/staff/tasks', null, null, 401],
            ['GET', '/api/staff/workspace', null, sessionOnly, 428],
            ['GET', '/api/staff/tasks', null, sessionOnly, 428],
            ['GET', '/api/staff/tasks', null, recruiter, 403],
            ['POST', '/api/staff/tasks', {
                action: 'create',
                taskId: randomUUID(),
                title: 'Recruiter task',
                category: 'notes',
            }, recruiter, 403],
            ['GET', '/api/staff/tasks?completed=maybe', null, admin, 400],
            ['GET', '/api/staff/tasks?category=bogus', null, admin, 400],
            ['GET', '/api/staff/tasks?offset=-1', null, admin, 400],
            ['GET', '/api/staff/tasks?limit=0', null, admin, 400],
            ['POST', '/api/staff/tasks', { action: 'bogus' }, admin, 400],
            ['POST', '/api/staff/tasks', {
                action: 'create',
                taskId: randomUUID(),
                title: 'Unexpected key',
                category: 'notes',
                unexpected: true,
            }, admin, 400],
            ['POST', '/api/staff/tasks', {
                action: 'create',
                taskId: 'not-a-uuid',
                title: 'Bad id',
                category: 'notes',
            }, admin, 400],
        ];
        for (const [method, path, body, cookie, expected] of cases) {
            const response = await fetch(`${baseURL}${path}`, {
                method,
                headers: {
                    ...(cookie ? { cookie } : {}),
                    ...(body ? post : {}),
                },
                body: body ? JSON.stringify(body) : undefined,
            });
            assert.equal(
                response.status, expected,
                `${method} ${path} should return ${expected}, got ${response.status}`,
            );
            assert.match(
                response.headers.get('cache-control') ?? '',
                /private|no-store/,
                `${method} ${path} must carry private no-store headers`,
            );
        }
    });

    await t.test('members without manage or collaboration permissions see read-only surfaces', async () => {
        const context = await browser.newContext({
            viewport: { width: 1440, height: 1000 },
        });
        try {
            await context.addCookies(recruiterCookies);
            const recruiter = await context.newPage();
            recruiter.setDefaultTimeout(90_000);
            await gotoStaff(recruiter, `${baseURL}/staff`);
            await recruiter.getByRole('heading', { name: 'Overview', level: 1 })
                .waitFor();
            await recruiter.getByText(
                'Task tracking requires the collaboration.read permission.',
            ).waitFor();
            assert.equal(
                await recruiter.getByRole('link', { name: 'Members', exact: true })
                    .count(),
                0,
                'the members nav entry is hidden without staff.manage',
            );
            const bell = recruiter.getByRole('button', { name: /Workspace updates/ });
            await clickUntil(
                () => bell.click(),
                recruiter.getByText('Needs attention'),
            );
            assert.equal(
                await recruiter.getByRole('link', { name: /Pending invites/ })
                    .count(),
                0,
                'pending invites must not be visible without staff.manage',
            );
            await recruiter.keyboard.press('Escape');

            await gotoStaff(recruiter, `${baseURL}/staff/members`);
            await recruiter.getByText(
                /staff\.manage permission/,
            ).waitFor();
        } finally {
            await context.close();
        }
    });

    await t.test('staff text meets contrast requirements and overlays are opaque', async () => {
        await page.goto(`${baseURL}/staff`, { waitUntil: 'domcontentloaded' });
        await page.getByRole('heading', { name: 'Overview', level: 1 }).waitFor();
        for (const [label, locator] of [
            ['h1', page.getByRole('heading', { name: 'Overview', level: 1 })],
            ['metric card label', page.getByText('Candidates').first()],
            ['todo body text', page.locator('#tasks').getByText(/Doomed task title|Batch task/).first()],
        ]) {
            const sampled = await sampleContrast(locator);
            assert.ok(
                sampled.ratio >= 4.5,
                `${label} contrast ${sampled.ratio.toFixed(2)} (${sampled.color} on ${sampled.background})`,
            );
        }

        await page.goto(`${baseURL}/staff/members`, { waitUntil: 'domcontentloaded' });
        const cell = page.locator('td').first();
        await cell.waitFor();
        const cellSample = await sampleContrast(cell);
        assert.ok(cellSample.ratio >= 4.5, `table cell contrast ${cellSample.ratio.toFixed(2)}`);
        const input = page.locator('#invite-name');
        const inputSample = await sampleContrast(input);
        assert.ok(inputSample.ratio >= 4.5, `input contrast ${inputSample.ratio.toFixed(2)}`);

        await gotoStaff(page, `${baseURL}/staff`);
        const bell = page.getByRole('button', { name: /Workspace updates/ });
        const popoverTitle = page.getByText('Needs attention');
        await clickUntil(() => bell.click(), popoverTitle);
        const popoverSample = await sampleContrast(popoverTitle);
        assert.match(
            popoverSample.background, /^rgb\(/,
            `popover background should be opaque: ${popoverSample.background}`,
        );
        assert.ok(
            popoverSample.ratio >= 4.5,
            `popover label contrast ${popoverSample.ratio.toFixed(2)}`,
        );
        await page.keyboard.press('Escape');
    });

    await t.test('desktop screenshots', async () => {
        for (const [name, url] of [
            ['overview', '/staff'],
            ['jobs', '/staff/jobs'],
            ['members', '/staff/members'],
        ]) {
            await page.goto(`${baseURL}${url}`, { waitUntil: 'domcontentloaded' });
            await page.waitForLoadState('networkidle');
            await page.screenshot({
                path: join(resultsDir, `staff-workspace-${name}.png`),
                fullPage: true,
            });
        }
    });

    await t.test('public jobs page keeps the dark public theme without staff chrome', async () => {
        await page.goto(`${baseURL}/jobs`, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle');
        assert.equal(await page.locator('.staff-scope').count(), 0);
        assert.equal(await page.getByText('Staff workspace').count(), 0);
        const background = await page.locator('body').evaluate(
            (node) => getComputedStyle(node).backgroundColor);
        const { r, g, b } = (() => {
            const parts = background.match(/[\d.]+/g).map(Number);
            return { r: parts[0], g: parts[1], b: parts[2] };
        })();
        const luminance = relativeLuminance({ r, g, b });
        assert.ok(luminance < 0.3, `public jobs background should stay dark, got ${background}`);
    });

    await t.test('missing MFA redirects to verification', async () => {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        try {
            await context.addCookies(sessionOnlyCookies);
            const pending = await context.newPage();
            const response = await pending.goto(`${baseURL}/staff`, { waitUntil: 'domcontentloaded' });
            await expect(pending).toHaveURL(/\/staff\/mfa\/verify/);
            assert.ok(response === null || response.status() < 400);
        } finally {
            await context.close();
        }
    });

    await t.test('mobile sheet exposes navigation and sign-out', async () => {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
        try {
            await context.addCookies(staffCookies);
            const mobile = await context.newPage();
            mobile.setDefaultTimeout(90_000);
            const horizontalOverflow = () => mobile.evaluate(
                () => document.documentElement.scrollWidth
                    - document.documentElement.clientWidth,
            );
            await gotoStaff(mobile, `${baseURL}/staff`);
            await mobile.getByRole('heading', { name: 'Overview', level: 1 }).waitFor();
            await mobile.getByRole('heading', { name: 'Clients hiring' }).waitFor();
            await mobile.getByRole('link', {
                name: /Synthetic Browser Client Renamed/,
            }).first().waitFor();
            await mobile.getByRole('link', {
                name: 'Synthetic Candidate B',
            }).first().waitFor();
            assert.equal(
                await horizontalOverflow(), 0,
                'the populated overview must not overflow a 390px viewport',
            );

            const sheet = mobile.getByRole('dialog');
            await clickUntil(
                () => mobile.getByRole('button', { name: 'Open navigation' }).click(),
                sheet,
            );
            await sheet.getByRole('link', { name: 'Jobs' }).waitFor();
            await sheet.getByRole('button', { name: 'Sign out' }).waitFor();
            await mobile.screenshot({ path: join(resultsDir, 'staff-workspace-mobile-sheet.png') });
            await sheet.getByRole('link', { name: 'Jobs' }).click();
            await mobile.waitForURL(/\/staff\/jobs/);
            await mobile.getByRole('heading', { name: 'Jobs', level: 1 }).waitFor();

            for (const formUrl of ['/staff/clients/new', '/staff/jobs/new']) {
                await gotoStaff(mobile, `${baseURL}${formUrl}`);
                assert.equal(
                    await horizontalOverflow(), 0,
                    `${formUrl} must not overflow a 390px viewport`,
                );
            }
        } finally {
            await context.close();
        }
    });

    await t.test('a summary outage keeps navigation and protected pages reachable', async () => {
        psql(container, `
            alter function app.get_staff_workspace_v1()
                rename to get_staff_workspace_outage_test;
        `);
        try {
            const summaryOutage = page.waitForResponse(
                (response) => response.url().includes('/api/staff/workspace')
                    && response.request().method() === 'GET',
                { timeout: 90_000 },
            );
            await page.goto(`${baseURL}/staff`, { waitUntil: 'domcontentloaded' });
            await summaryOutage;
            await page.getByText('Workspace summary is temporarily unavailable.')
                .waitFor();
            const nav = page.getByRole('navigation', { name: 'Main navigation' });
            for (const name of [
                'Overview', 'Applications', 'Candidates', 'Jobs', 'Clients', 'Members',
            ]) {
                await nav.getByRole('link', { name, exact: true }).waitFor();
            }
            await nav.getByRole('link', { name: 'Jobs', exact: true }).click();
            await page.getByRole('heading', { name: 'Jobs', level: 1 }).waitFor();
            await page.getByRole('link', { name: 'Legacy Synthetic Job' })
                .first().waitFor();

            const context = await browser.newContext({
                viewport: { width: 390, height: 844 },
            });
            try {
                await context.addCookies(staffCookies);
                const mobile = await context.newPage();
                mobile.setDefaultTimeout(90_000);
                await mobile.goto(`${baseURL}/staff`, { waitUntil: 'domcontentloaded' });
                await mobile.getByText('Workspace summary is temporarily unavailable.')
                    .waitFor();
                const sheet = mobile.getByRole('dialog');
                await clickUntil(
                    () => mobile.getByRole('button', { name: 'Open navigation' }).click(),
                    sheet,
                );
                for (const name of [
                    'Overview', 'Applications', 'Candidates', 'Jobs', 'Clients',
                    'Members',
                ]) {
                    await sheet.getByRole('link', { name, exact: true }).waitFor();
                }
                await sheet.getByRole('link', { name: 'Jobs', exact: true }).click();
                await mobile.waitForURL(/\/staff\/jobs/);
                await mobile.getByRole('heading', { name: 'Jobs', level: 1 })
                    .waitFor();
            } finally {
                await context.close();
            }
        } finally {
            psql(container, `
                alter function app.get_staff_workspace_outage_test()
                    rename to get_staff_workspace_v1;
            `);
        }
        await gotoStaff(page, `${baseURL}/staff`);
        await page.getByRole('link', { name: /^Candidates \d+$/ }).waitFor();
    });

    await t.test('revoked membership loses staff access', async () => {
        psql(container, `
            update app.organization_memberships
            set status = 'revoked', revoked_at = now()
            where id = '${AUTHZ_ID.MEMBER_B_ADMIN}'
        `);
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        try {
            await context.addCookies(staffCookies);
            const denied = await context.newPage();
            await denied.goto(`${baseURL}/staff`, { waitUntil: 'domcontentloaded' });
            await expect(denied).toHaveURL(/\/staff\/(no-access|sign-in)/);
        } finally {
            await context.close();
        }
    });
});
