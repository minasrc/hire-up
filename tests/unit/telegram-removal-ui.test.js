import assert from 'node:assert/strict';
import test from 'node:test';
import { removalPending, removalStatus, removalError, removalPayload, removalOperation } from '../../src/app/staff/telegram-intake/chats/removal-model.js';

test('offline removal requires explicit confirmation and retains idempotency identity', () => {
    const input = { mode: 'request', preview: { chatId: 'chat', version: 4, state: 'none' }, acknowledged: true, connected: false, operationId: 'stable-operation' };
    assert.deepEqual(removalPayload(input), { action: 'request', chatId: 'chat', expectedVersion: 4, operationId: 'stable-operation', confirmation: 'remove_imported_history' });
    assert.throws(() => removalPayload({ ...input, acknowledged: false }), /confirm/);
    assert.throws(() => removalPayload({ ...input, preview: { ...input.preview, state: 'pending' } }), /confirm/);
    assert.throws(() => removalPayload({ ...input, preview: { ...input.preview, state: 'completed' } }), /already/);
});
test('fresh imports require completed cleanup and a connected account', () => {
    const input = { mode: 'reimport', preview: { chatId: 'chat', version: 5, state: 'completed' }, acknowledged: true, connected: true, operationId: 'fresh-operation' };
    assert.deepEqual(removalPayload(input), { action: 'reimport', chatId: 'chat', expectedVersion: 5, operationId: 'fresh-operation' });
    assert.throws(() => removalPayload({ ...input, connected: false }), /Reconnect/);
    assert.throws(() => removalPayload({ ...input, preview: { ...input.preview, state: 'none' } }), /completes/);
});
test('cleanup status never declares completion before device and storage acknowledgement', () => {
    assert.equal(removalPending('device_pending'), true);
    assert.equal(removalPending('completed'), false);
    assert.match(removalStatus('pending', { serverPurged: true }), /cleanup is pending/);
    assert.doesNotMatch(removalStatus('device_pending', { serverPurged: true }), /history removed\. Approved/);
    assert.match(removalStatus('completed'), /Approved candidate profiles and reviewed documents are kept/);
    assert.match(removalError(409), /review/);
    assert.match(removalError(503), /may already be in progress/);
});

test('uncertain operation retries bind to action, chat and preview version', () => {
    const preview = { chatId: 'chat', version: 5 };
    const uncertain = removalOperation(null, 'reimport', preview, () => 'reimport-id');
    assert.equal(removalOperation(uncertain, 'reimport', preview, () => 'unused'), uncertain);
    const removal = removalOperation(uncertain, 'request', { ...preview, version: 6 }, () => 'remove-id');
    assert.equal(removal.operationId, 'remove-id');
    assert.equal(removalOperation(removal, 'request', { ...preview, version: 7 }, () => 'new-version-id').operationId, 'new-version-id');
    assert.equal(removalOperation(removal, 'request', { chatId: 'other', version: 6 }, () => 'other-chat-id').operationId, 'other-chat-id');
    assert.equal(removalOperation(uncertain, 'request', preview, () => 'new-action-id').operationId, 'new-action-id');
});
