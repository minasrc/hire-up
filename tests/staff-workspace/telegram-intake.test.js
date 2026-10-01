import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import {
    POSTGRES_17_IMAGE, assertLocalTestEnvironment, findFreePort, psql,
    publishedPort, startPostgresContainer, stopAndRemoveContainer,
} from '../support/foundation-docker.js';
import {
    AUTHZ_ID, GOOGLE_MIGRATION, INVITES_MIGRATION, INVITE_DOMAINS_MIGRATION,
    installStaffFixture,
} from '../support/staff-authorization.js';
import { PRIVACY_MIGRATIONS } from '../support/privacy-foundation.js';
import { PRIVACY_OPS_MIGRATION } from '../support/privacy-operations.js';
import { WORKFLOW_MIGRATION, clientJobFixtureSql } from '../support/client-job-workflows.js';
import { STAFF_MFA_COOKIE, createStaffMfaProof } from '../../src/lib/staff-mfa-cookie.js';
import { createSyntheticPdf } from '../support/cv-fixtures.js';

// An integration checkout can be supplied while UI and API work are on separate branches.
// The application still receives only synthetic credentials and a disposable local database.
const root = resolve(process.env.TELEGRAM_INTAKE_TEST_ROOT || fileURLToPath(new URL('../../', import.meta.url)));
const migrations = [
    '20260922090000_foundation_roles.sql', '20260922090100_foundation_schema.sql',
    '20260922090200_foundation_seed.sql', '20260922130000_staff_authorization_core.sql',
    GOOGLE_MIGRATION, ...PRIVACY_MIGRATIONS, PRIVACY_OPS_MIGRATION, WORKFLOW_MIGRATION,
    '20260925100000_staff_totp.sql', '20260925110000_staff_listing.sql',
    INVITES_MIGRATION, INVITE_DOMAINS_MIGRATION,
    '20260925140000_application_pipeline.sql', '20260926140000_public_intake.sql',
    '20260928100000_staff_workspace.sql', '20260928220000_job_visibility.sql',
    '20260930090000_candidate_profiles.sql', '20260930090100_candidate_intake_serialization.sql',
    '20261001090000_public_intake_duplicate_review.sql', '20261001100000_candidate_merge.sql',
    '20261002100000_candidate_upload.sql', '20261002110000_staff_shell_capabilities.sql',
    '20261002120000_staff_list_pagination.sql', '20261002130000_telegram_intake_foundation.sql',
    ...readdirSync(join(root, 'supabase/migrations')).filter(name => name > '20261002130000_telegram_intake_foundation.sql' && name.endsWith('.sql')).sort(),
];

async function waitForServer(url) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) }).catch(() => null);
        if (response?.ok) return;
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Temporary Telegram intake server did not start');
}

