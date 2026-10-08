import assert from 'node:assert/strict';
import test from 'node:test';
import { createDocumentPreviewCache } from '../../src/lib/staff-document-preview-cache.js';

function setup(t, options) {
    const cache = createDocumentPreviewCache(options);
    t.after(() => cache.clear());
    return cache;
}
const resource = (value, dispose = () => {}, sizeBytes = 4) => ({ value, version: 'v1', sizeBytes, dispose });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('each revisit validates access while reusing the prepared resource', async (t) => {
    const cache = setup(t);
    let checks = 0, preparations = 0;
    const loader = async (previous) => { checks++; if (previous) return previous; preparations++; return resource({ pdf: 'prepared' }); };
    const first = await cache.acquire('a', loader); first.release();
    const second = await cache.acquire('a', loader); second.release();
    assert.equal(first.value, second.value);
    assert.equal(checks, 2);
    assert.equal(preparations, 1);
});

test('concurrent requests share validation; changed versions retire the old resource', async (t) => {
    const cache = setup(t);
    const request = deferred(); let calls = 0, disposed = 0;
    const first = cache.acquire('a', () => { calls++; return request.promise; });
    const second = cache.acquire('a', () => { calls++; return request.promise; });
    request.resolve(resource('old', () => disposed++));
    const [a, b] = await Promise.all([first, second]);
    assert.equal(calls, 1); assert.equal(a.value, b.value);
    const changed = await cache.acquire('a', async () => resource('new'));
    assert.equal(disposed, 0, 'a viewer still owns the old resource');
    a.release(); b.release(); b.release();
    assert.equal(disposed, 1);
    assert.equal(changed.value, 'new'); changed.release();
});

test('private resources are isolated by workspace cache instance', async (t) => {
    const a = setup(t), b = setup(t);
    const lease = await a.acquire('a', async () => resource('private')); lease.release();
    assert.equal(b.has('a'), false);
});

test('focus revalidation hides data while retaining completed preparations', async (t) => {
    const cache = setup(t); let disposed = 0, validations = 0;
    const loader = async (previous) => { validations++; return previous ?? resource('prepared', () => disposed++); };
    const first = await cache.acquire('a', loader);
    const epoch = cache.getEpoch(); cache.revalidate(); first.release();
    assert.ok(cache.getEpoch() > epoch); assert.equal(disposed, 0);
    const second = await cache.acquire('a', loader);
    assert.equal(second.value, first.value); assert.equal(validations, 2); second.release();
});

test('entry and byte limits evict resources and dispose each exactly once', async (t) => {
    const cache = setup(t, { limit: 2, maxBytes: 8 }); let disposed = 0;
    for (const key of ['a', 'b', 'c']) { const lease = await cache.acquire(key, async () => resource(key, () => disposed++)); lease.release(); }
    assert.equal(cache.has('a'), false); assert.equal(disposed, 1);
    const d = await cache.acquire('d', async () => resource('d', () => disposed++, 8)); d.release();
    assert.equal(cache.has('b'), false); assert.equal(cache.has('c'), false); assert.equal(disposed, 3);
    cache.clear(); assert.equal(disposed, 4);
});

test('expiry releases idle resources without destroying a visible viewer', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const cache = setup(t, { ttl: 15 }); let disposed = 0;
    const lease = await cache.acquire('a', async () => resource('private', () => disposed++));
    t.mock.timers.tick(15);
    assert.equal(cache.has('a'), false); assert.equal(disposed, 0);
    lease.release(); assert.equal(disposed, 1);
});

test('clearing aborts in-flight work, hides existing data, and disposes late results', async (t) => {
    const cache = setup(t); const request = deferred(); let signal, disposed = 0;
    const pending = cache.acquire('a', (_previous, value) => { signal = value; return request.promise; });
    await Promise.resolve(); const epoch = cache.getEpoch(); cache.clear();
    assert.equal(signal.aborted, true); assert.ok(cache.getEpoch() > epoch);
    request.resolve(resource('stale', () => disposed++));
    await assert.rejects(pending, { name: 'AbortError' }); assert.equal(disposed, 1);
});

test('rapid switches bound unfinished work and discard evicted late results', async (t) => {
    const cache = setup(t, { limit: 1 }); const request = deferred(); let signal, disposed = 0;
    const pending = cache.acquire('a', (_previous, value) => { signal = value; return request.promise; });
    await Promise.resolve();
    const fresh = await cache.acquire('b', async () => resource('new')); fresh.release();
    assert.equal(signal.aborted, true);
    request.resolve(resource('stale', () => disposed++));
    await assert.rejects(pending, { name: 'AbortError' }); assert.equal(disposed, 1);
    assert.equal(cache.has('b'), true);
});

test('denied cached reuse clears private resources and does not retry itself', async (t) => {
    const cache = setup(t); let disposed = 0, requests = 0;
    const lease = await cache.acquire('a', async () => resource('private', () => disposed++)); lease.release();
    const deny = () => { requests++; throw Object.assign(new Error('Denied'), { status: 403 }); };
    await assert.rejects(cache.acquire('a', deny), /Denied/);
    assert.equal(disposed, 1); assert.equal(cache.has('a'), false);
    await assert.rejects(cache.acquire('a', deny), /Denied/); assert.equal(requests, 1);
    cache.clear(); const fresh = await cache.acquire('a', async () => resource('new')); fresh.release();
});

test('session loss blocks other document reads until external revalidation', async (t) => {
    const cache = setup(t);
    await assert.rejects(cache.acquire('a', async () => { throw Object.assign(new Error('Expired'), { status: 428 }); }), /Expired/);
    await assert.rejects(cache.acquire('b', () => assert.fail('must not fetch with expired session')), /Expired/);
});

test('denials from multiple viewers cannot trigger alternating retry loops', async (t) => {
    const cache = setup(t); let reads = 0;
    const deny = async () => { reads++; throw Object.assign(new Error('Denied'), { status: 403 }); };
    await assert.rejects(cache.acquire('a', deny), /Denied/);
    await assert.rejects(cache.acquire('b', deny), /Denied/);
    await assert.rejects(cache.acquire('a', deny), /Denied/);
    await assert.rejects(cache.acquire('b', deny), /Denied/);
    assert.equal(reads, 2);
});

test('late denial from invalidated work cannot clear newer resources', async (t) => {
    const cache = setup(t); const request = deferred();
    const pending = cache.acquire('a', () => request.promise); await Promise.resolve(); cache.clear();
    const fresh = await cache.acquire('b', async () => resource('new')); fresh.release();
    request.reject(Object.assign(new Error('old denial'), { status: 403 }));
    await assert.rejects(pending, { name: 'AbortError' }); assert.equal(cache.has('b'), true);
});
