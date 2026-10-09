import assert from 'node:assert/strict';
import test from 'node:test';
import { createStaffAuthRecovery } from '../../src/lib/staff-auth-recovery.js';

test('record permission denial never starts authentication recovery', () => {
    const events = [];
    const recovery = createStaffAuthRecovery((...event) => events.push(event));
    assert.equal(recovery.require(403), false);
    assert.equal(recovery.getSnapshot().required, false);
    assert.deepEqual(events, []);
});

test('expiry hides private content but retains the preview selection for recovery', () => {
    for (const status of [401, 428]) {
        const events = [];
        const recovery = createStaffAuthRecovery((...event) => events.push(event));
        assert.equal(recovery.require(status), true);
        assert.deepEqual(recovery.getSnapshot(), {
            required: true, mfa: status === 428, source: 'read', phase: 'required',
        });
        assert.deepEqual(events, [['staff-session-invalidated', { recoverable: true }]]);
    }
});

test('an explicit retry needs a fresh authorized read; old success and denial cannot overwrite it', () => {
    const recovery = createStaffAuthRecovery();
    const old = recovery.requestEpoch();
    recovery.require(428, old);
    recovery.accepted(old);
    assert.equal(recovery.getSnapshot().required, true);
    const retry = recovery.beginRetry();
    assert.equal(recovery.beginRetry(), null, 'coalesce clicks from multiple recovery prompts');
    assert.equal(recovery.getSnapshot().phase, 'updating');
    recovery.accepted(retry);
    assert.equal(recovery.getSnapshot().required, true, 'NextAuth alone is not proof of staff MFA');
    recovery.retryReady(retry);
    assert.equal(recovery.getSnapshot().phase, 'retrying');
    assert.equal(recovery.require(401, old), false);
    recovery.accepted(retry);
    assert.equal(recovery.getSnapshot().required, false);
    assert.equal(recovery.require(428, retry), false, 'late denial from before recovery is obsolete');
    assert.equal(recovery.require(401, recovery.requestEpoch()), true, 'a new denial still applies');
});

test('failed recovery stays actionable and never emits a write retry', () => {
    const events = [];
    const recovery = createStaffAuthRecovery((name) => events.push(name));
    recovery.require(401, recovery.requestEpoch(), 'save');
    const first = recovery.beginRetry();
    recovery.retryFailed(first);
    assert.equal(recovery.getSnapshot().phase, 'required');
    assert.equal(recovery.getSnapshot().source, 'save');
    const next = recovery.beginRetry();
    recovery.retryReady(next);
    assert.deepEqual(events, ['staff-session-invalidated', 'staff-auth-retry']);
    recovery.require(428, next, 'save');
    assert.equal(recovery.getSnapshot().mfa, true);
    recovery.reset();
    recovery.retryReady(next);
    recovery.accepted(next);
    assert.equal(recovery.getSnapshot().required, false);
});

test('a stalled retry becomes actionable and its late proof cannot clear a newer attempt', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const recovery = createStaffAuthRecovery();
    recovery.require(428);
    const stalled = recovery.beginRetry();
    recovery.retryReady(stalled);
    t.mock.timers.tick(30_000);
    assert.equal(recovery.getSnapshot().phase, 'required');
    assert.match(recovery.getSnapshot().error, /could not be checked/);
    const newer = recovery.beginRetry();
    recovery.retryReady(newer);
    recovery.accepted(stalled);
    assert.equal(recovery.getSnapshot().required, true);
    recovery.accepted(newer);
    assert.equal(recovery.getSnapshot().required, false);
});
