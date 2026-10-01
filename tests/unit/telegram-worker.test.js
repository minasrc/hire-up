import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    MODEL, INDEX_VERSION, EMBEDDING_URL, validateConfig, loadConfig, readToken,
    requestJson, embeddingRequest, embeddingResult, backoff, createWorker,
} from '../../services/telegram-worker/worker.mjs';

const now = Date.now();
const secret = 'private-synthetic-worker-token-000000000';
const config = { serverUrl: 'https://app.example', workerTokenFile: '/worker-token', embeddingTokenFile: '/embedding-token' };
const vector = () => [1, ...Array(383).fill(0)];
const job = () => ({ id: 'job_1', leaseToken: 'synthetic-lease-token-000000000', leaseExpiresAt: new Date(now + 120_000).toISOString(),
    kind: 'embedding', payload: { texts: ['Synthetic confidential text'], inputType: 'passage', indexVersion: INDEX_VERSION } });
const embedded = () => ({ model: MODEL, index_version: INDEX_VERSION, data: [{ index: 0, embedding: vector() }] });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fixture(handler) {
    const calls = [], pauses = [], logs = [];
    const worker = createWorker(config, {
        now: () => now, random: () => 0,
        readTokenImpl: async path => path === '/worker-token' ? secret : 'private-synthetic-embedding-token-0000000',
        fetchImpl: async (url, options) => { calls.push({ url, ...options, body: JSON.parse(options.body) }); return handler(url, options, calls); },
        wait: async ms => { pauses.push(ms); }, log: status => logs.push(status),
    });
    return { worker, calls, pauses, logs };
}

test('config permits HTTPS and explicit loopback only; never URL credentials or forwarding paths', () => {
    assert.equal(validateConfig(config).serverUrl, 'https://app.example');
    for (const serverUrl of ['http://app.example', 'https://user:password@app.example', 'https://app.example/api', 'https://app.example/?token=secret', 'https://app.example/#secret', 'file:///tmp/a']) {
        assert.throws(() => validateConfig({ ...config, serverUrl }), /INVALID_CONFIG/);
    }
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
        const local = { ...config, serverUrl: `http://${host}:4000` };
        assert.throws(() => validateConfig(local));
        assert.equal(validateConfig({ ...local, allowInsecureLocalhost: true }).serverUrl, local.serverUrl);
    }
    assert.throws(() => validateConfig({ ...config, serverUrl: 'http://localhost.evil', allowInsecureLocalhost: true }));
});

