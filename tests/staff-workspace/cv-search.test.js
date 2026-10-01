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
import { clientJobFixtureSql } from '../support/client-job-workflows.js';
import { STAFF_MFA_COOKIE, createStaffMfaProof } from '../../src/lib/staff-mfa-cookie.js';

const expect = baseExpect.configure({ timeout: 15000 });
const root = resolve(process.env.CV_SEARCH_TEST_ROOT || fileURLToPath(new URL('../../', import.meta.url)));

async function waitForServer(url) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) }).catch(() => null);
        if (response?.ok) return;
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Temporary profile search server did not start');
}

test('Approved CV search exposes coverage, explicit fallback and safe result invalidation', { timeout: 240_000 }, async t => {
    assertLocalTestEnvironment();
    const db = await startPostgresContainer('pgcvsearchui', POSTGRES_17_IMAGE, { publish: true });
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
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
    const queryInput = page.getByLabel('Describe the candidate you need', { exact: true });
    async function search(text) {
        await queryInput.fill(text);
        const response = page.waitForResponse(response => response.url() === endpoint && response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'search');
        await page.getByRole('button', { name: 'Search by meaning', exact: true }).click(); const received = await response;
        assert.equal(received.status(), 202); return received.json();
    }
    async function refresh() { await page.getByRole('button', { name: 'Refresh status', exact: true }).click(); await expect(page.getByText('Loading search status…', { exact: true })).toHaveCount(0); }
    const mockQueries = new Map(); const posted = []; const initialModes = [];
    let mockAccess = true; let unsafe = false; let indexChanged = false; let capacity = false;
    const sourceId = randomUUID();
    const mockCoverage = includeCv => ({ eligible: 3, indexed: 3, fullyIndexed: includeCv ? 2 : 3, pending: includeCv ? 1 : 0, failed: 0, retryable: 0, corpusChanged: false, cv: includeCv ? { attached: 3, withoutRetainedText: 1, eligible: 2, indexed: 1, pending: 1, failed: 0, retryable: 0 } : null });
    await page.route('**/api/staff/profile-search**', async route => {
        const request = route.request(); const url = new URL(request.url()); const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        if (request.method() === 'POST') {
            const body = request.postDataJSON(); posted.push(body);
            const queryId = randomUUID(); mockQueries.set(queryId, body);
            return json({ queryId, status: 'queued', expiresAt: new Date(Date.now() + 900000).toISOString() }, 202);
        }
        const queryId = url.searchParams.get('queryId'); const submitted = queryId ? mockQueries.get(queryId) : null;
        const includeCv = submitted?.includeCv ?? url.searchParams.get('includeCv') === 'true';
        const base = { coverage: mockCoverage(includeCv), includeCv, cvAvailable: mockAccess, workerAvailable: true, capacity: includeCv ? { readyChunks: 4, maxReadyChunks: 10000, withinLimit: !capacity } : null };
        if (!queryId) { initialModes.push(includeCv); return json(base); }
        const result = { sourceType: 'candidate', sourceId, sourceRevision: '1', displayName: 'Mock CV candidate', headline: 'Engineer', location: 'London', hasCv: true, missingFields: [], score: 0.9, matchedComponent: includeCv ? 'cv' : 'profile', matchedDocument: includeCv ? { id: randomUUID(), filename: 'Reviewed-CV.pdf' } : null, matchedText: includeCv ? 'CV-only private excerpt sentinel' : 'Profile-only public excerpt', href: `/staff/candidates/${sourceId}` };
        // Deliberately include stale cached data on the error to verify the UI drops it defensively.
        return json({ ...base, queryId, query: submitted.query, scope: submitted.scope, readyOnly: submitted.readyOnly, status: unsafe || indexChanged || capacity && includeCv ? 'failed' : 'completed', errorCode: indexChanged ? 'INDEX_CHANGED' : unsafe ? 'CV_RESULTS_CHANGED' : capacity && includeCv ? 'SEARCH_CAPACITY' : null, results: capacity && includeCv ? [] : [result], nextAfter: unsafe || indexChanged ? 'stale-cursor' : url.searchParams.has('after') ? null : 'next-page', expiresAt: new Date(Date.now() + 900000).toISOString() });
    });
    try {
        await page.goto(`${baseURL}/staff/candidates/search`);
        await expect(page.getByLabel('Include approved CV text', { exact: true })).toBeChecked();
        await expect(page.getByText('CV text: 1 of 2 available texts indexed', { exact: true })).toBeVisible();
        assert.deepEqual(initialModes.slice(0, 2), [false, true]);
        const first = await search('Experience available only in approved CV text');
        await expect(page.getByText('CV excerpt · Reviewed-CV.pdf', { exact: true })).toBeVisible();
        assert.equal(posted.at(-1).includeCv, true); assert.equal(page.url().includes('Experience'), false);
        await page.getByRole('button', { name: 'Next results', exact: true }).click();
        await expect(page.getByText('Page 2 · Up to 25 results per page', { exact: true })).toBeVisible();
        unsafe = true; await refresh();
        await expect(page.getByText(/Previous results were cleared/)).toBeVisible();
        await expect(page.getByText('CV-only private excerpt sentinel', { exact: true })).toHaveCount(0);
        await expect(page.getByText(/CV text:/)).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Next results', exact: true })).toHaveCount(0);
        unsafe = false;
        await page.getByRole('button', { name: 'Run a new search', exact: true }).click();
        await expect(page.getByText('Page 1 · Up to 25 results per page', { exact: true })).toBeVisible();
        assert.notEqual(new URL(page.url()).searchParams.get('queryId'), first.queryId);
        assert.notEqual(posted.at(-1).operationId, posted[0].operationId);
        capacity = true; await search('Large CV corpus');
        await expect(page.getByText(/No partial results were returned/)).toBeVisible();
        await page.getByRole('button', { name: 'Search profiles only', exact: true }).click();
        await expect(page.getByText('Profile-only public excerpt', { exact: true })).toBeVisible();
        assert.equal(posted.at(-1).includeCv, false); await expect(page.getByText(/CV text:/)).toHaveCount(0);
        await page.getByLabel('Search scope', { exact: true }).selectOption('my_drafts');
        await expect(page.getByLabel('Include approved CV text', { exact: true })).toHaveCount(0);
        await search('My private draft profile'); assert.equal(posted.at(-1).includeCv, false);
        mockAccess = false; capacity = false;
        await page.goto(`${baseURL}/staff/candidates/search`);
        await expect(page.getByText('Current search coverage: 3 of 3 accessible profiles indexed', { exact: true })).toBeVisible();
        await expect(page.getByLabel('Include approved CV text', { exact: true })).toHaveCount(0);
        await expect(page.getByText(/CV text:/)).toHaveCount(0);
        // A global index update also invalidates profile-only searches without document permission.
        const oldIndexQuery = await search('Profile-only query before index update');
        await expect(page.getByText('Profile-only public excerpt', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Next results', exact: true }).click();
        await expect(page.getByText('Page 2 · Up to 25 results per page', { exact: true })).toBeVisible();
        const oldOperation = posted.at(-1).operationId;
        indexChanged = true; await refresh();
        await expect(page.getByText('Our search index was updated. Run this search again.', { exact: true })).toBeVisible();
        await expect(page.getByText('Profile-only public excerpt', { exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Next results', exact: true })).toHaveCount(0);
        indexChanged = false;
        await page.getByRole('button', { name: 'Run a new search', exact: true }).click();
        await expect(page.getByText('Page 1 · Up to 25 results per page', { exact: true })).toBeVisible();
        assert.notEqual(posted.at(-1).operationId, oldOperation);
        assert.notEqual(new URL(page.url()).searchParams.get('queryId'), oldIndexQuery.queryId);
        assert.equal(posted.at(-1).includeCv, false);
        await page.unroute('**/api/staff/profile-search**');
        if (process.env.CV_SEARCH_UI_MOCK_ONLY === '1') { assert.deepEqual(pageErrors, []); return; }
        assert.ok(migrations.some(name => name.includes('cv_search')), 'Approved CV search migration is required for real backend acceptance');
        // The real API setup approves retained text through the CV analysis workflow.
        const sha = value => createHash('sha256').update(value).digest('hex');
        async function analysisWorker(action, data = {}) {
            const response = await fetch(`${baseURL}/api/cv-analysis/worker/${action}`, { method: 'POST', headers: { authorization: `Bearer ${registered.token}`, 'content-type': 'application/json' }, body: JSON.stringify(data) });
            assert.equal(response.status, 200, await response.clone().text()); return response.json();
        }
        async function candidate(name, retain) {
            let response = await context.request.post(draftsEndpoint, { data: { fields: { firstName: name, lastName: 'Engineer', primaryEmail: `${name.toLowerCase()}@synthetic.test`, professionalSummary: 'Builds software systems.' }, sourceTitle: 'Synthetic candidate CV' } });
            assert.equal(response.status(), 201, await response.text()); let draft = (await response.json()).result;
            response = await context.request.post(`${draftsEndpoint}/${draft.id}/cv`, { multipart: { expectedVersion: String(draft.version), cvFile: { name: `${name}-CV.pdf`, mimeType: 'application/pdf', buffer: pdf } } });
            assert.equal(response.status(), 200, await response.text()); draft = (await response.json()).result;
            if (retain) {
                response = await context.request.post(`${baseURL}/api/staff/cv-analysis`, { data: { action: 'analyze', draftId: draft.id, expectedDocumentRevision: draft.documentRevision, operationId: randomUUID() } }); assert.equal(response.status(), 200, await response.text());
                let job = (await analysisWorker('claim')).job;
                const text = 'Expert in Rust protocol audits and distributed systems.\n\nCV tail: led zero-knowledge proof engineering and multilingual infrastructure delivery.';
                await analysisWorker('complete', { jobId: job.id, leaseToken: job.leaseToken, sourceDigest: job.sourceDigest, stage: 'parse', result: { parserVersion: job.source.parserVersion, documentSha256: job.source.documentSha256, textSha256: sha(text), blocks: [{ ordinal: 0, kind: 'pdf_page', page: 1, text, sha256: sha(text) }] } });
                job = (await analysisWorker('claim')).job;
                await analysisWorker('complete', { jobId: job.id, leaseToken: job.leaseToken, sourceDigest: job.sourceDigest, stage: 'facts', result: { facts: [], issues: [] }, metadata: { model: 'synthetic-model', promptVersion: job.source.promptVersion, reportedModel: null } });
                draft = (await (await context.request.get(`${draftsEndpoint}/${draft.id}`)).json()).result;
            }
            response = await context.request.post(`${draftsEndpoint}/${draft.id}/decision`, { data: { action: 'approve', expectedVersion: draft.version, operationId: randomUUID() } }); assert.equal(response.status(), 200, await response.text()); return (await response.json()).result.candidateId;
        }
        const retainedCandidate = await candidate('Retained', true); await candidate('Unparsed', false);
        const vector = first => [first, Math.sqrt(1 - first * first), ...Array(382).fill(0)];
        async function worker(action, data = {}) {
            const response = await fetch(`${baseURL}/api/profile-search/worker/${action}`, { method: 'POST', headers: { authorization: `Bearer ${registered.token}`, 'content-type': 'application/json' }, body: JSON.stringify(data) });
            assert.equal(response.status, 200, await response.clone().text()); return response.json();
        }
        async function finish(job) {
            const common = { jobId: job.id, leaseToken: job.leaseToken, kind: job.kind, indexVersion: job.indexVersion, projectionVersion: job.projectionVersion, chunkerVersion: job.chunkerVersion };
            if (job.kind === 'query') return worker('complete', { ...common, querySha256: job.querySha256, result: { embedding: vector(1) } });
            const source = { sourceRevision: job.source.revision, sourceSha256: job.source.sha256 };
            if (job.kind === 'plan') {
                const bytes = Buffer.from(job.source.text); const boundaries = job.source.component === 'cv' ? [0, bytes.indexOf('\n\n') + 2, bytes.length] : [0, bytes.length];
                return worker('complete', { ...common, ...source, result: { byteLength: bytes.length, chunks: boundaries.slice(0, -1).map((startByte, ordinal) => ({ ordinal, startByte, endByte: boundaries[ordinal + 1], sha256: sha(bytes.subarray(startByte, boundaries[ordinal + 1])), tokenCount: 100 })) } });
            }
            return worker('complete', { ...common, ...source, manifestSha256: job.manifestSha256, result: { embeddings: job.chunks.map(chunk => ({ ordinal: chunk.ordinal, embedding: vector(job.source.component === 'cv' ? chunk.ordinal === 1 ? 1 : 0.9 : 0.5) })) } });
        }
        for (let count = 0; count < 100; count += 1) { const job = (await worker('claim', { capabilities: ['minilm-v1', 'approved-cv-v1'] })).job; if (!job) break; await finish(job); if (count === 99) assert.fail('Index queue did not drain'); }
        await page.goto(`${baseURL}/staff/candidates/search?scope=approved`);
        await expect(page.getByLabel('Include approved CV text', { exact: true })).toBeChecked();
        await expect(page.getByText('CV text: 1 of 1 available texts indexed', { exact: true })).toBeVisible();
        await expect(page.getByText(/No searchable CV text: 1/)).toBeVisible();
        const searched = await search('Zero knowledge proof engineering in the CV tail');
        await finish((await worker('claim', { capabilities: ['minilm-v1', 'approved-cv-v1'] })).job); await refresh();
        await expect(page.getByText('CV excerpt · Retained-CV.pdf', { exact: true })).toBeVisible();
        await expect(page.getByText(/CV tail: led zero-knowledge/)).toBeVisible();
        await expect(page.getByRole('link', { name: 'Retained Engineer', exact: true })).toHaveCount(1);
        const result = await (await context.request.get(`${endpoint}?queryId=${searched.queryId}`)).json();
        assert.equal(result.results.filter(row => row.sourceId === retainedCandidate).length, 1); assert.equal(result.results[0].matchedComponent, 'cv');
        mkdirSync(join(root, 'test-results'), { recursive: true }); await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: join(root, 'test-results/staff-workspace-cv-search.png'), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: join(root, 'test-results/staff-workspace-cv-search-mobile.png'), fullPage: true });
        psql(db, `delete from app.candidate_reviewed_cv_text where candidate_id='${retainedCandidate}';`);
        await refresh(); await expect(page.getByText(/Previous results were cleared/)).toBeVisible();
        await expect(page.getByText(/CV tail: led zero-knowledge/)).toHaveCount(0); await expect(page.getByText(/CV text:/)).toHaveCount(0);
        await page.getByLabel('Include approved CV text', { exact: true }).uncheck();
        await search('Ordinary software systems'); await finish((await worker('claim', { capabilities: ['minilm-v1', 'approved-cv-v1'] })).job); await refresh();
        await expect(page.getByRole('link', { name: 'Retained Engineer', exact: true })).toBeVisible();
        await expect(page.getByText(/CV excerpt/)).toHaveCount(0);
        assert.deepEqual(pageErrors, []);
    } catch (error) { console.error(output.join('').slice(-20000)); console.error((await page.locator('body').innerText()).slice(-15000)); throw error; }
});
