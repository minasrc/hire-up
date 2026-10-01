import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { createCvAnalysisWorker } from '../../services/cv-analysis-worker/worker.mjs';
import { createPendingStore } from '../../services/cv-analysis-worker/vault.mjs';
import { createPendingStore as extractionStore } from '../../services/telegram-extraction-worker/store.mjs';
import { createCvAnalysisProvider, SYSTEM_PROMPT } from '../../services/cv-analysis-worker/provider.mjs';
import { createContentReader } from '../../services/cv-analysis-worker/transport.mjs';
import { CV_ANALYSIS_PARSER_VERSION, CV_ANALYSIS_PROMPT_VERSION } from '../../src/lib/cv-analysis-contracts.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const bytes = Buffer.from('Synthetic validated PDF bytes'); const text = 'Álex Rivera alex@example.test';
const block = { ordinal: 0, kind: 'pdf_page', page: 1, text, sha256: sha(text) };
const parsed = { parserVersion: CV_ANALYSIS_PARSER_VERSION, documentSha256: sha(bytes), textSha256: sha(text), blocks: [block] };
const metadata = { model: 'synthetic-model', reportedModel: null, promptVersion: CV_ANALYSIS_PROMPT_VERSION };
const result = { facts: [{ field: 'firstName', value: 'Álex', evidence: [{ blockOrdinal: 0, startByte: 0, endByte: Buffer.byteLength('Álex'), quote: 'Álex' }] }], issues: [] };
const job = stage => ({ id: randomUUID(), leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 120000).toISOString(), stage, sourceDigest: 'a'.repeat(64), source: { draftId: randomUUID(), documentRevision: 1, documentSha256: sha(bytes), sizeBytes: bytes.length, filename: 'Synthetic.pdf', extension: 'pdf', parserVersion: CV_ANALYSIS_PARSER_VERSION, promptVersion: CV_ANALYSIS_PROMPT_VERSION, blocks: stage === 'facts' ? [block] : null } });
const memory = () => { let value; return { load: () => value, save: pending => { value = structuredClone(pending); }, clear: () => { value = null; } }; };
const httpError = status => Object.assign(new Error('private body must not be logged'), { status });
async function server(t, handler) { const app = createServer(handler); await new Promise(resolve => app.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => app.close(resolve))); return `http://127.0.0.1:${app.address().port}`; }
async function privateRoot(t) { const root = await mkdtemp(join(tmpdir(), 'cv-analysis-worker-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }

test('both stage receipts survive encrypted restart and uncertain ACK without rerunning work', async t => {
    const root = await privateRoot(t); const options = { root, server: 'https://synthetic.example', workerToken: 'a'.repeat(64) };
    for (const stage of ['parse', 'facts']) {
        const task = job(stage); let work = 0; let claims = 0; let completed;
        const host = async (action, body) => { if (action === 'claim') { claims += 1; return { job: task }; } completed = structuredClone(body); throw httpError(503); };
        const worker = createCvAnalysisWorker({ host, vault: createPendingStore(options), readContent: async () => bytes, parse: async () => { work += 1; return parsed; }, extract: async () => { work += 1; return { result, metadata }; } });
        await assert.rejects(worker.tick(), { status: 503 }); assert.equal(work, 1);
        const retry = createCvAnalysisWorker({ host: async (action, body) => { assert.equal(action, 'complete'); assert.deepEqual(body, completed); return { ok: true }; }, vault: createPendingStore(options), readContent: () => assert.fail(), parse: () => assert.fail(), extract: () => assert.fail() });
        assert.equal(await retry.tick(), 'completed'); assert.equal(createPendingStore(options).load(), null); assert.equal(claims, 1);
    }
});
test('encrypted CV state accepts near1MiB payload and cannot collide with extraction or another token', async t => {
    const root = await privateRoot(t); const options = { root, server: 'https://synthetic.example', workerToken: 'b'.repeat(64) };
    const cv = createPendingStore(options); const extraction = extractionStore(options); const payload = { marker: 'private-profile-marker', body: 'x'.repeat(1048000) };
    cv.save(payload); extraction.save({ kind: 'telegram-only' });
    assert.deepEqual(createPendingStore(options).load(), payload); assert.deepEqual(extraction.load(), { kind: 'telegram-only' });
    assert.equal(createPendingStore({ ...options, workerToken: 'c'.repeat(64) }).load(), null);
    async function inspect(path) { for (const entry of await readdir(path, { withFileTypes: true })) { const full = join(path, entry.name); const info = await stat(full); assert.equal(info.mode & 0o077, 0); if (entry.isDirectory()) await inspect(full); else assert(!(await readFile(full, 'utf8')).includes('private-profile-marker')); } }
    await inspect(root); cv.clear(); assert.deepEqual(extraction.load(), { kind: 'telegram-only' });
});
test('wrong bytes and parser errors fail explicitly; stale/revoked content never runs a parser', async () => {
    for (const scenario of ['wrong', 'OCR_REQUIRED', 403, 409]) {
        const task = job('parse'); const reports = []; let parses = 0;
        const worker = createCvAnalysisWorker({ vault: memory(), host: async (action, body) => { if (action === 'claim') return { job: task }; reports.push({ action, body }); return { ok: true }; }, readContent: async () => { if (typeof scenario === 'number') throw httpError(scenario); return scenario === 'wrong' ? Buffer.from('wrong') : bytes; }, parse: async () => { parses += 1; throw Object.assign(new Error(), { code: scenario }); } });
        if (scenario === 403) await assert.rejects(worker.tick(), { status: 403 }); else assert.equal(await worker.tick(), scenario === 409 ? 'fenced' : 'failed');
        assert.equal(parses, scenario === 'OCR_REQUIRED' ? 1 : 0);
        if (typeof scenario === 'number') assert.equal(reports.length, 0); else assert.equal(reports[0].body.code, scenario === 'wrong' ? 'INVALID_DOCUMENT' : scenario);
    }
});
test('definitive rejected completion persists a failure receipt across lost ACK; 409 clears stale work', async () => {
    const vault = memory(); const task = job('facts'); let count = 0;
    const worker = createCvAnalysisWorker({ vault, extract: async () => ({ result, metadata }), host: async action => { if (action === 'claim') return { job: task }; count += 1; throw httpError(action === 'complete' ? 422 : 503); } });
    await assert.rejects(worker.tick(), { status: 503 }); assert.equal(vault.load().action, 'fail'); assert.equal(vault.load().body.code, 'INVALID_RESULT'); assert.equal(count, 2);
    const retry = createCvAnalysisWorker({ vault, host: async action => { assert.equal(action, 'fail'); throw httpError(409); } }); assert.equal(await retry.tick(), 'fenced'); assert.equal(vault.load(), null);
});
test('cancellation during parsing creates no failure/result and concurrent tick is bounded', async () => {
    const controller = new AbortController(); const vault = memory(); let started; let finish;
    const ready = new Promise(resolve => { started = resolve; }); const waiting = new Promise(resolve => { finish = resolve; });
    const worker = createCvAnalysisWorker({ vault, host: async action => { assert.equal(action, 'claim'); return { job: job('parse') }; }, readContent: async () => bytes, parse: async () => { started(); await waiting; return parsed; } });
    const tick = worker.tick({ signal: controller.signal }); await ready; assert.equal(await worker.tick(), 'busy'); controller.abort(); finish(); await assert.rejects(tick, { code: 'STOPPED' }); assert.equal(vault.load(), undefined);
});
test('real loopback provider uses strict schema/no tools and validates UTF8 evidence rather than trusting JSON', async t => {
    let invalid = false; const endpoint = await server(t, async (request, response) => {
        let body = ''; for await (const chunk of request) body += chunk;
        const submitted = JSON.parse(body); assert.equal(submitted.messages[0].content, SYSTEM_PROMPT); assert.equal(submitted.response_format.type, 'json_schema'); assert.equal(submitted.tools, undefined);
        const output = structuredClone(result); if (invalid) output.facts[0].evidence[0].endByte -= 1;
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ model: 'synthetic-model', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }));
    });
    const provider = createCvAnalysisProvider({ providerBaseUrl: endpoint, providerModel: 'synthetic-model', providerTokenFile: 'unused' }, { readTokenImpl: async () => 'synthetic-provider-token' });
    assert.deepEqual((await provider(job('facts').source)).result, result); invalid = true; await assert.rejects(provider(job('facts').source), { code: 'INVALID_RESULT' });
});
test('scoped content transport enforces streaming length and preserves permission status', async () => {
    const reader = createContentReader({ serverUrl: 'https://synthetic.example', workerToken: 'synthetic', fetchImpl: async (_url, options) => { assert.equal(options.redirect, 'error'); return new Response(new Uint8Array(4194305)); } });
    await assert.rejects(reader({}), { code: 'INVALID_DOCUMENT' });
    const denied = createContentReader({ serverUrl: 'https://synthetic.example', workerToken: 'synthetic', fetchImpl: async () => new Response('private body', { status: 403 }) }); await assert.rejects(denied({}), { status: 403 });
});
test('real CLI completes a facts job with private config and synthetic HTTP provider', async t => {
    const root = await privateRoot(t); const task = job('facts'); let completions = 0;
    const endpoint = await server(t, async (request, response) => {
        let text = ''; for await (const chunk of request) text += chunk; const body = JSON.parse(text);
        response.setHeader('Content-Type', 'application/json');
        if (request.url.endsWith('/claim')) response.end(JSON.stringify({ job: task }));
        else if (request.url.endsWith('/complete')) { completions += 1; assert.deepEqual(body.result, result); response.end('{"ok":true}'); }
        else if (request.url.endsWith('/chat/completions')) response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }));
        else { response.statusCode = 404; response.end('{}'); }
    });
    const workerTokenFile = join(root, 'worker.token'); const providerTokenFile = join(root, 'provider.token'); const config = join(root, 'config.json');
    await writeFile(workerTokenFile, 'd'.repeat(64), { mode: 0o600 }); await writeFile(providerTokenFile, 'synthetic-provider-token', { mode: 0o600 });
    await writeFile(config, JSON.stringify({ serverUrl: endpoint, providerBaseUrl: endpoint, providerModel: 'synthetic-model', workerTokenFile, providerTokenFile, stateDirectory: join(root, 'state') }), { mode: 0o600 });
    const output = await new Promise((resolve, reject) => { const child = spawn(process.execPath, ['services/cv-analysis-worker/cli.mjs', '--config', config, '--once'], { stdio: ['ignore', 'pipe', 'pipe'] }); let text = ''; child.stdout.on('data', chunk => { text += chunk; }); child.stderr.on('data', chunk => { text += chunk; }); child.on('error', reject); child.on('close', code => resolve({ code, text })); });
    assert.equal(output.code, 0, output.text); assert.equal(output.text.trim(), 'completed'); assert.equal(completions, 1);
});
