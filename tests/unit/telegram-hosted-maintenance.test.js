import assert from 'node:assert/strict';
import test from 'node:test';
import { createSupervisor } from '../../services/telegram-hosted/supervisor.mjs';
import { hostedControlInput } from '../../src/lib/telegram-hosted-contracts.js';

const id = '11111111-1111-4111-8111-111111111111';
const result = { ownersProcessed: 0, batchesPurged: 0, messagesPurged: 0, bytesFreed: 0,
    queriesExpired: 0, queryResultRowsDeleted: 0, analysesPurged: 0, remainingWork: true, removalActionable: false };

test('maintenance accepts only service lease proof, never an owner or storage destination', () => {
    const input = { action: 'maintenance', instanceId: id, leaseToken: id };
    assert.deepEqual(hostedControlInput(input), input);
    for (const field of ['after', 'ownerUserId', 'objectKey', 'organizationId']) assert.throws(() => hostedControlInput({ ...input, [field]: id }));
    assert.throws(() => hostedControlInput({ action: 'maintenance', instanceId: id }));
});

test('idle maintenance is bounded to five-minute cadence; actionable removal accelerates without busy looping on an offline device', async () => {
    let now = 1700000000000, calls = 0, actionable = false;
    const supervisor = createSupervisor({ efficientPolling: true, wall: () => now, monotonic: () => now,
        control: async action => {
            if (action === 'sync') return { protocolVersion: 1, leaseToken: id, leaseSeconds: 89, capacity: 10, requests: [], nextAfter: null };
            assert.equal(action, 'maintenance'); calls++; return { ...result, removalActionable: actionable };
        } });
    await supervisor.maintain(); assert.equal(calls, 0, 'unleased service does no cleanup');
    await supervisor.refresh(); await supervisor.maintain(); assert.equal(calls, 1);
    for (let second = 10; second < 300; second += 10) {
        now += 10000; await supervisor.refresh(); await supervisor.maintain();
    }
    assert.equal(calls, 1, 'remaining offline device work does not trigger busy retries');
    now += 10000; actionable = true; await supervisor.refresh(); await supervisor.maintain(); assert.equal(calls, 2);
    now += 10000; await supervisor.refresh(); await supervisor.maintain(); assert.equal(calls, 3);
    await supervisor.stop(); await supervisor.maintain(); assert.equal(calls, 3);
});

test('lease-bound maintenance wakes retired cleanup and completed cleanup stops claiming when idle', async () => {
    let now = 1700000000000, pending = true;
    const events = [];
    const row = { requestId: id, workerId: null, organizationId: id, ownerUserId: id, cleanupToken: id };
    const supervisor = createSupervisor({ efficientPolling: true, wall: () => now, monotonic: () => now,
        store: { eraseRetired: async () => { events.push('erase'); } },
        control: async action => {
            if (action === 'sync') return { protocolVersion: 1, leaseToken: id, leaseSeconds: 89, capacity: 10, requests: [], nextAfter: null };
            if (action === 'maintenance') return { ...result, retiredVaultActionable: pending };
            events.push(action);
            if (action === 'retiredCleanupClaim') return { protocolVersion: 1, requests: pending ? [row] : [] };
            assert.equal(action, 'retiredCleanupAck'); pending = false; return { ok: true };
        } });
    await supervisor.refresh(); await supervisor.reconcile(); await supervisor.maintain(); await supervisor.cleanupRetired();
    assert.deepEqual(events, ['retiredCleanupClaim', 'erase', 'retiredCleanupAck']);
    now += 10000; await supervisor.refresh(); await supervisor.reconcile(); await supervisor.maintain(); await supervisor.cleanupRetired();
    assert.equal(events.filter(action => action === 'retiredCleanupClaim').length, 2, 'one empty claim confirms the queue drained');
    for (let second = 20; second <= 310; second += 10) {
        now += 10000; await supervisor.refresh(); await supervisor.reconcile(); await supervisor.maintain(); await supervisor.cleanupRetired();
    }
    assert.equal(events.filter(action => action === 'retiredCleanupClaim').length, 2, 'idle maintenance adds no retired-cleanup polling');
    await supervisor.stop();
});
