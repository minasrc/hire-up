import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { createSyntheticPdf, syntheticCvText } from '../support/cv-fixtures.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const nextBin = join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
const preload = join(root, 'tests', 'staff-workspace', 'google-token-preload.cjs');
const migrations = [
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
    '20260930090000_candidate_profiles.sql',
    '20260930090100_candidate_intake_serialization.sql',
    '20261001090000_public_intake_duplicate_review.sql',
    '20261001100000_candidate_merge.sql',
    '20261002100000_candidate_upload.sql',
    '20261002110000_staff_shell_capabilities.sql',
    '20261002120000_staff_list_pagination.sql',
    '20261004100000_staff_candidate_directory.sql',
    '20261009090000_document_preview_versions.sql',
];

async function waitForServer(url) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
        const response = await fetch(url).catch(() => null);
        if (response?.ok) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('Temporary staff server did not start');
}

test('staff previews records in place and opens CV content', async (t) => {
    assertLocalTestEnvironment();
    const db = await startPostgresContainer('pgrecordpreview', POSTGRES_17_IMAGE, {
        publish: true,
    });
    t.after(() => stopAndRemoveContainer(db));
    for (const name of migrations) {
        psql(db, readFileSync(join(root, 'supabase', 'migrations', name), 'utf8'));
    }
    const runtimePassword = installStaffFixture(db);
    psql(db, clientJobFixtureSql);
    const port = await findFreePort();
    const baseURL = `http://127.0.0.1:${port}`;
    const secret = 'synthetic-record-preview-secret';
    const totpId = 'a5b1a111-0000-4000-8000-00000000d101';
    psql(db, `insert into app.totp_credentials
        (id, organization_id, user_id, secret, status, verified_at)
        values ('${totpId}', '${AUTHZ_ID.ORG_B}', '${AUTHZ_ID.USER_ADMIN2}',
            'JBSWY3DPEHPK3PXP', 'active', now());`);
    const output = [];
    const server = spawn(process.execPath,
        [nextBin, 'dev', '--webpack', '-p', String(port), '-H', '127.0.0.1'], {
            cwd: root,
            env: {
                PATH: process.env.PATH, HOME: process.env.HOME,
                NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1',
                NODE_OPTIONS: `--require ${preload}`,
                STAFF_DATABASE_URL: `postgresql://agora_authz_test:${runtimePassword}@127.0.0.1:${publishedPort(db, 5432)}/postgres`,
                STAFF_ORGANIZATION_ID: AUTHZ_ID.ORG_B,
                NEXTAUTH_URL: baseURL, NEXTAUTH_SECRET: secret,
                GOOGLE_CLIENT_ID: 'synthetic-workspace-client',
                GOOGLE_CLIENT_SECRET: 'synthetic-workspace-client-secret',
                NEXT_PUBLIC_SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '',
                GITHUB_ID: '', GITHUB_SECRET: '',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    server.stdout.on('data', (chunk) => output.push(String(chunk)));
    server.stderr.on('data', (chunk) => output.push(String(chunk)));
    t.after(async () => {
        server.kill('SIGTERM');
        await new Promise((resolve) => {
            const timer = setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 10_000);
            server.once('exit', () => { clearTimeout(timer); resolve(); });
        });
    });
    await waitForServer(`${baseURL}/dev/duplicate-review`);

    const token = await encode({ token: {
        name: 'Admin Two', email: 'admin-two@synthetic.test',
        sub: '1002', provider: 'google', providerAccountId: '1002',
        googleRefreshToken: 'SYNTHETIC-WORKSPACE-TEST', emailVerified: true,
        iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
    }, secret });
    const proof = createStaffMfaProof(secret, {
        subject: '1002', userId: AUTHZ_ID.USER_ADMIN2, credentialId: totpId,
    });
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const context = await browser.newContext();
    await context.addCookies([
        { name: 'next-auth.session-token', value: token, url: baseURL },
        { name: STAFF_MFA_COOKIE, value: proof, url: baseURL },
    ]);
    await context.addInitScript(() => {
        const OriginalWorker = window.Worker;
        window.__pdfRequestsBeforeReady = 0;
        window.__pdfParses = 0;
        window.Worker = class extends OriginalWorker {
            constructor(...args) {
                super(...args);
                let ready = false;
                this.addEventListener('message', event => {
                    if (event.data?.action === 'ready') ready = true;
                });
                const send = this.postMessage.bind(this);
                this.postMessage = (message, ...options) => {
                    if (message?.action === 'GetDocRequest' && !ready) window.__pdfRequestsBeforeReady++;
                    if (message?.action === 'GetDocRequest') window.__pdfParses++;
                    return send(message, ...options);
                };
            }
        };
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const pageErrors = [];
    const browserWarnings = [];
    page.on('console', message => {
        if (['warning', 'error'].includes(message.type())) browserWarnings.push(message.text());
    });
    const previewRequests = [];
    page.on('request', (request) => {
        if (/\/api\/staff\/(candidates|jobs)\/[0-9a-f-]{36}$/.test(request.url())) {
            previewRequests.push(request.url());
        }
    });
    page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
    try {
        await page.goto(`${baseURL}/staff/candidates?q=Synthetic`, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle');
        const candidateLink = page.getByRole('main')
            .getByRole('link', { name: 'Synthetic Candidate B' }).first();
        await candidateLink.click();
        const candidatePreview = page.getByRole('dialog', { name: 'Synthetic Candidate B' });
        await expect(candidatePreview).toBeVisible({ timeout: 20_000 });
        await expect(page).toHaveURL(`${baseURL}/staff/candidates?q=Synthetic`);
        await candidatePreview.getByRole('tab', { name: /Documents/ }).click();
        await expect(candidatePreview.getByText('No documents on file.'))
            .toBeVisible({ timeout: 20_000 });
        await candidatePreview.getByRole('button', { name: 'Close' }).click();
        await expect(candidatePreview).toHaveCount(0);
        assert.deepEqual(pageErrors, [], pageErrors.join('\n'));
        await expect(candidateLink).toBeFocused();
        const firstReadCount = previewRequests.length;
        await candidateLink.click();
        await expect(candidatePreview).toBeVisible();
        assert.equal(previewRequests.length, firstReadCount,
            'reopening a recent preview reuses its authorized in-memory result');
        await candidatePreview.getByRole('button', { name: 'Close' }).click();


        await page.route('**/api/staff/candidates/*', async (route) => {
            const response = await route.fetch();
            const payload = await response.json();
            payload.result.documents.push({
                documentId: 'aaaa1111-2222-4222-8222-222222222222',
                filename: 'Supporting.pdf', purpose: 'other', lifecycle: 'active',
                scanState: 'clean', sizeBytes: 256, receivedAt: new Date().toISOString(),
            });
            payload.result.documents.push({
                documentId: 'bbbbbbbb-2222-4222-8222-222222222222',
                filename: 'Synthetic.docx', purpose: 'cv', lifecycle: 'active',
                scanState: 'clean', sizeBytes: 256, receivedAt: new Date().toISOString(),
            });
            payload.result.documents.push({
                documentId: 'cccccccc-3333-4333-8333-333333333333',
                filename: 'Synthetic.pdf', purpose: 'cv', lifecycle: 'active',
                scanState: 'clean', sizeBytes: 512, receivedAt: new Date().toISOString(),
            });
            payload.result.documents.push({
                documentId: 'dddddddd-4444-4444-8444-444444444444',
                filename: 'Second.pdf', purpose: 'cv', lifecycle: 'active',
                scanState: 'clean', sizeBytes: 512, receivedAt: new Date().toISOString(),
            });
            payload.result.capabilities.downloadDocuments = true;
            await route.fulfill({ response, json: payload });
        });
        let textTransfers = 0, pdfTransfers = 0, validations = 0, denyPdf = false;
        let holdText = false, resumeText;
        const versions = new Map();
        const validate = async (route) => {
            validations++;
            if (denyPdf && route.request().url().endsWith('?view=bytes')) {
                await route.fulfill({ status: 403, json: { error: 'FORBIDDEN' } });
                return null;
            }
            const etag = versions.get(route.request().url()) ?? '"synthetic-v1"';
            if (route.request().headers()['if-none-match'] === etag) {
                await route.fulfill({ status: 304, headers: { etag } });
                return null;
            }
            return etag;
        };
        await page.route('**/api/staff/documents/*?view=text', async (route) => {
            if (holdText) await new Promise(resolve => { resumeText = resolve; });
            const etag = await validate(route); if (!etag) return;
            textTransfers++;
            await route.fulfill({ status: 200, contentType: 'application/json',
                headers: { etag },
                body: JSON.stringify({ text: 'Synthetic extracted resume text' }) });
        });
        await page.route('**/api/staff/documents/*?view=bytes', async (route) => {
            const etag = await validate(route); if (!etag) return;
            pdfTransfers++;
            await route.fulfill({ status: 200, contentType: 'application/pdf',
                headers: { etag },
                body: createSyntheticPdf() });
        });
        await page.evaluate(() => window.dispatchEvent(
            new CustomEvent('staff-workspace-updated', { detail: { scope: 'workspace' } })));
        await candidateLink.click();
        const documentPreview = page.getByRole('dialog', { name: 'Synthetic Candidate B' });
        await expect(documentPreview.getByRole('tab', { name: /Documents/ }))
            .toHaveAttribute('data-state', 'active');
        await expect(documentPreview.getByRole('button', { name: 'Synthetic.docx' }))
            .toHaveAttribute('aria-pressed', 'true');
        await expect(documentPreview.getByText('Synthetic extracted resume text'))
            .toBeVisible({ timeout: 20_000 });
        await documentPreview.getByRole('button', { name: 'Synthetic.pdf' }).click();
        const canvas = documentPreview.locator('canvas[aria-label="Page 1 of 1"]');
        // The canvas mounts before PDF.js finishes its lazy worker/render work.
        // Accessible text is published only after renderTask.promise resolves.
        await expect(documentPreview.getByText(syntheticCvText, { exact: true }))
            .toBeAttached({ timeout: 20_000 });
        await expect.poll(async () => canvas.evaluate((element) => {
            const context = element.getContext('2d');
            if (!context || element.width === 0) return 0;
            const pixels = context.getImageData(0, 0, element.width, element.height).data;
            let dark = 0;
            for (let index = 0; index < pixels.length; index += 4) {
                if (pixels[index] < 160 && pixels[index + 3] > 0) dark += 1;
            }
            return dark;
        }), { timeout: 20_000, message: 'the rendered PDF page contains visible ink' }).toBeGreaterThan(100);
        assert.equal(await page.evaluate(() => window.__pdfRequestsBeforeReady), 0, 'PDF parsing must wait for the worker readiness handshake');
        await documentPreview.getByRole('button', { name: 'Zoom in', exact: true }).click();
        await expect(documentPreview.getByText('125%', { exact: true })).toBeVisible();
        await documentPreview.getByRole('button', { name: 'Second.pdf', exact: true }).click();
        await expect(documentPreview.getByText(syntheticCvText, { exact: true })).toBeAttached();
        const initialValidations = validations;
        await documentPreview.getByRole('button', { name: 'Synthetic.pdf', exact: true }).click();
        await expect(documentPreview.getByText('125%', { exact: true })).toBeVisible();
        await expect(documentPreview.getByText(syntheticCvText, { exact: true })).toBeAttached();
        assert.equal(pdfTransfers, 2, 'A to B to A transfers each PDF only once');
        assert.equal(await page.evaluate(() => window.__pdfParses), 2, 'A to B to A prepares each PDF only once');
        assert.equal(validations, initialValidations + 1, 'cached PDF reuse still validates access');
        holdText = true;
        await documentPreview.getByRole('button', { name: 'Synthetic.docx', exact: true }).click();
        await expect(documentPreview.getByText('Checking document access…', { exact: true })).toBeVisible();
        await expect(documentPreview.getByText('Synthetic extracted resume text')).toHaveCount(0);
        await expect.poll(() => !!resumeText).toBe(true);
        holdText = false; resumeText();
        await expect(documentPreview.getByText('Synthetic extracted resume text')).toBeVisible();
        assert.equal(textTransfers, 1, 'a cached DOCX does not extract or transfer text again');
        await documentPreview.getByRole('button', { name: 'Synthetic.pdf', exact: true }).click();
        await expect(documentPreview.getByText('125%', { exact: true })).toBeVisible();
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        // Focus also refreshes the candidate preview and resets its selected file.
        await expect(documentPreview.getByRole('button', { name: 'Synthetic.docx', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await documentPreview.getByRole('button', { name: 'Synthetic.pdf', exact: true }).click();
        await expect(documentPreview.getByText(syntheticCvText, { exact: true })).toBeAttached();
        assert.equal(pdfTransfers, 2, 'focus revalidates without retransferring an unchanged PDF');
        assert.equal(await page.evaluate(() => window.__pdfParses), 2);
        // Changed content and revoked access must override a cached preparation.
        versions.set(`${baseURL}/api/staff/documents/cccccccc-3333-4333-8333-333333333333?view=bytes`, '"synthetic-v2"');
        await documentPreview.getByRole('button', { name: 'Second.pdf', exact: true }).click();
        await expect(documentPreview.getByText(syntheticCvText, { exact: true })).toBeAttached();
        await documentPreview.getByRole('button', { name: 'Synthetic.pdf', exact: true }).click();
        await expect(documentPreview.getByText('100%', { exact: true })).toBeVisible();
        await expect(documentPreview.getByText(syntheticCvText, { exact: true })).toBeAttached();
        assert.equal(pdfTransfers, 3); assert.equal(await page.evaluate(() => window.__pdfParses), 3);
        denyPdf = true;
        await documentPreview.getByRole('button', { name: 'Synthetic.docx', exact: true }).click();
        await expect(documentPreview.getByText('Synthetic extracted resume text')).toBeVisible();
        await documentPreview.getByRole('button', { name: 'Synthetic.pdf', exact: true }).click();
        await expect(documentPreview.getByRole('alert')).toHaveText('You do not have permission to view this document.');
        await expect(documentPreview.locator('canvas')).toHaveCount(0);
        assert.equal(pdfTransfers, 3, 'denial never falls back to previously authorized bytes');
        await documentPreview.getByRole('button', { name: 'Close' }).click();
        await page.unroute('**/api/staff/candidates/*');
        await page.unroute('**/api/staff/documents/*?view=text');
        await page.unroute('**/api/staff/documents/*?view=bytes');

        await page.goto(`${baseURL}/staff/jobs?q=Legacy`, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle');
        const jobLink = page.getByRole('main')
            .getByRole('link', { name: 'Legacy Synthetic Job' }).first();
        await jobLink.click();
        const jobPreview = page.getByRole('dialog', { name: 'Legacy Synthetic Job' });
        await expect(jobPreview).toBeVisible({ timeout: 20_000 });
        await expect(page).toHaveURL(`${baseURL}/staff/jobs?q=Legacy`);
        await jobPreview.getByRole('button', { name: 'Close' }).click();
        await expect(jobLink).toBeFocused();
        const jobReadCount = previewRequests.length;
        await jobLink.click();
        await expect(jobPreview).toBeVisible();
        assert.equal(previewRequests.length, jobReadCount,
            'reopening a job uses the bounded cache');
        await page.evaluate(() => window.dispatchEvent(new Event('staff-session-invalidated')));
        await expect(page.getByRole('dialog')).toHaveCount(0);


        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${baseURL}/staff/candidates`, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle');
        await page.getByRole('main').getByRole('link', { name: 'Synthetic Candidate B' }).click();
        const mobilePreview = page.getByRole('dialog', { name: 'Synthetic Candidate B' });
        await expect(mobilePreview).toBeVisible({ timeout: 20_000 });
        assert.ok((await mobilePreview.boundingBox()).width <= 390);
        assert.equal(await page.evaluate(() =>
            document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
        await mobilePreview.getByRole('button', { name: 'Close' }).click();
        assert.deepEqual(pageErrors, [], pageErrors.join('\n'));
    } catch (error) {
        t.diagnostic(`Browser errors:\n${pageErrors.join('\n')}\nBrowser warnings:\n${browserWarnings.join('\n')}\nPreview DOM:\n${await page.getByRole('dialog').textContent().catch(() => 'No preview')}\nServer:\n${output.slice(-30).join('')}`);
        throw error;
    }
});
