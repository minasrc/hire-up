import assert from 'node:assert/strict';
import test from 'node:test';
import { createStaffPreviewCache } from '../../src/lib/staff-preview-cache.js';

const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

function setup(t, options) {
    const cache = createStaffPreviewCache(options);
    t.after(() => cache.clear());
    return cache;
}

test('repeated previews share pending reads and reuse a fresh authorized result', async (t) => {
    const cache = setup(t);
    const request = deferred();
    let calls = 0;
    const load = () => { calls += 1; return request.promise; };
    const first = cache.load('candidate:1', load);
    const second = cache.load('candidate:1', load);
    assert.equal(first, second);
    await Promise.resolve();
    assert.equal(calls, 1);
    const record = { candidate: { fullName: 'Synthetic' } };
    request.resolve(record);
    assert.equal(await first, record);
    assert.equal(cache.peek('candidate:1'), record);
    assert.equal(await cache.load('candidate:1', load), record);
    assert.equal(calls, 1);
});

test('cache instances do not share private data', async (t) => {
    const first = setup(t);
    const second = setup(t);
    await first.load('candidate:1', async () => ({ name: 'Synthetic' }));
    assert.equal(second.peek('candidate:1'), undefined);
});

test('expiry removes private data and forces another read', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const cache = setup(t, { ttl: 15 });
    await cache.load('job:1', async () => 'first');
    t.mock.timers.tick(15);
    assert.equal(cache.peek('job:1'), undefined);
    assert.equal(await cache.load('job:1', async () => 'second'), 'second');
});

test('least recently used records are evicted at the bound', async (t) => {
    const cache = setup(t, { limit: 2 });
    await cache.load('job:1', async () => 'first');
    await cache.load('job:2', async () => 'second');
    cache.peek('job:1');
    await cache.load('job:3', async () => 'third');
    assert.equal(cache.peek('job:2'), undefined);
    assert.equal(cache.peek('job:1'), 'first');
});

test('invalidating during a read aborts it and ignores late data', async (t) => {
    const cache = setup(t);
    const request = deferred();
    let signal;
    const pending = cache.load('candidate:1', (value) => {
        signal = value;
        return request.promise;
    });
    await Promise.resolve();
    cache.clear();
    assert.equal(signal.aborted, true);
    const fresh = await cache.load('candidate:1', async () => 'fresh');
    request.resolve('stale');
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(cache.peek('candidate:1'), fresh);
});

test('authorization loss clears every cached record; transient errors remain retryable', async (t) => {
    const cache = setup(t);
    await cache.load('candidate:1', async () => 'private');
    await assert.rejects(cache.load('job:2', async () => {
        throw Object.assign(new Error('Denied'), { status: 403 });
    }), /Denied/);
    assert.equal(cache.peek('candidate:1'), undefined);
    await assert.rejects(cache.load('job:2', async () => { throw new Error('Offline'); }), /Offline/);
    assert.equal(await cache.load('job:2', async () => 'retried'), 'retried');
});

test('an old authorization error cannot clear a newer authorized record', async (t) => {
    const cache = setup(t);
    const request = deferred();
    const pending = cache.load('candidate:1', () => request.promise);
    await Promise.resolve();
    cache.clear();
    await cache.load('candidate:1', async () => 'fresh');
    request.reject(Object.assign(new Error('Old denial'), { status: 401 }));
    await assert.rejects(pending, /Old denial/);
    assert.equal(cache.peek('candidate:1'), 'fresh');
});
