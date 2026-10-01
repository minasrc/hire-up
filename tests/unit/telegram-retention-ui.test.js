import assert from 'node:assert/strict';
import test from 'node:test';
import { extractionStatus } from '../../src/app/staff/telegram-intake/extraction/extraction-model.js';
import { canReleaseContext, extractionSelection, retentionHolds, retentionLabel } from '../../src/app/staff/telegram-intake/extraction/retention-model.js';

test('release requires loaded whole-batch context and an explicit attestation', () => {
    const state = { retention: { canRelease: true }, sourceLoaded: true, acknowledged: true, busy: false };
    assert.equal(canReleaseContext(state), true);
    assert.equal(canReleaseContext({ ...state, sourceLoaded: false }), false);
    assert.equal(canReleaseContext({ ...state, acknowledged: false }), false);
    assert.equal(canReleaseContext({ ...state, busy: true }), false);
    assert.equal(canReleaseContext({ ...state, retention: { canRelease: false } }), false);
});
test('automatic extraction targets marked changed rows with their current versions', () => {
    const chats = [{ id: 'a', version: 2, extractionEnabled: false }, { id: 'b', version: 9, extractionEnabled: true }, { id: 'c', version: 3, extractionEnabled: false }];
    assert.deepEqual(extractionSelection(chats, ['a', 'b'], true), [{ chatId: 'a', expectedVersion: 2 }]);
    assert.deepEqual(extractionSelection(chats, ['a', 'b'], false), [{ chatId: 'b', expectedVersion: 9 }]);
    assert.deepEqual(extractionSelection(chats, ['foreign'], true), []);
    assert.equal(extractionSelection(Array.from({ length: 60 }, (_, index) => ({ id: String(index), version: 1, extractionEnabled: false })), Array.from({ length: 60 }, (_, index) => String(index)), true).length, 50);
});
test('pending release remains distinct from deletion and reports all consumer holds', () => {
    assert.equal(retentionLabel({ state: 'kept' }), 'Context kept');
    assert.equal(retentionLabel({ state: 'release_pending' }), 'Release requested');
    assert.equal(retentionLabel({ state: 'purged' }), 'Source messages deleted');
    assert.equal(extractionStatus({ status: 'completed', sourceRetention: { state: 'release_pending', holds: { openDrafts: 0, pendingProposals: 0, activeCv: 0 } } }), 'Review complete');
    assert.equal(extractionStatus({ status: 'completed', sourceRetention: { state: 'release_pending', holds: { openDrafts: 0, pendingProposals: 1, activeCv: 0 } } }), 'Ready for review');
    assert.equal(retentionHolds({ openDrafts: 1, pendingProposals: 2, activeCv: 1 }), '1 open draft · 2 unresolved suggestions · 1 active CV retrieval');
    assert.equal(retentionHolds({ openDrafts: 0, pendingProposals: 0, activeCv: 0 }), '');
});
