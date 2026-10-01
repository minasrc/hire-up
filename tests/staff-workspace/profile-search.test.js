import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
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
import { CJ_ID, clientJobFixtureSql } from '../support/client-job-workflows.js';
import { STAFF_MFA_COOKIE, createStaffMfaProof } from '../../src/lib/staff-mfa-cookie.js';

const expect = baseExpect.configure({ timeout: 15000 });
const root = resolve(process.env.PROFILE_SEARCH_TEST_ROOT || fileURLToPath(new URL('../../', import.meta.url)));

async function waitForServer(url) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) }).catch(() => null);
        if (response?.ok) return;
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Temporary profile search server did not start');
}

test('Profile search separates keyword lookup, private scopes and asynchronous ranked results', { timeout: 240_000 }, async t => {
    assertLocalTestEnvironment();
    const db = await startPostgresContainer('pgprofilesearchui', POSTGRES_17_IMAGE, { publish: true });
    t.after(() => stopAndRemoveContainer(db));
    const migrationsDir = join(root, 'supabase/migrations');
    const migrations = readdirSync(migrationsDir).filter(name => name >= '20260922090000_foundation_roles.sql' && name.endsWith('.sql')).sort();
    assert.ok(migrations.some(name => name.includes('profile_search')), 'Profile search migration is required');
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
    const endpoint = `${baseURL}/api/staff/profile-search`;
    const draftsEndpoint = `${baseURL}/api/staff/telegram-intake/drafts`;
    const pdf = createSyntheticPdf();
    const candidateIds = Array.from({ length: 27 }, () => randomUUID());
    psql(db, candidateIds.map((id, index) => `insert into app.candidates(id,organization_id,full_name,identity_state,lifecycle,headline,location,professional_summary) values ('${id}','${AUTHZ_ID.ORG_B}','Search Candidate ${String(index + 1).padStart(2, '0')}','established','active','Protocol engineer','London','Builds decentralized Ethereum protocols and Solidity systems.');`).join('\n'));
    async function createDraft(name) {
        const response = await context.request.post(draftsEndpoint, { data: { fields: { firstName: name, lastName: 'Engineer', primaryEmail: `${name.toLowerCase()}@synthetic.test`, headline: 'Solidity protocol engineer', location: 'Remote Europe', professionalSummary: 'Ethereum development and distributed systems.' }, sourceTitle: 'Synthetic private profile' } });
        assert.equal(response.status(), 201, await response.text()); return (await response.json()).result;
    }
    const readyDraft = await createDraft('Ready');
    const missingDraft = await createDraft('Missing');
    const cv = await context.request.post(`${draftsEndpoint}/${readyDraft.id}/cv`, { multipart: { expectedVersion: String(readyDraft.version), cvFile: { name: 'Ready-CV.pdf', mimeType: 'application/pdf', buffer: pdf } } });
    assert.equal(cv.status(), 200, await cv.text());
    const privateOtherId = randomUUID();
    psql(db, `insert into app.role_permissions(organization_id,role_id,permission_key) values ('${AUTHZ_ID.ORG_B}','${CJ_ID.ROLE_B_RECRUITER}','candidates.write') on conflict do nothing;
        insert into app.telegram_drafts(id,organization_id,owner_user_id,fields,source_title) values ('${privateOtherId}','${AUTHZ_ID.ORG_B}','${CJ_ID.USER_B_REC}','{"firstName":"SecretOther","lastName":"Engineer","primaryEmail":"secret-other@synthetic.test","professionalSummary":"Ethereum protocol expert with confidential other-recruiter details"}','Other recruiter private source');`);
    const otherTotp = randomUUID();
    psql(db, `insert into app.totp_credentials(id,organization_id,user_id,secret,status,verified_at) values ('${otherTotp}','${AUTHZ_ID.ORG_B}','${CJ_ID.USER_B_REC}','JBSWY3DPEHPK3PXP','active',now());`);
    const otherContext = await browser.newContext();
    const otherToken = await encode({ token: { name: 'Synthetic Recruiter B', email: 'other@synthetic.test', sub: '2002', provider: 'google', providerAccountId: '2002', googleRefreshToken: 'SYNTHETIC-WORKSPACE-TEST', emailVerified: true, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }, secret });
    await otherContext.addCookies([{ name: 'next-auth.session-token', value: otherToken, url: baseURL }, { name: STAFF_MFA_COOKIE, value: createStaffMfaProof(secret, { subject: '2002', userId: CJ_ID.USER_B_REC, credentialId: otherTotp }), url: baseURL }]);
    const otherRegisteredResponse = await otherContext.request.post(`${baseURL}/api/staff/telegram-intake/workers`, { data: { name: 'Other synthetic search worker' } });
    assert.equal(otherRegisteredResponse.status(), 201, await otherRegisteredResponse.text());
    const otherRegistered = (await otherRegisteredResponse.json()).result;
    const vector = first => [first, Math.sqrt(1 - first * first), ...Array(382).fill(0)];
    async function worker(action, data = {}, token = registered.token, expectedStatus = 200) {
        const response = await fetch(`${baseURL}/api/profile-search/worker/${action}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(data) });
        assert.equal(response.status, expectedStatus, await response.clone().text()); return response.json();
    }
    const common = job => ({ jobId: job.id, leaseToken: job.leaseToken, kind: job.kind, indexVersion: job.indexVersion, projectionVersion: job.projectionVersion, chunkerVersion: job.chunkerVersion });
    async function finish(job, token = registered.token, expectedStatus = 200) {
        if (job.kind === 'query') return worker('complete', { ...common(job), querySha256: job.querySha256, result: { embedding: vector(1) } }, token, expectedStatus);
        if (job.kind === 'plan') {
            const text = Buffer.from(job.source.text);
            return worker('complete', { ...common(job), sourceRevision: job.source.revision, sourceSha256: job.source.sha256, result: { byteLength: text.length, chunks: [{ ordinal: 0, startByte: 0, endByte: text.length, sha256: createHash('sha256').update(text).digest('hex'), tokenCount: 100 }] } }, token);
        }
        return worker('complete', { ...common(job), sourceRevision: job.source.revision, sourceSha256: job.source.sha256, manifestSha256: job.manifestSha256, result: { embeddings: job.chunks.map(chunk => ({ ordinal: chunk.ordinal, embedding: vector(job.source.sourceType === 'draft' ? 1 : 0.8) })) } }, token);
    }
    async function indexAll(token = registered.token) {
        for (let count = 0; count < 100; count += 1) { const job = (await worker('claim', {}, token)).job; if (!job) return; assert.notEqual(job.kind, 'query'); await finish(job, token); }
        assert.fail('Synthetic index queue did not drain');
    }
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.stack || error.message));
    const queryInput = page.getByLabel('Describe the candidate you need', { exact: true });
    async function search(text) {
        await queryInput.fill(text);
        const response = page.waitForResponse(response => response.url() === endpoint && response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'search');
        await page.getByRole('button', { name: 'Search by meaning', exact: true }).click();
        const received = await response; assert.equal(received.status(), 202);
        return received.json();
    }
    async function refresh() {
        await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
        await expect(page.getByText('Loading search status…', { exact: true })).toHaveCount(0);
    }
    try {
        await page.goto(`${baseURL}/staff/candidates`);
        await expect(page.getByLabel('Name/email lookup', { exact: true })).toBeVisible();
        await expect(page.getByRole('link', { name: 'Telegram intake', exact: true })).toBeVisible();
        await page.getByRole('link', { name: 'Search by meaning', exact: true }).click();
        await expect(page.getByLabel('Include approved CV text', { exact: true })).toBeChecked();
        await page.getByLabel('Include approved CV text', { exact: true }).uncheck();
        await expect(page.getByText(/The Mac search worker has not checked in recently/)).toBeVisible();
        await expect(page.getByText(/Coverage is incomplete/)).toBeVisible();
        const cancelled = await search('Private first query Solidity experience');
        assert.equal(new URL(page.url()).searchParams.get('queryId'), cancelled.queryId);
        assert.equal(new URL(page.url()).searchParams.has('query'), false);
        assert.ok(!page.url().includes('Solidity'));
        await expect(page.getByText('Waiting for the Mac search worker', { exact: true })).toBeVisible();
        const leased = (await worker('claim')).job; assert.equal(leased.kind, 'query');
        const cancelledResponse = page.waitForResponse(response => response.url() === endpoint && response.request().postDataJSON()?.action === 'cancel');
        await page.getByRole('button', { name: 'Cancel search', exact: true }).click(); assert.equal((await cancelledResponse).status(), 200);
        await expect(page.getByRole('heading', { name: 'Search cancelled', exact: true })).toBeVisible();
        await finish(leased, registered.token, 409);
        await indexAll(); await indexAll(otherRegistered.token);
        // A transient failure after durable planning can be retried without recreating the source.
        psql(db, `update app.profile_search_chunks set embedding=null where source_id in(select id from app.profile_search_sources where source_id='${candidateIds[0]}');
            update app.profile_search_sources set status='failed',error_code='ATTEMPTS_EXHAUSTED',attempts=5 where source_id='${candidateIds[0]}';`);
        await refresh();
        const retryResponse = page.waitForResponse(response => response.url() === endpoint && response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'retryIndex');
        await page.getByRole('button', { name: 'Retry failed indexing', exact: true }).click();
        const retryReceipt = await retryResponse; assert.equal(retryReceipt.status(), 200);
        assert.deepEqual(await retryReceipt.json(), { ok: true, retried: 1, remainingFailed: 0 });
        await expect(page.getByText(/1 profile queued for indexing/)).toBeVisible();
        await expect(queryInput).toHaveValue('Private first query Solidity experience');
        assert.equal(new URL(page.url()).searchParams.has('queryId'), false);
        await expect(page.getByRole('button', { name: 'Retry failed indexing', exact: true })).toHaveCount(0);
        await indexAll(); await refresh();
        await expect(page.getByText('Current search coverage: 30 of 30 accessible profiles indexed', { exact: true })).toBeVisible();
        const result = await search('Solidity engineers with Ethereum protocol experience');
        const queryJob = (await worker('claim')).job; assert.equal(queryJob.kind, 'query'); await finish(queryJob);
        await refresh();
        await expect(page.getByRole('heading', { name: 'Ranked results', exact: true })).toBeVisible();
        const searchUrl = page.url();
        await expect(page.getByRole('link', { name: 'Ready Engineer', exact: true })).toBeVisible();
        await expect(page.getByRole('link', { name: 'Missing Engineer', exact: true })).toBeVisible();
        await expect(page.getByText('My private draft', { exact: true })).toHaveCount(2);
        await expect(page.getByText(/Still needed: CV/)).toBeVisible();
        await expect(page.getByText(/SecretOther/)).toHaveCount(0);
        const privateQueryResponse = await otherContext.request.get(`${endpoint}?queryId=${result.queryId}`);
        assert.ok([403,404].includes(privateQueryResponse.status()));
        const allResults = []; let after = '';
        do {
            const response = await context.request.get(`${endpoint}?queryId=${result.queryId}${after ? `&after=${encodeURIComponent(after)}` : ''}`);
            assert.equal(response.status(), 200, await response.text()); const body = await response.json();
            allResults.push(...body.results); after = body.nextAfter ?? '';
        } while (after);
        assert.equal(allResults.length, 30); assert.equal(allResults.some(row => row.sourceId === privateOtherId), false);
        await page.getByRole('button', { name: 'Next results', exact: true }).click();
        await expect(page.getByText('Page 2 · Up to 25 results per page', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Next results', exact: true })).toBeDisabled();
        await page.getByRole('button', { name: 'Previous results', exact: true }).click();
        const firstCandidateName = allResults.find(row => row.sourceType === 'candidate').displayName;
        await page.getByRole('link', { name: firstCandidateName, exact: true }).click();
        const preview = page.getByRole('dialog', { name: firstCandidateName, exact: true });
        await expect(preview).toBeVisible(); await expect(preview.getByRole('link', { name: 'Open full candidate', exact: true })).toBeVisible();
        assert.equal(page.url(), searchUrl); await page.keyboard.press('Escape');
        await page.getByRole('link', { name: 'Ready Engineer', exact: true }).click();
        await expect(page.getByRole('dialog', { name: 'Review draft', exact: true })).toBeVisible();
        await page.goto(searchUrl);
        await expect(queryInput).toHaveValue('Solidity engineers with Ethereum protocol experience');
        await page.getByLabel('Only drafts ready to approve', { exact: true }).check();
        const filtered = await search('Solidity engineers ready to review');
        await finish((await worker('claim')).job); await refresh();
        const filteredBody = await (await context.request.get(`${endpoint}?queryId=${filtered.queryId}`)).json();
        assert.ok(filteredBody.results.some(row => row.sourceType === 'candidate'));
        assert.ok(filteredBody.results.some(row => row.sourceId === readyDraft.id));
        assert.equal(filteredBody.results.some(row => row.sourceId === missingDraft.id), false);
        await expect(page.getByRole('link', { name: 'Missing Engineer', exact: true })).toHaveCount(0);
        mkdirSync(join(root, 'test-results'), { recursive: true });
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: join(root, 'test-results/staff-workspace-profile-search.png'), fullPage: true });
        await page.screenshot({ path: join(root, 'test-results/staff-workspace-profile-search-viewport.png') });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: join(root, 'test-results/staff-workspace-profile-search-mobile.png'), fullPage: true });
        await page.screenshot({ path: join(root, 'test-results/staff-workspace-profile-search-mobile-viewport.png') });
        await page.getByLabel('Search scope', { exact: true }).selectOption('my_drafts');
        const failed = await search('Long query that the synthetic tokenizer rejects');
        const failureJob = (await worker('claim')).job;
        await worker('fail', { jobId: failureJob.id, leaseToken: failureJob.leaseToken, kind: 'query', code: 'INPUT_TOO_LONG', retryAfterSeconds: 1 });
        await refresh();
        await expect(page.getByText(/Shorten the search description/)).toBeVisible();
        assert.equal((await (await context.request.get(`${endpoint}?queryId=${failed.queryId}`)).json()).status, 'failed');
        await expect(queryInput).toBeEnabled();
        psql(db, `update app.profile_search_queries set expires_at=now()-interval '1 second' where id='${failed.queryId}';`);
        await refresh();
        await expect(page.getByRole('heading', { name: 'Search expired', exact: true })).toBeVisible();
        await expect(queryInput).toBeEnabled();
        assert.deepEqual(pageErrors, []);
    } catch (error) { console.error(output.join('').slice(-20000)); throw error; }
});
