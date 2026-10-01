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
const root = resolve(process.env.TELEGRAM_CV_TEST_ROOT || fileURLToPath(new URL('../../', import.meta.url)));

async function waitForServer(url) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) }).catch(() => null);
        if (response?.ok) return;
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Temporary Telegram connection server did not start');
}

test('Telegram CV retrieval validates selected files and preserves profile edits', { timeout: 240_000 }, async t => {
    assertLocalTestEnvironment();
    const db = await startPostgresContainer('pgtelegramcvui', POSTGRES_17_IMAGE, { publish: true });
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
        text: `I am ${name}. My email is ${index ? 'charles' : 'ada'}-cv@example.test.`, attachments: index ? [attachment(2001, 'Charles-original.pdf', pdf.length)] : primaryAttachments }));
    let historyJob = (await historyWorker('claim')).job;
    await completePage(historyJob, records, { beforeMessageId: '1', upperMessageId: '2' });
    historyJob = (await historyWorker('claim')).job;
    await completePage(historyJob, [], historyJob.cursor, true);
    const enqueue = await context.request.post(extractionURL, { data: { action: 'enqueue', chatIds: [chat.id] } });
    assert.equal(enqueue.status(), 200, await enqueue.text());
    const extractionJob = (await extractWorker('claim')).job;
    const subjects = records.map((record, index) => {
        const [firstName, lastName] = record.sender.displayName.split(' ');
        const evidence = [{ messageId: record.messageId, quote: record.text }];
        return { key: `candidate${index}`, identity: { kind: 'telegram_sender', messageId: record.messageId, quote: record.text },
            facts: [['firstName', firstName], ['lastName', lastName], ['primaryEmail', `${index ? 'charles' : 'ada'}-cv@example.test`]].map(([field, value]) => ({ field, value, evidence })),
            attachments: record.attachments.map((_, attachmentIndex) => ({ messageId: record.messageId, attachmentIndex })) };
    });
    const extracted = await extractWorker('complete', { jobId: extractionJob.id, leaseToken: extractionJob.leaseToken, sourceDigest: extractionJob.sourceDigest, result: { subjects }, metadata: { model: 'synthetic-model', promptVersion: extractionJob.promptVersion, reportedModel: null } });
    assert.equal(extracted.draftIds.length, 2);
    const drafts = await Promise.all(extracted.draftIds.map(async id => (await (await context.request.get(`${draftURL}/${id}`)).json()).result));
    const ada = drafts.find(draft => draft.fields.firstName === 'Ada');
    const charles = drafts.find(draft => draft.fields.firstName === 'Charles');
    async function connectionProof() {
        const connection = (await worker('claim')).connection;
        return { connectionId: connection.id, generation: connection.generation, connectionLeaseToken: connection.leaseToken, accountUserId };
    }
    async function cvWorker(action, data = {}) {
        const common = await connectionProof();
        const response = await fetch(`${baseURL}/api/telegram-cv/worker/${action}`, { method: 'POST', headers: { authorization: `Bearer ${registered.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...common, ...data }) });
        assert.equal(response.status, 200, await response.clone().text());
        return { ...await response.json(), proof: common };
    }
    async function uploadRetrieved(claimed, bytes, expectedStatus = 200) {
        const { job } = claimed;
        const metadata = { ...claimed.proof, jobId: job.id, jobLeaseToken: job.leaseToken, sourceDigest: job.sourceDigest, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length };
        const response = await fetch(`${baseURL}/api/telegram-cv/worker/upload`, { method: 'POST', headers: { authorization: `Bearer ${registered.token}`, 'content-type': 'application/octet-stream', 'x-telegram-cv-proof': Buffer.from(JSON.stringify(metadata)).toString('base64url') }, body: bytes });
        assert.equal(response.status, expectedStatus, await response.clone().text());
        return response.json();
    }
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
    const panel = page.getByRole('dialog', { name: 'Review draft' });
    const retrieval = panel.getByRole('region', { name: 'Retrieve CV from Telegram', exact: true });
    const cvButton = filename => retrieval.getByRole('button', { name: `Retrieve CV: ${filename}`, exact: true });
    async function action(button, action) {
        const response = page.waitForResponse(response => response.url() === cvURL && response.request().method() === 'POST' && response.request().postDataJSON()?.action === action);
        await button.click(); assert.equal((await response).status(), 200);
    }
    async function refreshCv() {
        await retrieval.getByRole('button', { name: 'Refresh retrieval', exact: true }).click();
        await expect(retrieval.getByText('Loading retrieval status…', { exact: true })).toHaveCount(0);
    }
    async function saveProfile() {
        const response = page.waitForResponse(response => response.url().endsWith(`/drafts/${ada.id}`) && response.request().method() === 'PATCH');
        await panel.getByRole('button', { name: 'Save changes', exact: true }).click();
        assert.equal((await response).status(), 200);
        await expect(panel.getByText('Changes saved', { exact: true })).toBeVisible();
    }
    try {
        await disconnectAccount();
        await page.goto(`${baseURL}/staff/telegram-intake?draft=${ada.id}`);
        await expect(retrieval.getByRole('link', { name: 'Manage Telegram connection', exact: true })).toBeVisible();
        await expect(cvButton('Candidate-primary.pdf')).toBeDisabled();
        accountUserId = '999999'; await connectAccount();
        await refreshCv();
        await expect(retrieval.getByText(/Reconnect the Telegram account that imported/).first()).toBeVisible();
        await disconnectAccount(); accountUserId = '123456789'; await connectAccount();
        await refreshCv();
        await expect(cvButton('Candidate-primary.pdf')).toBeEnabled();
        await expect(cvButton('Candidate-alternate.docx')).toBeEnabled();
        await expect(cvButton('Candidate-notes.txt')).toBeDisabled();
        await expect(cvButton('Candidate-too-large.pdf')).toBeDisabled();
        await expect(retrieval.getByText(/Only PDF and DOCX documents/)).toBeVisible();
        await expect(retrieval.getByText(/exceeds the 4 MB CV limit/)).toBeVisible();
        await action(cvButton('Candidate-alternate.docx'), 'retrieve');
        await expect(retrieval.getByText('Queued for your Mac', { exact: true })).toBeVisible();
        await expect(panel.getByText('No CV attached', { exact: true })).toBeVisible();
        await expect(cvButton('Candidate-primary.pdf')).toBeDisabled();
        await action(retrieval.getByRole('button', { name: 'Cancel retrieval', exact: true }), 'cancel');
        await expect(retrieval.getByText('Retrieval cancelled', { exact: true })).toBeVisible();
        await action(retrieval.getByRole('button', { name: 'Retry retrieval', exact: true }), 'retry');
        let claimed = await cvWorker('claim');
        assert.equal(claimed.job.source.filename, 'Candidate-alternate.docx');
        await refreshCv();
        await expect(retrieval.getByText('Downloading and validating', { exact: true })).toBeVisible();
        await cvWorker('defer', { jobId: claimed.job.id, jobLeaseToken: claimed.job.leaseToken, code: 'SOURCE_CHANGED', retryAfterSeconds: 1 });
        await refreshCv();
        await expect(retrieval.getByText(/will not substitute a different file/)).toBeVisible();
        await expect(panel.getByText('No CV attached', { exact: true })).toBeVisible();
        const approvalMissing = page.waitForResponse(response => response.url().endsWith(`/drafts/${ada.id}/decision`));
        await panel.getByRole('button', { name: 'Approve candidate', exact: true }).click();
        assert.equal((await approvalMissing).status(), 422);
        await expect(panel.getByRole('link', { name: /^CV:/ })).toBeVisible();
        await action(cvButton('Candidate-primary.pdf'), 'retrieve');
        claimed = await cvWorker('claim');
        await panel.getByLabel('Location', { exact: true }).fill('London');
        await saveProfile();
        await panel.getByLabel('Location', { exact: true }).fill('Unsaved Paris');
        await uploadRetrieved(claimed, pdf);
        await refreshCv();
        await expect(panel.getByRole('link', { name: 'Open CV', exact: true })).toBeVisible();
        await expect(panel.getByLabel('Location', { exact: true })).toHaveValue('Unsaved Paris');
        await expect(panel.getByText('Unsaved changes', { exact: true })).toBeVisible();
        await expect(panel.getByRole('link', { name: /^CV:/ })).toHaveCount(0);
        await expect(cvButton('Candidate-alternate.docx')).toBeDisabled();
        const preview = await context.request.get(`${draftURL}/${ada.id}/cv`);
        assert.equal(preview.status(), 200); assert.deepEqual(await preview.body(), pdf);
        mkdirSync(join(root, 'test-results'), { recursive: true });
        await retrieval.scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(root, 'test-results/staff-workspace-telegram-cv-retrieved.png'), fullPage: true });
        const approval = page.waitForResponse(response => response.url().endsWith(`/drafts/${ada.id}/decision`));
        await panel.getByRole('button', { name: 'Approve candidate', exact: true }).click();
        assert.equal((await approval).status(), 200);
        await expect(panel.getByRole('link', { name: 'Open approved candidate', exact: true })).toBeVisible();
        await page.goto(`${baseURL}/staff/telegram-intake?draft=${charles.id}`);
        await action(cvButton('Charles-original.pdf'), 'retrieve');
        claimed = await cvWorker('claim');
        await panel.getByLabel('Upload CV', { exact: true }).setInputFiles({ name: 'Manual-choice.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docx });
        const manual = page.waitForResponse(response => response.url().endsWith(`/drafts/${charles.id}/cv`) && response.request().method() === 'POST');
        await panel.getByRole('button', { name: 'Upload selected CV', exact: true }).click();
        assert.equal((await manual).status(), 200);
        await expect(panel.getByText('Manual-choice.docx · validated', { exact: true })).toBeVisible();
        await uploadRetrieved(claimed, pdf, 409);
        await refreshCv();
        await expect(retrieval.getByText('Retrieval cancelled', { exact: true })).toBeVisible();
        await expect(retrieval.getByText(/cancelled to protect the chosen file/)).toBeVisible();
        await expect(retrieval.getByText(/Retrieval requested/)).toHaveCount(0);
        await expect(cvButton('Charles-original.pdf')).toBeDisabled();
        const finalDraft = (await (await context.request.get(`${draftURL}/${charles.id}`)).json()).result;
        assert.equal(finalDraft.cv.filename, 'Manual-choice.docx');
        await page.setViewportSize({ width: 390, height: 844 });
        await retrieval.scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(root, 'test-results/staff-workspace-telegram-cv-mobile.png'), fullPage: true });
        await panel.getByLabel('Location', { exact: true }).fill('Not saved locally');
        const closed = await context.request.post(`${draftURL}/${charles.id}/decision`, { data: { action: 'discard', expectedVersion: finalDraft.version, operationId: randomUUID() } });
        assert.equal(closed.status(), 200, await closed.text());
        await retrieval.getByRole('button', { name: 'Refresh retrieval', exact: true }).click();
        await expect(panel.getByText(/Your unsaved changes were not saved/)).toBeVisible();
        await expect(panel.getByLabel('Your unsaved changes', { exact: true })).toHaveValue('Location: Not saved locally');
        await expect(panel.getByRole('button', { name: 'Approve candidate', exact: true })).toHaveCount(0);
        assert.deepEqual(pageErrors, []);
    } catch (error) { console.error(output.join('').slice(-18000)); throw error; }
});
