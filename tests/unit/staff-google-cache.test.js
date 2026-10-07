import assert from 'node:assert/strict';
import test from 'node:test';
import { createGoogleCredentialCache } from '../../src/lib/staff-google-cache.js';

test('concurrent requests share one credential check and expire at 60 seconds', async () => {
    let now = 0;
    let calls = 0;
    let resolve;
    const status = createGoogleCredentialCache({ now: () => now });
    const check = () => {
        calls++;
        return new Promise((done) => { resolve = done; });
    };
    const pending = Array.from({ length: 10 }, () => status('123', 'credential', check));
    await Promise.resolve();
    assert.equal(calls, 1);
    resolve('active');
    assert.deepEqual(await Promise.all(pending), Array(10).fill('active'));
    now = 59_999;
    assert.equal(await status('123', 'credential', check), 'active');
    assert.equal(calls, 1);
    now = 60_000;
    const expired = status('123', 'credential', check);
    await Promise.resolve();
    assert.equal(calls, 2);
    resolve('revoked');
    assert.equal(await expired, 'revoked');
});

test('different credentials with the same tail and different subjects stay isolated', async () => {
    const status = createGoogleCredentialCache();
    assert.equal(await status('123', 'old-12345678', async () => 'revoked'), 'revoked');
    assert.equal(await status('123', 'new-12345678', async () => 'active'), 'active');
    assert.equal(await status('456', 'new-12345678', async () => 'revoked'), 'revoked');
});

test('missing credentials fail closed without a network check', async () => {
    const status = createGoogleCredentialCache();
    assert.equal(await status('123', null, () => assert.fail('unexpected check')), 'revoked');
});

test('rejected checks release the pending entry so the next request can retry', async () => {
    const status = createGoogleCredentialCache();
    await assert.rejects(status('123', 'credential', async () => { throw new Error('failed'); }));
    assert.equal(await status('123', 'credential', async () => 'active'), 'active');
});

test('unknown and revoked results retain the existing 60-second policy', async () => {
    for (const result of ['unknown', 'revoked']) {
        let now = 0;
        const status = createGoogleCredentialCache({ now: () => now });
        assert.equal(await status('123', 'credential', async () => result), result);
        now = 59_999;
        assert.equal(await status('123', 'credential', () => assert.fail('early refresh')), result);
        now = 60_000;
        assert.equal(await status('123', 'credential', async () => 'active'), 'active');
    }
});
