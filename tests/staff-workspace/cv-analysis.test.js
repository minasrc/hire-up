import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { createSyntheticDocx, createSyntheticPdf } from '../support/cv-fixtures.js';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium, expect as baseExpect } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { POSTGRES_17_IMAGE, assertLocalTestEnvironment, findFreePort, psql, publishedPort, startPostgresContainer, stopAndRemoveContainer } from '../support/foundation-docker.js';
import { AUTHZ_ID, installStaffFixture } from '../support/staff-authorization.js';
import { clientJobFixtureSql } from '../support/client-job-workflows.js';
import { STAFF_MFA_COOKIE, createStaffMfaProof } from '../../src/lib/staff-mfa-cookie.js';

const expect = baseExpect.configure({ timeout: 15000 });
const root = resolve(process.env.CV_ANALYSIS_TEST_ROOT || fileURLToPath(new URL('../../', import.meta.url)));

async function waitForServer(url) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) }).catch(() => null);
        if (response?.ok) return;
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Temporary Telegram connection server did not start');
}

test('CV analysis creates private drafts from attachment-only messages and supports ordinary candidate approval', { timeout: 240_000 }, async t => {
    assertLocalTestEnvironment();
    const db = await startPostgresContainer('pgcvanalysisui', POSTGRES_17_IMAGE, { publish: true });
    t.after(() => stopAndRemoveContainer(db));
    const migrationsDir = join(root, 'supabase/migrations');
    const migrations = readdirSync(migrationsDir).filter(name => name >= '20260922090000_foundation_roles.sql' && name.endsWith('.sql')).sort();
    assert.ok(migrations.some(name => name.includes('telegram_cv')), 'CV retrieval migration is required');
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
            } else if (request.method === 'GET' && files.has(key)) { response.writeHead(200); response.end(files.get(key));
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
    const pdf = createSyntheticPdf();
    const docx = createSyntheticDocx();
    const cvURL = `${baseURL}/api/staff/telegram-cv`;
    const draftURL = `${baseURL}/api/staff/telegram-intake/drafts`;
    const discovery = await context.request.post(staffURL, { data: { action: 'discover' } });
    assert.equal(discovery.status(), 200, await discovery.text());
    while ((await getChats()).discovery.status !== 'completed') {
        const job = (await historyWorker('claim')).job;
        if (job.cursor.folder === 0 && job.cursor.offsetId === '0') {
            await completePage(job, [{ peer: { kind: 'user', id: '777' }, title: 'Synthetic CV conversation', username: 'ada_demo', lastMessageAt: null }], { folder: 0, offsetDate: 1700000000, offsetId: '2', offsetPeer: { kind: 'user', id: '777' }, excludePinned: true });
        } else await completePage(job, [], job.cursor, true);
    }
    const chat = (await getChats()).chats[0];
    const selected = await context.request.post(staffURL, { data: { action: 'select', chatId: chat.id, expectedVersion: chat.version, selected: true } });
    assert.equal(selected.status(), 200, await selected.text());
    const attachment = (id, filename, sizeBytes, mimeType = 'application/pdf') => ({ id: String(id), kind: 'document', filename, mimeType, sizeBytes });
    const primaryAttachments = [attachment(1001, 'Candidate-primary.pdf', pdf.length), attachment(1002, 'Candidate-alternate.docx', docx.length, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), attachment(1003, 'Candidate-notes.txt', 100, 'text/plain'), attachment(1004, 'Candidate-too-large.pdf', 4194305)];
    const records = ['Ada Lovelace', 'Charles Babbage'].map((name, index) => ({ messageId: String(2 - index), kind: 'message', sentAt: '2025-01-01T00:00:00.000Z', editedAt: null, sender: { peer: { kind: 'user', id: String(777 + index) }, username: index ? 'charles_demo' : 'ada_demo', displayName: name }, replyToMessageId: null, forwardedFrom: null,
        text: '', attachments: index ? [attachment(2001, 'Charles-original.pdf', pdf.length)] : primaryAttachments }));
    let historyJob = (await historyWorker('claim')).job;
    await completePage(historyJob, records, { beforeMessageId: '1', upperMessageId: '2' });
    historyJob = (await historyWorker('claim')).job;
    await completePage(historyJob, [], historyJob.cursor, true);
    const selectedChat = (await getChats()).chats[0];
    const enqueue = await context.request.post(extractionURL, { data: { action: 'setExtraction', chats: [{ chatId: chat.id, expectedVersion: selectedChat.version }], enabled: true } });
    assert.equal(enqueue.status(), 200, await enqueue.text());
    const extractionJob = (await extractWorker('claim')).job;
    await extractWorker('complete', { jobId: extractionJob.id, leaseToken: extractionJob.leaseToken, sourceDigest: extractionJob.sourceDigest, result: { subjects: [] }, metadata: { model: 'synthetic-model', promptVersion: extractionJob.promptVersion, reportedModel: null } });
    const cvWorker = async () => {
        const connection = (await worker('claim')).connection;
        const proof = { connectionId: connection.id, generation: connection.generation, connectionLeaseToken: connection.leaseToken, accountUserId };
        const response = await fetch(`${baseURL}/api/telegram-cv/worker/claim`, { method: 'POST', headers: { authorization: `Bearer ${registered.token}`, 'content-type': 'application/json' }, body: JSON.stringify(proof) });
        assert.equal(response.status, 200, await response.clone().text());
        return { ...await response.json(), proof };
    };
    async function uploadRetrieved(claimed, bytes) {
        const { job } = claimed;
        const metadata = { ...claimed.proof, jobId: job.id, jobLeaseToken: job.leaseToken, sourceDigest: job.sourceDigest, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length };
        const response = await fetch(`${baseURL}/api/telegram-cv/worker/upload`, { method: 'POST', headers: { authorization: `Bearer ${registered.token}`, 'content-type': 'application/octet-stream', 'x-telegram-cv-proof': Buffer.from(JSON.stringify(metadata)).toString('base64url') }, body: bytes });
        assert.equal(response.status, 200, await response.clone().text()); return response.json();
    }
    const analysisURL = `${baseURL}/api/staff/cv-analysis`;
    async function analysisWorker(action, data = {}, expected = 200) {
        const response = await fetch(`${baseURL}/api/cv-analysis/worker/${action}`, { method: 'POST', headers: { authorization: `Bearer ${registered.token}`, 'content-type': 'application/json' }, body: JSON.stringify(data) });
        assert.equal(response.status, expected, await response.clone().text()); return response.json();
    }
    const sha = value => createHash('sha256').update(value).digest('hex');
    async function parse(job, kind = 'pdf_page') {
        const text = 'Ada Lovelace\nada-analysis@example.test\nLondon\nComputing engineer';
        const block = { ordinal: 0, kind, ...(kind === 'pdf_page' ? { page: 1 } : { part: 'word/document.xml', paragraph: 1 }), text, sha256: sha(text) };
        await analysisWorker('complete', { jobId: job.id, leaseToken: job.leaseToken, sourceDigest: job.sourceDigest, stage: 'parse', result: { parserVersion: job.source.parserVersion, documentSha256: job.source.documentSha256, textSha256: sha(text), blocks: [block] } });
        return block;
    }
    async function facts(job, block, values) {
        const evidence = [{ blockOrdinal: 0, startByte: 0, endByte: Buffer.byteLength(block.text), quote: block.text }];
        return analysisWorker('complete', { jobId: job.id, leaseToken: job.leaseToken, sourceDigest: job.sourceDigest, stage: 'facts', result: { facts: values.map(([field, value]) => ({ field, value, evidence })), issues: [] }, metadata: { model: 'synthetic-model', promptVersion: job.source.promptVersion, reportedModel: null } });
    }
    const page = await context.newPage(); page.setDefaultTimeout(20_000);
    const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
    const panel = page.getByRole('dialog', { name: 'Review draft' });
    const analysis = panel.getByRole('region', { name: 'CV analysis and review', exact: true });
    async function action(button, name, url = analysisURL) {
        const response = page.waitForResponse(response => response.url() === url && response.request().method() === 'POST' && response.request().postDataJSON()?.action === name);
        await button.click(); const result = await response; assert.equal(result.status(), 200, await result.text()); return result.json();
    }
    async function refreshAnalysis() { await analysis.getByRole('button', { name: 'Refresh analysis', exact: true }).click(); }
    try {
        await page.goto(`${baseURL}/staff/telegram-intake/extraction`);
        await page.getByRole('button', { name: 'Review source messages', exact: true }).click();
        const bootstrap = page.getByRole('region', { name: 'Create draft from batch CV' });
        await expect(bootstrap.getByText('Candidate-primary.pdf', { exact: true })).toBeVisible();
        const createButton = filename => bootstrap.locator('article').filter({ hasText: filename }).getByRole('button', { name: 'Create candidate draft from this CV', exact: true });
        await expect(createButton('Candidate-notes.txt')).toBeDisabled(); await expect(createButton('Candidate-too-large.pdf')).toBeDisabled();
        const created = await action(createButton('Candidate-primary.pdf'), 'createDraft', cvURL);
        const draftId = created.draftId;
        const initial = (await (await context.request.get(`${draftURL}/${draftId}`)).json()).result;
        assert.equal(initial.fields.firstName ?? '', ''); assert.equal(initial.fields.telegramUsername ?? '', ''); assert.equal(initial.fields.telegramUserId ?? '', '');
        await bootstrap.getByRole('link', { name: 'Review draft and retrieval', exact: true }).click();
        await expect(panel.getByLabel('First name *', { exact: true })).toHaveValue('');
        await uploadRetrieved(await cvWorker(), pdf);
        await expect(panel.getByRole('link', { name: 'Open CV', exact: true })).toBeVisible();
        await expect(analysis.getByText('Queued for your Mac', { exact: true }).first()).toBeVisible();
        let job = (await analysisWorker('claim')).job;
        const block = await parse(job);
        job = (await analysisWorker('claim')).job;
        await panel.getByLabel('Location', { exact: true }).fill('Unsaved Paris');
        await facts(job, block, [['firstName', 'Ada'], ['lastName', 'Lovelace'], ['primaryEmail', 'ada-analysis@example.test']]);
        await refreshAnalysis();
        await expect(panel.getByLabel('First name *', { exact: true })).toHaveValue('Ada');
        await expect(panel.getByLabel('Location', { exact: true })).toHaveValue('Unsaved Paris');
        await expect(panel.getByText('Unsaved changes', { exact: true })).toBeVisible();
        const text = analysis.getByRole('region', { name: 'Review extracted CV text', exact: true });
        await text.getByRole('button', { name: 'Review extracted CV text', exact: true }).click();
        await expect(text.getByText('PDF page 1', { exact: true })).toBeVisible();
        await expect(text.getByRole('checkbox', { name: 'Keep extracted CV text with this profile', exact: true })).toBeChecked();
        mkdirSync(join(root, 'test-results'), { recursive: true });
        await analysis.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(root, 'test-results/staff-workspace-cv-analysis.png'), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 }); await analysis.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(root, 'test-results/staff-workspace-cv-analysis-mobile.png'), fullPage: true });
        const approval = page.waitForResponse(response => response.url().endsWith(`/drafts/${draftId}/decision`));
        await panel.getByRole('button', { name: 'Approve candidate', exact: true }).click(); assert.equal((await approval).status(), 200);
        await expect(panel.getByRole('link', { name: 'Open approved candidate', exact: true })).toBeVisible();
        await expect(panel.getByRole('region', { name: 'Review extracted CV text', exact: true })).toHaveCount(0);
        await page.goto(`${baseURL}/staff/telegram-intake/extraction`);
        await page.getByRole('button', { name: 'Review source messages', exact: true }).click();
        const second = await action(createButton('Candidate-alternate.docx'), 'createDraft', cvURL);
        await page.goto(`${baseURL}/staff/telegram-intake?draft=${second.draftId}`);
        await uploadRetrieved(await cvWorker(), docx);
        await expect(panel.getByRole('link', { name: 'Open CV', exact: true })).toBeVisible();
        await expect(analysis.getByText('Queued for your Mac', { exact: true }).first()).toBeVisible();
        await action(analysis.getByRole('button', { name: 'Skip CV analysis', exact: true }), 'cancel');
        await expect(analysis.getByText('Analysis skipped', { exact: true }).first()).toBeVisible();
        await panel.getByLabel('Replace CV', { exact: true }).setInputFiles({ name: 'Manual-analysis.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docx });
        const uploaded = page.waitForResponse(response => response.url().endsWith(`/drafts/${second.draftId}/cv`) && response.request().method() === 'POST');
        await panel.getByRole('button', { name: 'Upload selected CV', exact: true }).click(); assert.equal((await uploaded).status(), 200);
        await expect(analysis.getByRole('button', { name: 'Analyze attached CV', exact: true })).toBeEnabled();
        await action(analysis.getByRole('button', { name: 'Analyze attached CV', exact: true }), 'analyze');
        await panel.getByLabel('First name *', { exact: true }).fill('Charles');
        await panel.getByLabel('Last name *', { exact: true }).fill('Babbage');
        await panel.getByLabel('Primary email *', { exact: true }).fill('charles-analysis@example.test');
        const blocked = page.waitForResponse(response => response.url().endsWith(`/drafts/${second.draftId}/decision`));
        await panel.getByRole('button', { name: 'Approve candidate', exact: true }).click(); assert.equal((await blocked).status(), 422);
        await expect(panel.getByRole('link', { name: /^CV analysis review:/ })).toBeVisible();
        await expect(panel.getByRole('link', { name: /^First name:/ })).toHaveCount(0);
        await panel.getByLabel('Location', { exact: true }).fill('Manual Berlin');
        const save = page.waitForResponse(response => response.url().endsWith(`/drafts/${second.draftId}`) && response.request().method() === 'PATCH');
        await panel.getByRole('button', { name: 'Save changes', exact: true }).click(); assert.equal((await save).status(), 200);
        job = (await analysisWorker('claim')).job; const paragraph = await parse(job, 'docx_paragraph'); job = (await analysisWorker('claim')).job;
        await facts(job, paragraph, [['location', 'London']]); await refreshAnalysis();
        const suggestion = analysis.getByRole('article', { name: 'CV suggestion for Location' });
        await expect(suggestion.getByText('Current: Manual Berlin', { exact: true })).toBeVisible();
        await suggestion.getByRole('button', { name: 'Show CV reference', exact: true }).click();
        await expect(suggestion.getByText('Document · Paragraph 1', { exact: true })).toBeVisible();
        await action(suggestion.getByRole('button', { name: 'Dismiss CV suggestion', exact: true }), 'resolve');
        await expect(suggestion).toHaveCount(0);
        await expect(panel.getByLabel('Location', { exact: true })).toHaveValue('Manual Berlin');
        await analysis.getByRole('button', { name: 'Review extracted CV text', exact: true }).click();
        const excluded = page.waitForResponse(response => response.url() === analysisURL && response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'reviewText');
        await analysis.getByRole('checkbox', { name: 'Keep extracted CV text with this profile', exact: true }).uncheck(); assert.equal((await excluded).status(), 200);
        await expect(analysis.getByRole('checkbox', { name: 'Keep extracted CV text with this profile', exact: true })).not.toBeChecked();
        assert.deepEqual(pageErrors, []);
    } catch (error) { console.error(output.join('').slice(-20000)); console.error('Browser errors:', pageErrors); console.error((await page.locator('body').innerText()).slice(-15000)); throw error; }
});