test('private intake reviews real drafts, preserves conflicting edits, validates CVs and approves', { timeout: 240_000 }, async (t) => {
    assertLocalTestEnvironment();
    const db = await startPostgresContainer('pgtelegramui', POSTGRES_17_IMAGE, { publish: true });
    t.after(() => stopAndRemoveContainer(db));
    for (const name of migrations) psql(db, readFileSync(join(root, 'supabase', 'migrations', name), 'utf8'));
    const runtimePassword = installStaffFixture(db);
    psql(db, clientJobFixtureSql);
    const secret = 'synthetic-telegram-intake-test-secret';
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
            STAFF_ORGANIZATION_ID: AUTHZ_ID.ORG_B, NEXTAUTH_URL: baseURL, NEXTAUTH_SECRET: secret,
            GOOGLE_CLIENT_ID: 'synthetic-workspace-client', GOOGLE_CLIENT_SECRET: 'synthetic-workspace-client-secret',
            TELEGRAM_INTAKE_ENABLED: '1', NEXT_PUBLIC_SUPABASE_URL: storageURL, SUPABASE_SERVICE_ROLE_KEY: storageKey,
            GITHUB_ID: '', GITHUB_SECRET: '',
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
    const api = `${baseURL}/api/staff/telegram-intake/drafts`;
    async function createDraft(fields) {
        const response = await context.request.post(api, { data: { fields, sourceTitle: 'Synthetic Telegram source' } });
        assert.equal(response.status(), 201, await response.text());
        return (await response.json()).result;
    }
    const ready = await createDraft({ firstName: 'Ready', lastName: 'Candidate', primaryEmail: 'ready-telegram@example.test' });
    const incomplete = await createDraft({ firstName: 'Incomplete' });
    // One ready draft is seeded for the initial view. The second draft below exercises
    // an actual upload/sign/approval round trip against the bounded local storage adapter.
    const objectId = randomUUID();
    const evidenceId = randomUUID();
    psql(db, `update app.telegram_drafts set document=jsonb_build_object(
        'filename','Synthetic-CV.pdf','sha256',repeat('a',64),'sizeBytes',256,
        'extension','pdf','mimeType','application/pdf',
        'objectKey','staff/'||organization_id||'/'||candidate_target_id||'/${objectId}.pdf')
        where id='${ready.id}';
        insert into app.telegram_evidence(id,organization_id,owner_user_id,source_key,text,sender_name,sent_at)
        values('${evidenceId}','${AUTHZ_ID.ORG_B}','${AUTHZ_ID.USER_ADMIN2}','synthetic-message','Private evidence sentinel','Synthetic sender',now());
        insert into app.telegram_draft_evidence(organization_id,owner_user_id,draft_id,evidence_id)
        values('${AUTHZ_ID.ORG_B}','${AUTHZ_ID.USER_ADMIN2}','${ready.id}','${evidenceId}');`);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    try {
        await page.goto(`${baseURL}/staff/telegram-intake`);
        await expect(page.getByRole('heading', { name: 'Telegram intake', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: /^Ready \d/ })).toHaveAttribute('aria-pressed', 'true');
        await expect(page.getByRole('button', { name: 'Ready Candidate', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Incomplete', exact: true })).toHaveCount(0);
        await expect(page.getByText('Private evidence sentinel', { exact: true })).toHaveCount(0);

        await page.getByRole('button', { name: /^Needs information \d/ }).click();
        await page.getByLabel('Missing information', { exact: true }).selectOption('lastName');
        await page.getByRole('button', { name: 'Incomplete', exact: true }).click();
        const panel = page.getByRole('dialog', { name: 'Review draft' });
        await expect(panel.getByLabel('First name *', { exact: true })).toHaveValue('Incomplete');
        let response = page.waitForResponse(response => response.url() === `${api}/${incomplete.id}/decision`);
        await panel.getByRole('button', { name: 'Approve candidate', exact: true }).click();
        assert.equal((await response).status(), 422);
        for (const label of ['Last name', 'Primary email', 'CV']) {
            await expect(panel.getByRole('link', { name: new RegExp(`^${label}:`) })).toBeVisible();
        }

        await panel.getByLabel('First name *', { exact: true }).fill('My unsaved edit');
        const competingEdit = await context.request.patch(`${api}/${incomplete.id}`, { data: { expectedVersion: incomplete.version, fields: { firstName: 'External update' } } });
        assert.equal(competingEdit.status(), 200, await competingEdit.text());
        response = page.waitForResponse(response => response.url() === `${api}/${incomplete.id}` && response.request().method() === 'PATCH');
        await panel.getByRole('button', { name: 'Save changes', exact: true }).click();
        assert.equal((await response).status(), 409);
        await expect(panel.getByText(/Your edits are preserved/)).toBeVisible();
        await expect(panel.getByLabel('First name *', { exact: true })).toHaveValue('My unsaved edit');
        await panel.getByRole('button', { name: 'Refresh draft (replace my edits)', exact: true }).click();
        await expect(panel.getByLabel('First name *', { exact: true })).toHaveValue('External update');

        const upload = panel.getByLabel('Upload CV', { exact: true });
        await upload.setInputFiles({ name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic text') });
        await panel.getByRole('button', { name: 'Upload selected CV', exact: true }).click();
        await expect(panel.getByRole('link', { name: /CV: Choose a non-empty PDF or DOCX/ })).toBeVisible();
        await upload.setInputFiles({ name: 'invalid.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not a PDF') });
        response = page.waitForResponse(response => response.url() === `${api}/${incomplete.id}/cv`);
        await panel.getByRole('button', { name: 'Upload selected CV', exact: true }).click();
        assert.equal((await response).status(), 400);
        await expect(panel.getByRole('link', { name: /CV: Only valid PDF or DOCX/ })).toBeVisible();
        await expect(panel.getByLabel('First name *', { exact: true })).toHaveValue('External update');
        await panel.getByLabel('Last name *', { exact: true }).fill('Candidate');
        await panel.getByLabel('Primary email *', { exact: true }).fill('uploaded-telegram@example.test');
        response = page.waitForResponse(response => response.url() === `${api}/${incomplete.id}` && response.request().method() === 'PATCH');
        await panel.getByRole('button', { name: 'Save changes', exact: true }).click();
        assert.equal((await response).status(), 200);
        const pdf = createSyntheticPdf();
        await upload.setInputFiles({ name: 'Uploaded-CV.pdf', mimeType: 'application/pdf', buffer: pdf });
        response = page.waitForResponse(response => response.url() === `${api}/${incomplete.id}/cv`);
        await panel.getByRole('button', { name: 'Upload selected CV', exact: true }).click();
        const uploaded = await response;
        assert.equal(uploaded.status(), 200, await uploaded.text());
        assert.deepEqual((await uploaded.json()).result.missingFields, []);
        assert.equal(files.size, 1);
        assert.deepEqual([...files.values()][0], pdf);
        await expect(panel.getByText('Ready', { exact: true })).toBeVisible();
        await expect(panel.getByRole('link', { name: 'Open CV', exact: true })).toHaveAttribute('href', `/api/staff/telegram-intake/drafts/${incomplete.id}/cv`);
        const cvRedirect = await context.request.get(`${api}/${incomplete.id}/cv`, { maxRedirects: 0 });
        assert.equal(cvRedirect.status(), 302, await cvRedirect.text());
        assert.equal(cvRedirect.headers()['cache-control'], 'private, no-store');
        const signedURL = cvRedirect.headers().location;
        assert.equal(new URL(signedURL).origin, storageURL);
        const downloaded = await fetch(signedURL);
        assert.equal(downloaded.status, 200);
        assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), pdf);
        response = page.waitForResponse(response => response.url() === `${api}/${incomplete.id}/decision`);
        await panel.getByRole('button', { name: 'Approve candidate', exact: true }).click();
        const uploadApproval = await response;
        assert.equal(uploadApproval.status(), 200, await uploadApproval.text());
        await expect(panel.getByText('Candidate approved.', { exact: true })).toBeVisible();
        await expect(panel.getByRole('link', { name: 'Open CV', exact: true })).toHaveCount(0);
        await panel.getByRole('button', { name: 'Close', exact: true }).click();
        await page.getByLabel('Missing information', { exact: true }).selectOption('');
        await page.getByRole('button', { name: /^Ready \d/ }).click();
        await page.getByRole('button', { name: 'Ready Candidate', exact: true }).click();
        await expect(panel.getByRole('link', { name: 'Open CV', exact: true })).toHaveAttribute('href', `/api/staff/telegram-intake/drafts/${ready.id}/cv`);
        await expect(panel.getByRole('link', { name: 'Open CV', exact: true })).toHaveAttribute('target', '_blank');
        await expect(panel.getByText('Private evidence sentinel', { exact: true })).toBeHidden();
        await panel.getByText('Private source evidence (1)', { exact: true }).click();
        await expect(panel.getByText('Private evidence sentinel', { exact: true })).toBeVisible();
        response = page.waitForResponse(response => response.url() === `${api}/${ready.id}/decision`);
        await panel.getByRole('button', { name: 'Approve candidate', exact: true }).click();
        const approval = await response;
        assert.equal(approval.status(), 200, await approval.text());
        const approvedId = (await approval.json()).result.candidateId;
        await expect(panel.getByRole('link', { name: 'Open approved candidate' })).toHaveAttribute('href', `/staff/candidates/${approvedId}`);
        await expect(panel.getByText('Candidate approved.', { exact: true })).toBeVisible();
        await expect(panel.getByRole('link', { name: 'Open CV', exact: true })).toHaveCount(0);
        await expect(panel.getByText('Private evidence sentinel', { exact: true })).toHaveCount(0);
        const stored = JSON.parse(psql(db, `select json_build_object('status',status,'fields',fields,'document',document) from app.telegram_drafts where id='${ready.id}';`).trim());
        assert.deepEqual(stored, { status: 'approved', fields: {}, document: null });
        assert.equal(psql(db, `select count(*) from app.telegram_evidence where id='${evidenceId}';`).trim(), '0');
        assert.deepEqual(pageErrors, []);
        mkdirSync(join(root, 'test-results'), { recursive: true });
        await page.screenshot({ path: join(root, 'test-results/telegram-intake-approved.png'), fullPage: true });
    } catch (error) {
        t.diagnostic(output.join('').slice(-16000));
        mkdirSync(join(root, 'test-results'), { recursive: true });
        await page.screenshot({ path: join(root, 'test-results/telegram-intake-failure.png'), fullPage: true }).catch(() => {});
        throw error;
    }
});
