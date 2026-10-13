import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnectedWork } from '../../services/telegram-connector/connected-work.mjs';
import { createHistoryWorker } from '../../services/telegram-connector/history-worker.mjs';

test('history, CV retrieval and source repair get one fair lane per tick despite a failed lane', async () => {
    const calls = [], context = { connectionId: 'synthetic' };
    const lane = name => ({ tick: async actual => {
        assert.equal(actual, context); calls.push(name);
        if (calls.length === 1) throw Error('temporary provider failure');
        return name;
    } });
    const schedule = createConnectedWork({ cv: lane('cv'), history: lane('history'), updates: lane('source') });
    await assert.rejects(schedule(context), /temporary provider failure/);
    for (let index = 0; index < 8; index++) await schedule(context);
    assert.deepEqual(calls, ['cv','history','source','cv','history','source','cv','history','source']);
});

test('idle lanes share one tick while busy lanes retain round-robin fairness', async () => {
    const calls = [], context = { plan: { cv: true, history: true, source: true } };
    const idle = name => ({ tick: async () => { calls.push(name); return { status: 'idle', idleReason: 'empty', providerRead: false }; } });
    const history = { tick: async () => { calls.push('history'); return { status: 'queued' }; } };
    const schedule = createConnectedWork({ cv: idle('cv'), history, updates: idle('source') });
    await schedule(context); await schedule(context);
    assert.deepEqual(calls, ['cv', 'history', 'source', 'cv', 'history']);
    assert.deepEqual(context.plan, { cv: false, history: true, source: false });
});

test('a real local history cooldown preserves due work rather than suppressing it for a minute', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    let now = 1700000000000, claims = 0, reads = 0, pending;
    const context = { connectionId: id, generation: 1, accountUserId: '123', connectionLeaseToken: id,
        connectionLeaseExpiresAt: new Date(now + 120000).toISOString(), isActive: () => true,
        plan: { cv: false, history: true, source: false }, telegram: { dialogs: async ({ cursor }) => { reads++; return { records: [], nextCursor: cursor, done: true }; } } };
    const history = createHistoryWorker({ now: () => now,
        vault: { loadHistory: () => pending, saveHistory: (connection, account, key, value) => { pending = value; }, removeHistoryRecord: () => { pending = null; } },
        host: async action => action === 'complete' ? { ok: true, status: 'completed' } : { job: ++claims === 1 ? null : {
            id, leaseToken: id, kind: 'dialogs', connectionId: id, generation: 1, accountUserId: '123', pageNumber: 0,
            leaseExpiresAt: new Date(now + 60000).toISOString(), cursor: { folder: 0, offsetDate: 0, offsetId: '0', offsetPeer: null, excludePinned: false },
        } },
    });
    const idle = { tick: async () => ({ status: 'idle', idleReason: 'plan', providerRead: false }) };
    const schedule = createConnectedWork({ cv: idle, history, updates: idle });
    await schedule(context); assert.equal(context.plan.history, false);
    context.plan.history = true; now += 1000;
    await schedule(context); assert.equal(context.plan.history, true); assert.equal(claims, 1);
    now += 4100;
    await schedule(context); assert.equal(reads, 1); assert.equal(claims, 2);
});

test('an idle result after a provider read and uncertain legacy idle results end the tick', async () => {
    for (const result of [{ status: 'idle', idleReason: 'unavailable', providerRead: true }, { status: 'idle' }]) {
        const calls = [], context = { plan: { cv: true, history: true, source: true } };
        const lane = name => ({ tick: async () => { calls.push(name); return result; } });
        await createConnectedWork({ cv: lane('cv'), history: lane('history'), updates: lane('source') })(context);
        assert.deepEqual(calls, ['cv']); assert.equal(context.plan.cv, true);
    }
});
