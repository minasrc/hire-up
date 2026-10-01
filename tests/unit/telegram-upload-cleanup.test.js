import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupTelegramUploads, reserveTelegramUpload } from '../../src/lib/telegram-upload-cleanup.js';

const org = '10000000-0000-4000-8000-000000000001';
const draft = '20000000-0000-4000-8000-000000000001';
const identity = { provider: 'google', issuer: 'https://accounts.google.com', subject: '123456789' };
const key = (n = 1) => `staff/${org}/${draft}/30000000-0000-4000-8000-${String(n).padStart(12, '0')}.pdf`;
const privateError = () => new Error('private candidate name, private object key, secret token');

function fixture({ pending = [key()], claim = true, finish = true, commitFailure, queryFailure, removeFailure, allowed = true } = {}) {
    const events = [], queries = [], removed = [], states = new Map();
    let transactionId = 0;
    const pool = { connect: async () => {
        const id = ++transactionId;
        let operation;
        return {
            query: async (sql, parameters) => {
                queries.push({ sql, parameters, id });
                if (sql.includes('resolve_staff_principal_v1')) return { rows: [{ user_id: draft, membership_id: draft, role_id: draft }] };
                if (sql.includes('has_permission_v1')) {
                    assert.deepEqual(parameters[0], ['candidates.read', 'candidates.write', 'documents.write']);
                    return { rows: parameters[0].map(() => ({ allowed })) };
                }
                if (sql.includes('telegram_')) {
                    operation = sql.match(/telegram_([a-z_]+)_v1/)[1];
                    events.push(operation);
                    if (queryFailure === operation) throw privateError();
                    if (operation === 'pending_cleanup') return { rows: [{ result: pending }] };
                    if (operation === 'claim_cleanup') {
                        if (claim) states.set(parameters[0], 'deleting');
                        return { rows: [{ result: claim }] };
                    }
                    if (operation === 'finish_cleanup') {
                        if (finish) states.delete(parameters[0]);
                        return { rows: [{ result: finish }] };
                    }
                    if (operation === 'reserve_upload') return { rows: [{ result: true }] };
                }
                if (sql === 'commit') {
                    events.push(`commit:${operation}`);
                    if (commitFailure === operation) throw privateError();
                }
                return { rows: [] };
            },
            release: () => { events.push(`release:${operation}`); },
        };
    } };
    const storage = { storage: { from: bucket => {
        assert.equal(bucket, 'cv-submissions');
        return { remove: async keys => {
            events.push('remove'); removed.push(...keys);
            assert.ok(keys.every(item => states.get(item) === 'deleting'));
            if (removeFailure === 'throw') throw privateError();
            return { error: removeFailure === 'response' ? privateError() : null };
        } };
    } } };
    return { pool, storage, events, queries, removed, states };
}

test('reservation validates inputs and commits a scoped durable record before upload', async () => {
    const f = fixture();
    assert.equal(await reserveTelegramUpload(f.pool, identity, org, draft, 1, key()), true);
    const query = f.queries.find(item => item.sql.includes('telegram_reserve_upload'));
    assert.deepEqual(query.parameters, [draft, 1, key()]);
    assert.deepEqual(f.events, ['reserve_upload', 'commit:reserve_upload', 'release:reserve_upload']);
    assert.throws(() => reserveTelegramUpload(f.pool, identity, org, draft, 0, key()));
    assert.throws(() => reserveTelegramUpload(f.pool, identity, org, draft, 1, '../another-object'));
    assert.throws(() => reserveTelegramUpload(f.pool, identity, org, draft, 1, key().replace(org, draft)));
});

test('uncertain reservation commit rejects so callers cannot start an untracked upload', async () => {
    const f = fixture({ commitFailure: 'reserve_upload' });
    await assert.rejects(reserveTelegramUpload(f.pool, identity, org, draft, 1, key()));
    assert.deepEqual(f.removed, []);
});

test('cleanup commits its claim before removal, then durably finishes in a new transaction', async () => {
    const f = fixture();
    assert.deepEqual(await cleanupTelegramUploads(f.pool, identity, org, f.storage), { processed: 1, removed: 1, deferred: 0 });
    assert.deepEqual(f.events, [
        'pending_cleanup', 'commit:pending_cleanup', 'release:pending_cleanup',
        'claim_cleanup', 'commit:claim_cleanup', 'release:claim_cleanup', 'remove',
        'finish_cleanup', 'commit:finish_cleanup', 'release:finish_cleanup',
    ]);
    assert.deepEqual(f.removed, [key()]);
    assert.equal(f.states.size, 0);
});

test('false and uncertain claims never delete or finish', async () => {
    for (const options of [{ claim: false }, { claim: null }, { queryFailure: 'claim_cleanup' }, { commitFailure: 'claim_cleanup' }]) {
        const f = fixture(options);
        const summary = await cleanupTelegramUploads(f.pool, identity, org, f.storage);
        assert.equal(summary.removed, 0);
        assert.deepEqual(f.removed, []);
        assert.equal(f.events.includes('finish_cleanup'), false);
    }
});

test('storage failures preserve deleting records for a later retry without finishing', async () => {
    for (const removeFailure of ['throw', 'response']) {
        const f = fixture({ removeFailure });
        assert.deepEqual(await cleanupTelegramUploads(f.pool, identity, org, f.storage), { processed: 1, removed: 0, deferred: 1 });
        assert.equal(f.states.get(key()), 'deleting');
        assert.equal(f.events.includes('finish_cleanup'), false);
    }
});

test('uncertain finish is reported as deferred and can safely remove the same key again', async () => {
    for (const options of [{ queryFailure: 'finish_cleanup' }, { commitFailure: 'finish_cleanup' }, { finish: false }]) {
        const f = fixture(options);
        const summary = await cleanupTelegramUploads(f.pool, identity, org, f.storage);
        assert.deepEqual(summary, { processed: 1, removed: 0, deferred: 1 });
        assert.deepEqual(f.removed, [key()]);
        assert.equal(JSON.stringify(summary).includes('private'), false);
    }
    const retry = fixture();
    retry.states.set(key(), 'deleting');
    assert.equal((await cleanupTelegramUploads(retry.pool, identity, org, retry.storage)).removed, 1);
});

test('cleanup bounds work to ten keys and rejects unexpected destinations', async () => {
    const f = fixture({ pending: Array.from({ length: 20 }, (_, i) => key(i + 1)) });
    assert.equal((await cleanupTelegramUploads(f.pool, identity, org, f.storage)).processed, 10);
    assert.equal(f.removed.length, 10);
    const bad = fixture({ pending: [key(), key(), key().replace(org, draft), '../private', null] });
    const summary = await cleanupTelegramUploads(bad.pool, identity, org, bad.storage);
    assert.deepEqual(bad.removed, [key()]);
    assert.equal(summary.deferred, 3);
});

test('permission denial and uncertain list commit stop cleanup before storage access', async () => {
    for (const options of [{ allowed: false }, { commitFailure: 'pending_cleanup' }, { queryFailure: 'pending_cleanup' }]) {
        const f = fixture(options);
        await assert.rejects(cleanupTelegramUploads(f.pool, identity, org, f.storage));
        assert.deepEqual(f.removed, []);
    }
});