test('private file credentials and config paths are validated with redacted failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'telegram-worker-'));
    try {
        const path = join(dir, 'token');
        await writeFile(path, `${secret}\n`, { mode: 0o600 });
        assert.equal(await readToken(path), secret);
        await chmod(path, 0o644);
        await assert.rejects(readToken(path), /^Error: CREDENTIAL_UNAVAILABLE$/);
        await chmod(path, 0o600);
        await writeFile(path, `${secret}\nInjected: value`);
        await assert.rejects(readToken(path), /^Error: CREDENTIAL_UNAVAILABLE$/);
        const configPath = join(dir, 'worker.json');
        await writeFile(configPath, JSON.stringify({ serverUrl: 'http://localhost:4000', workerTokenFile: 'token', allowInsecureLocalhost: true }));
        const loaded = await loadConfig(configPath, {});
        assert.equal(loaded.workerTokenFile, path);
        assert.equal(loaded.allowInsecureLocalhost, true);
        assert.ok(createWorker(loaded));
        assert.equal((await loadConfig(configPath, { TELEGRAM_WORKER_SERVER_URL: 'https://override.example' })).serverUrl, 'https://override.example');
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test('one embedding job uses scoped credentials, exact model and lease on completion', async () => {
    const f = fixture(url => json(url.endsWith('/claim') ? { job: job() } : url === EMBEDDING_URL ? embedded() : { ok: true }));
    assert.equal(await f.worker.run({ once: true }), 'COMPLETED');
    assert.equal(f.calls.length, 3);
    assert.deepEqual(f.calls.map(call => call.redirect), ['error', 'error', 'error']);
    assert.equal(f.calls[0].headers.authorization, `Bearer ${secret}`);
    assert.notEqual(f.calls[1].headers.authorization, f.calls[0].headers.authorization);
    assert.equal(f.calls[1].url, EMBEDDING_URL);
    assert.equal(f.calls[1].body.input_type, 'passage');
    assert.deepEqual(f.calls[2].body, { jobId: job().id, leaseToken: job().leaseToken, result: { indexVersion: INDEX_VERSION, embeddings: [vector()] } });
    assert.deepEqual(f.logs, ['COMPLETED']);
});

test('idle and malformed claims never call inference or echo response contents', async () => {
    for (const [body, expected] of [[{ job: null }, 'IDLE'], [{ privateText: secret }, 'INVALID_CLAIM'], [{ job: { ...job(), leaseToken: '' } }, 'INVALID_CLAIM']]) {
        const f = fixture(() => json(body));
        assert.equal(await f.worker.run({ once: true }), expected);
        assert.equal(f.calls.length, 1);
        assert.equal(JSON.stringify(f.logs).includes(secret), false);
    }
});

test('invalid jobs fail with a fixed code without private payload forwarding', async () => {
    for (const mutate of [j => { j.kind = 'telegram'; }, j => { j.payload.indexVersion = 'other'; }, j => { j.payload.texts = ['']; }, j => { j.payload.inputType = 'other'; }]) {
        const invalid = job(); mutate(invalid);
        const f = fixture(url => json(url.endsWith('/claim') ? { job: invalid } : { ok: true }));
        assert.equal(await f.worker.runOnce(), 'FAILED');
        assert.equal(f.calls.length, 2);
        assert.equal(f.calls[1].url.endsWith('/fail'), true);
        assert.deepEqual(f.calls[1].body, { jobId: job().id, leaseToken: job().leaseToken, code: 'INVALID_JOB' });
    }
});

test('local service failures and invalid vectors are sanitized', async () => {
    for (const [response, code] of [[json({ raw: secret }, 503), 'EMBEDDING_UNAVAILABLE'], [json({ raw: secret }, 422), 'INVALID_JOB'], [json({ ...embedded(), index_version: 'other' }), 'EMBEDDING_UNAVAILABLE']]) {
        const f = fixture(url => url.endsWith('/claim') ? json({ job: job() }) : url === EMBEDDING_URL ? response : json({ ok: true }));
        assert.equal(await f.worker.run({ once: true }), 'FAILED');
        assert.deepEqual(f.calls.at(-1).body, { jobId: job().id, leaseToken: job().leaseToken, code });
        assert.equal(JSON.stringify(f.logs).includes(secret), false);
    }
});

test('completion retry reuses results and never turns uncertain success into failure', async () => {
    let acks = 0;
    const f = fixture(url => {
        if (url.endsWith('/claim')) return json({ job: job() });
        if (url === EMBEDDING_URL) return json(embedded());
        if (++acks < 3) throw new Error(`private response ${secret}`);
        return json({ ok: true });
    });
    assert.equal(await f.worker.runOnce(), 'COMPLETED');
    assert.equal(f.calls.filter(call => call.url === EMBEDDING_URL).length, 1);
    assert.deepEqual(f.calls[2].body, f.calls[4].body);
    assert.deepEqual(f.pauses, [750, 1500]);
    assert.equal(f.calls.some(call => call.url.endsWith('/fail')), false);
});

test('ACK retry count is bounded; stale 409 stops immediately and never submits fail', async () => {
    for (const status of [503, 409, 401]) {
        const f = fixture(url => url.endsWith('/claim') ? json({ job: job() }) : url === EMBEDDING_URL ? json(embedded()) : json({ private: secret }, status));
        assert.equal(await f.worker.runOnce(), status === 409 ? 'LEASE_EXPIRED' : 'ACK_UNAVAILABLE');
        assert.equal(f.calls.length, status === 503 ? 5 : 3);
        assert.equal(f.calls.some(call => call.url.endsWith('/fail')), false);
    }
});

test('short lease does not begin inference', async () => {
    const f = fixture(() => json({ job: { ...job(), leaseExpiresAt: new Date(now + 1000).toISOString() } }));
    assert.equal(await f.worker.runOnce(), 'LEASE_EXPIRED');
    assert.equal(f.calls.length, 1);
});

test('vectors are finite, normalized, exact-sized, correctly reordered and unique', () => {
    const response = embedded();
    response.data = [{ index: 1, embedding: vector() }, { index: 0, embedding: [...vector()].map(v => -v) }];
    assert.equal(embeddingResult(response, 2).embeddings[0][0], -1);
    for (const bad of [[0], Array(384).fill(0), [Infinity, ...Array(383).fill(0)], [NaN, ...Array(383).fill(0)], Array(384).fill(1)]) {
        assert.throws(() => embeddingResult({ ...embedded(), data: [{ index: 0, embedding: bad }] }, 1));
    }
    assert.throws(() => embeddingResult({ ...response, data: [response.data[0], response.data[0]] }, 2));
    assert.throws(() => embeddingResult({ ...embedded(), model: 'other' }, 1));
});

test('batch count, text bounds and encoded request size are enforced', () => {
    for (const texts of [[], Array(33).fill('x'), ['x'.repeat(16001)], Array(32).fill('😀'.repeat(16000))]) {
        assert.throws(() => embeddingRequest({ ...job(), payload: { ...job().payload, texts } }));
    }
    assert.equal(embeddingRequest({ ...job(), payload: { ...job().payload, inputType: 'query' } }).input_type, 'query');
});

test('redirects, oversized responses, malformed JSON and errors never leak raw bodies', async () => {
    for (const response of [new Response(null, { status: 302, headers: { location: 'https://evil.example' } }), new Response('x'.repeat(1024 * 1024 + 1)), new Response(secret)]) {
        let calls = 0;
        await assert.rejects(requestJson('https://app.example', secret, {}, { fetchImpl: async (_url, opts) => { calls++; assert.equal(opts.redirect, 'error'); return response; } }), error => !error.message.includes(secret));
        assert.equal(calls, 1);
    }
});

test('request timeout and shutdown abort in-flight fetches', async () => {
    const fetchImpl = async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error(secret)), { once: true });
    });
    // Keep a referenced timer because AbortSignal.timeout intentionally unrefs its timer.
    const timer = setTimeout(() => {}, 1000);
    try {
        await assert.rejects(requestJson('https://app.example', secret, {}, { fetchImpl, timeoutMs: 10 }), /^Error: HTTP_UNAVAILABLE$/);
        const controller = new AbortController();
        const pending = requestJson('https://app.example', secret, {}, { fetchImpl, signal: controller.signal });
        controller.abort();
        await assert.rejects(pending, /^Error: HTTP_UNAVAILABLE$/);
    } finally { clearTimeout(timer); }
});

test('offline polling backs off and Ctrl-C stops the wait without a tight loop', async () => {
    const controller = new AbortController();
    const pauses = [], logs = [];
    const worker = createWorker(config, {
        signal: controller.signal, readTokenImpl: async () => secret, random: () => 0,
        fetchImpl: async () => { throw new Error(secret); }, log: status => logs.push(status),
        wait: async ms => { pauses.push(ms); if (pauses.length === 6) controller.abort(); },
    });
    assert.equal(await worker.run(), 'STOPPED');
    assert.deepEqual(pauses, [1500, 3000, 6000, 12000, 22500, 22500]);
    assert.ok(logs.every(line => line === 'WORKER_UNAVAILABLE'));
    assert.equal(backoff(100, () => 1), 30000);
});
