import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, webcrypto } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { createSyntheticPdf } from '../support/cv-fixtures.js';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium, expect as baseExpect } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { POSTGRES_17_IMAGE, assertLocalTestEnvironment, findFreePort, psql, publishedPort, startPostgresContainer, stopAndRemoveContainer } from '../support/foundation-docker.js';
import { AUTHZ_ID, installStaffFixture } from '../support/staff-authorization.js';
import { clientJobFixtureSql } from '../support/client-job-workflows.js';
import { STAFF_MFA_COOKIE, createStaffMfaProof } from '../../src/lib/staff-mfa-cookie.js';

const expect = baseExpect.configure({ timeout: 15000 });
const root = resolve(process.env.TELEGRAM_EXTRACTION_TEST_ROOT || fileURLToPath(new URL('../../', import.meta.url)));

async function waitForServer(url) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) }).catch(() => null);
        if (response?.ok) return;
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Temporary Telegram connection server did not start');
}

test('Telegram extraction protects recruiter edits, reviews evidence and approves only validated candidates', { timeout: 240_000 }, async t => {
    assertLocalTestEnvironment();
    const db = await startPostgresContainer('pgtelegramextractui', POSTGRES_17_IMAGE, { publish: true });
    t.after(() => stopAndRemoveContainer(db));
    const migrationsDir = join(root, 'supabase/migrations');
    const migrations = readdirSync(migrationsDir).filter(name => name >= '20260922090000_foundation_roles.sql' && name.endsWith('.sql')).sort();
    assert.ok(migrations.some(name => name.includes('telegram_extraction')), 'Extraction migration is required');
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
            TELEGRAM_WORKER_DATABASE_URL: `postgresql://telegram_connector_ui_test:${workerPassword}@127.0.0.1:${publishedPort(db, 5432)}/postgres`,
            STAFF_ORGANIZATION_ID: AUTHZ_ID.ORG_B, NEXTAUTH_URL: baseURL, NEXTAUTH_SECRET: secret,
            GOOGLE_CLIENT_ID: 'synthetic-workspace-client', GOOGLE_CLIENT_SECRET: 'synthetic-workspace-client-secret',
            TELEGRAM_INTAKE_ENABLED: '1', NEXT_PUBLIC_SUPABASE_URL: storageURL, SUPABASE_SERVICE_ROLE_KEY: storageKey, GITHUB_ID: '', GITHUB_SECRET: '',
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
    let accountUserId = '123456789';
    const staffURL = `${baseURL}/api/staff/telegram-history`;
    const connectionURL = `${baseURL}/api/staff/telegram-connection`;
    async function connectAccount() {
        const response = await context.request.post(connectionURL, { data: { action: 'connect', workerId: registered.id } });
        assert.equal(response.status(), 200, await response.text());
        const task = (await worker('claim')).connection;
        await worker('update', { connectionId: task.id, generation: task.generation, leaseToken: task.leaseToken, status: 'connected', profile: { telegramUserId: accountUserId, username: 'synthetic_recruiter', displayName: 'Synthetic Recruiter' } });
    }
    async function disconnectAccount() {
        const current = (await (await context.request.get(connectionURL)).json()).connection;
        const response = await context.request.post(connectionURL, { data: { action: 'disconnect', connectionId: current.id, generation: current.generation } });
        assert.equal(response.status(), 200, await response.text());
        const task = (await worker('claim')).connection;
        await worker('update', { connectionId: task.id, generation: task.generation, leaseToken: task.leaseToken, status: 'disconnected' });
    }
    const historyWorker = async (action, data = {}) => {
        const connection = (await worker('claim')).connection;
        const response = await fetch(`${baseURL}/api/telegram-history/worker/${action}`, {
            method: 'POST', headers: { authorization: `Bearer ${registered.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ connectionId: connection.id, generation: connection.generation, connectionLeaseToken: connection.leaseToken, accountUserId, ...data }),
        });
        assert.equal(response.status, 200, await response.clone().text());
        return response.json();
    };
    const completePage = (job, records, nextCursor = job.cursor, done = false) => historyWorker('complete', {
        jobId: job.id, jobLeaseToken: job.leaseToken, pageId: randomUUID(), fromCursor: job.cursor, nextCursor, done, records,
    });
    const getChats = async query => {
        const response = await context.request.get(`${staffURL}${query || ''}`);
        assert.equal(response.status(), 200, await response.text());
        return response.json();
    };
    await connectAccount();
    const extractionURL = `${baseURL}/api/staff/telegram-extraction`;
    const extractWorker = async (action, data = {}) => {
        const response = await fetch(`${baseURL}/api/telegram-extraction/worker/${action}`, {
            method: 'POST', headers: { authorization: `Bearer ${registered.token}`, 'content-type': 'application/json' }, body: JSON.stringify(data),
        });
        assert.equal(response.status, 200, await response.clone().text());
        return response.json();
    };
    const discovery = await context.request.post(staffURL, { data: { action: 'discover' } });
    assert.equal(discovery.status(), 200, await discovery.text());
    let dialogPages = 0;
    while ((await getChats()).discovery.status !== 'completed') {
        const job = (await historyWorker('claim')).job;
        if (job.cursor.folder === 0 && job.cursor.offsetId === '0') {
            await completePage(job, [{ peer: { kind: 'user', id: '777' }, title: 'Synthetic candidate conversation', username: 'ada_demo', lastMessageAt: null }], { folder: 0, offsetDate: 1700000000, offsetId: '160', offsetPeer: { kind: 'user', id: '777' }, excludePinned: true });
        } else await completePage(job, [], job.cursor, true);
        assert.ok(++dialogPages < 6);
    }
    const chat = (await getChats()).chats[0];
    const select = await context.request.post(staffURL, { data: { action: 'select', chatId: chat.id, expectedVersion: chat.version, selected: true } });
    assert.equal(select.status(), 200, await select.text());
    const records = Array.from({ length: 160 }, (_, index) => {
        const id = 160 - index;
        const city = id <= 80 ? 'London' : id <= 120 ? 'Berlin' : 'Rome';
        const salary = id <= 80 ? '100000' : id <= 120 ? '120000' : '140000';
        return { messageId: String(id), kind: 'message', sentAt: new Date(Date.UTC(2025, 0, 1, 0, 0, id)).toISOString(), editedAt: null,
            sender: { peer: { kind: 'user', id: '777' }, username: 'ada_demo', displayName: 'Ada Lovelace' }, replyToMessageId: null, forwardedFrom: null,
            text: id <= 40 ? 'General recruiting discussion without a candidate profile.' : `I am Ada Lovelace. My email is ada-extraction@example.test. I live in ${city} and want EUR ${salary}. My role is Protocol engineer.`,
            attachments: id % 40 === 1 ? [{ id: String(10000 + id), kind: 'document', filename: 'Ada-shared-resume.pdf', mimeType: 'application/pdf', sizeBytes: 1234 }] : [],
        };
    });
    let historyJob = (await historyWorker('claim')).job;
    await completePage(historyJob, records.slice(0, 100), { beforeMessageId: '61', upperMessageId: '160' });
    historyJob = (await historyWorker('claim')).job;
    await completePage(historyJob, records.slice(100), { beforeMessageId: '1', upperMessageId: '160' });
    historyJob = (await historyWorker('claim')).job;
    await completePage(historyJob, [], historyJob.cursor, true);
    await disconnectAccount();

    function modelResult(job, mode = 'initial') {
        const message = job.source.messages[0];
        const quote = message.text;
        const evidence = [{ messageId: message.messageId, quote }];
        const city = quote.match(/live in (London|Berlin|Rome)/)[1];
        const salary = quote.match(/EUR [0-9]+/)[0];
        const fact = (field, value) => ({ field, value, evidence });
        const facts = mode === 'late' ? [fact('location', city)] : [fact('firstName', 'Ada'), fact('lastName', 'Lovelace'), fact('primaryEmail', 'ada-extraction@example.test'), fact('location', city), fact('compensationPreference', salary), ...(mode === 'update' ? [fact('headline', 'Protocol engineer')] : [])];
        const attachment = job.source.messages.find(item => item.attachments.length);
        return { subjects: [{ key: 'ada', identity: { kind: 'telegram_sender', messageId: message.messageId, quote }, facts,
            attachments: mode !== 'late' && attachment ? [{ messageId: attachment.messageId, attachmentIndex: 0 }] : [] }] };
    }
    const completeExtraction = (job, result) => extractWorker('complete', { jobId: job.id, leaseToken: job.leaseToken, sourceDigest: job.sourceDigest, result, metadata: { model: "synthetic-model", promptVersion: job.promptVersion, reportedModel: null } });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const panel = page.getByRole('dialog', { name: 'Review draft' });
    async function waitForAction(button, action, status = 200) {
        const response = page.waitForResponse(response => response.url() === extractionURL && response.request().method() === 'POST' && response.request().postDataJSON()?.action === action);
        await button.click();
        assert.equal((await response).status(), status);
    }
    async function refreshProgress() {
        const response = page.waitForResponse(response => response.url().startsWith(extractionURL) && response.request().method() === 'GET');
        await page.getByRole('button', { name: 'Refresh progress', exact: true }).click();
        assert.equal((await response).status(), 200);
        await expect(page.getByText('Loading extraction progress…', { exact: true })).toHaveCount(0);
    }
    async function saveProfile() {
        const response = page.waitForResponse(response => /\/api\/staff\/telegram-intake\/drafts\/[a-f0-9-]+$/.test(response.url()) && response.request().method() === 'PATCH');
        await panel.getByRole('button', { name: 'Save changes', exact: true }).click();
        assert.equal((await response).status(), 200);
        await expect(panel.getByText('Changes saved', { exact: true })).toBeVisible();
    }
    try {
        await page.goto(`${baseURL}/staff/telegram-intake/chats`);
        await expect(page.getByRole('heading', { name: 'Connect Telegram to import chats' })).toBeVisible();
        await page.getByLabel('Mark Synthetic candidate conversation', { exact: true }).check();
        await waitForAction(page.getByRole('button', { name: 'Extract candidates from marked chats', exact: true }), 'enqueue');
        await page.getByRole('link', { name: 'View extraction progress', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Candidate extraction', exact: true })).toBeVisible();
        let job = (await extractWorker('claim')).job;
        const originalDigest = job.sourceDigest;
        await extractWorker('fail', { jobId: job.id, leaseToken: job.leaseToken, code: 'INVALID_RESULT', retryAfterSeconds: 1 });
        await refreshProgress();
        await expect(page.getByText(/model response did not pass validation/)).toBeVisible();
        await waitForAction(page.getByRole('button', { name: 'Retry extraction', exact: true }), 'retry');
        job = (await extractWorker('claim')).job;
        assert.equal(job.sourceDigest, originalDigest);
        const initial = await completeExtraction(job, modelResult(job));
        const draftId = initial.draftIds[0];
        assert.equal(initial.nextQueued, true);
        await refreshProgress();
        await waitForAction(page.getByRole('button', { name: 'Acknowledge completed review', exact: true }), 'reviewBatch', 422);
        await expect(page.getByRole('alert').filter({ hasText: 'unresolved candidate decisions' })).toBeVisible();
        await page.getByRole('link', { name: 'Review draft 1', exact: true }).click();
        await expect(panel.getByLabel('First name *', { exact: true })).toHaveValue('Ada');
        await expect(panel.getByLabel('Last name *', { exact: true })).toHaveValue('Lovelace');
        await expect(panel.getByLabel('Primary email *', { exact: true })).toHaveValue('ada-extraction@example.test');
        await expect(panel.getByLabel('Telegram username', { exact: true })).toHaveValue('ada_demo');
        await expect(panel.getByText('No CV attached', { exact: true })).toBeVisible();
        await panel.getByText(/^Referenced attachments \(/).click();
        await expect(panel.getByText('Metadata only', { exact: true })).toBeVisible();
        await expect(panel.getByText(/not downloaded or validated CV files/)).toBeVisible();
        await panel.getByText(/^Private source evidence \(/).click();
        await expect(panel.getByText(job.source.messages[0].text, { exact: false }).first()).toBeVisible();
        let response = page.waitForResponse(response => response.url().endsWith(`/drafts/${draftId}/decision`));
        await panel.getByRole('button', { name: 'Approve candidate', exact: true }).click();
        assert.equal((await response).status(), 422);
        await expect(panel.getByRole('link', { name: /^CV:/ })).toBeVisible();
        await panel.getByLabel('Location', { exact: true }).fill('Paris');
        await saveProfile();
        const review = await (await context.request.get(`${extractionURL}?draftId=${draftId}`)).json();
        assert.ok(review.humanFields.includes('location'));
        assert.equal(review.humanFields.includes('headline'), false);

        job = (await extractWorker('claim')).job;
        const secondResult = modelResult(job, 'update');
        const second = await completeExtraction(job, secondResult);
        assert.deepEqual(second.draftIds, [draftId]);
        await page.goto(`${baseURL}/staff/telegram-intake/extraction`);
        await page.getByRole('link', { name: 'Review draft 1', exact: true }).first().click();
        await expect(panel.getByLabel('Location', { exact: true })).toHaveValue('Paris');
        await expect(panel.getByLabel('Headline', { exact: true })).toHaveValue('Protocol engineer');
        const locationSuggestion = panel.getByRole('region', { name: 'Location suggestion', exact: true });
        const compensationSuggestion = panel.getByRole('region', { name: 'Compensation preference suggestion', exact: true });
        await expect(locationSuggestion.getByText('Paris', { exact: true })).toBeVisible();
        await expect(locationSuggestion.getByText(secondResult.subjects[0].facts.find(fact => fact.field === 'location').value, { exact: true })).toBeVisible();
        await panel.getByLabel('Location', { exact: true }).fill('Unsaved local edit');
        await panel.getByRole('button', { name: 'Refresh suggestions', exact: true }).click();
        await expect(locationSuggestion.getByRole('button', { name: 'Apply suggestion', exact: true })).toBeDisabled();
        await expect(locationSuggestion.getByRole('button', { name: 'Dismiss suggestion', exact: true })).toBeDisabled();
        await expect(panel.getByLabel('Location', { exact: true })).toHaveValue('Unsaved local edit');
        await panel.getByLabel('Location', { exact: true }).fill('Paris');
        const pdf = createSyntheticPdf();
        await panel.getByLabel('Upload CV', { exact: true }).setInputFiles({ name: 'Ada-validated.pdf', mimeType: 'application/pdf', buffer: pdf });
        response = page.waitForResponse(response => response.url().endsWith(`/drafts/${draftId}/cv`) && response.request().method() === 'POST');
        await panel.getByRole('button', { name: 'Upload selected CV', exact: true }).click();
        assert.equal((await response).status(), 200);
        response = page.waitForResponse(response => response.url().endsWith(`/drafts/${draftId}/decision`));
        await panel.getByRole('button', { name: 'Approve candidate', exact: true }).click();
        assert.equal((await response).status(), 422);
        await expect(panel.getByRole('link', { name: /^Suggestions:/ })).toBeVisible();
        await compensationSuggestion.getByText(/^View message references/).click();
        await expect(compensationSuggestion.getByText(job.source.messages[0].text, { exact: true })).toBeVisible();
        mkdirSync(join(root, 'test-results'), { recursive: true });
        await page.screenshot({ path: join(root, 'test-results/staff-workspace-telegram-extraction-suggestions.png'), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await panel.evaluate(element => { element.scrollTop = 0; });
        await expect(panel.getByRole('heading', { name: 'Review draft', exact: true })).toBeVisible();
        await page.screenshot({ path: join(root, 'test-results/staff-workspace-telegram-extraction-review-mobile.png'), fullPage: true });
        await page.setViewportSize({ width: 1280, height: 900 });
        await waitForAction(compensationSuggestion.getByRole('button', { name: 'Apply suggestion', exact: true }), 'resolve');
        await expect(panel.getByLabel('Compensation preference', { exact: true })).toHaveValue(secondResult.subjects[0].facts.find(fact => fact.field === 'compensationPreference').value);
        await waitForAction(locationSuggestion.getByRole('button', { name: 'Dismiss suggestion', exact: true }), 'resolve');
        await expect(panel.getByLabel('Location', { exact: true })).toHaveValue('Paris');
        await expect(panel.getByText('No pending suggestions.', { exact: true })).toBeVisible();
        mkdirSync(join(root, 'test-results'), { recursive: true });
        await page.screenshot({ path: join(root, 'test-results/staff-workspace-telegram-extraction-review.png'), fullPage: true });
        response = page.waitForResponse(response => response.url().endsWith(`/drafts/${draftId}/decision`));
        await panel.getByRole('button', { name: 'Approve candidate', exact: true }).click();
        assert.equal((await response).status(), 200);
        await expect(panel.getByRole('link', { name: 'Open approved candidate', exact: true })).toBeVisible();
        const candidateHref = await panel.getByRole('link', { name: 'Open approved candidate', exact: true }).getAttribute('href');
        const candidateId = candidateHref.split('/').at(-1);
        assert.equal(psql(db, `select count(*) from app.candidates where id='${candidateId}'`).trim(), '1');

        job = (await extractWorker('claim')).job;
        const late = await completeExtraction(job, modelResult(job, 'late'));
        assert.deepEqual(late.draftIds, [draftId]);
        await page.goto(`${baseURL}/staff/telegram-intake/extraction`);
        await page.getByRole('link', { name: 'Review draft 1', exact: true }).first().click();
        await expect(panel.getByText(/New information arrived after this draft was closed/)).toBeVisible();
        await expect(panel.getByRole('button', { name: 'Apply suggestion', exact: true })).toHaveCount(0);
        await waitForAction(panel.getByRole('button', { name: 'Dismiss suggestion', exact: true }), 'resolve');
        await expect(panel.getByRole('link', { name: 'Open approved candidate', exact: true })).toHaveAttribute('href', candidateHref);
        await page.goto(`${baseURL}/staff/telegram-intake/extraction`);
        job = (await extractWorker('claim')).job;
        const empty = await completeExtraction(job, { subjects: [] });
        assert.deepEqual(empty.draftIds, []);
        await refreshProgress();
        await expect(page.getByText(/The model suggested no candidates in this batch/)).toBeVisible();
        await page.getByRole('button', { name: 'Review source messages', exact: true }).first().click();
        const sourcePanel = page.getByRole('region', { name: 'Private batch source', exact: true });
        await expect(sourcePanel.getByText('General recruiting discussion without a candidate profile.', { exact: true })).toHaveCount(40);
        await page.getByRole('button', { name: 'Hide source messages', exact: true }).click();
        for (let index = 0; index < 4; index += 1) {
            await waitForAction(page.getByRole('button', { name: 'Acknowledge completed review', exact: true }).first(), 'reviewBatch');
            await expect(page.getByRole('button', { name: 'Acknowledge completed review', exact: true })).toHaveCount(3 - index);
        }
        const finalQueue = await (await context.request.get(extractionURL)).json();
        assert.equal(finalQueue.counts.needsReview, 0);
        assert.equal(finalQueue.counts.completed, 4);
        assert.equal(psql(db, `select count(*) from app.telegram_history_messages`).trim(), '160', 'Review does not delete retained sources');
        assert.deepEqual(pageErrors, []);
        mkdirSync(join(root, 'test-results'), { recursive: true });
        await page.evaluate(() => window.scrollTo(0, 0));
        await expect(page.getByRole('navigation', { name: 'Breadcrumb', exact: true })).toContainText('Telegram intake');
        await expect(page.getByRole('navigation', { name: 'Breadcrumb', exact: true })).toContainText('Candidate extraction');
        await page.screenshot({ path: join(root, 'test-results/staff-workspace-telegram-extraction.png'), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: join(root, 'test-results/staff-workspace-telegram-extraction-mobile.png'), fullPage: true });
    } catch (error) {
        console.error(output.join('').slice(-14_000));
        throw error;
    }
});
