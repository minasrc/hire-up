import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionGuidance, historyPollingDelay, importActions, importGuidance, importStatus, selectionPayload, syncStatus } from '../../src/app/staff/telegram-intake/chats/history-model.js';

test('bulk selection only submits visible rows and their current versions', () => {
    const rows = [{ id: 'one', version: 2, title: 'Private title', peer: { id: '123' } }, { id: 'two', version: 5 }];
    assert.deepEqual(selectionPayload(rows, ['two', 'one'], true), {
        action: 'selectMany', selected: true, chats: [{ chatId: 'one', expectedVersion: 2 }, { chatId: 'two', expectedVersion: 5 }],
    });
    assert.throws(() => selectionPayload(rows, ['unknown'], true), /this page/);
    assert.throws(() => selectionPayload(rows, [], true), /up to 50/);
    const tooMany = Array.from({ length: 51 }, (_, i) => ({ id: String(i), version: 1 }));
    assert.throws(() => selectionPayload(tooMany, tooMany.map(row => row.id), true), /up to 50/);
});

test('pauses and incomplete imports are never presented as completed history', () => {
    for (const status of ['queued', 'leased', 'waiting', 'paused', 'capacity_paused', 'failed', 'cancelled']) {
        assert.notEqual(importStatus({ status }), 'History imported');
    }
    assert.equal(importStatus({ status: 'completed' }), 'History imported');
    assert.match(importGuidance({ status: 'capacity_paused' }), /saved position/);
    assert.match(importGuidance({ status: 'paused', errorCode: 'MESSAGE_TOO_LARGE' }), /before that message/);
    assert.match(importGuidance({ status: 'paused', errorCode: 'CONNECTION_CHANGED' }), /same account/);
    assert.equal(importGuidance({ errorCode: 'Private provider exception sentinel' }).includes('sentinel'), false);
});

test('history actions pause active work and resume saved cursors without restarting completion', () => {
    assert.deepEqual(importActions({ import: null }), [{ action: 'select', selected: true, label: 'Import full history' }]);
    assert.deepEqual(importActions({ import: { status: 'leased' }, selected: true }).map(item => item.action), ['pause', 'cancel']);
    assert.deepEqual(importActions({ import: { status: 'paused' }, selected: true }).map(item => item.action), ['resume', 'cancel']);
    assert.deepEqual(importActions({ import: { status: 'cancelled' }, selected: false }).map(item => item.action), ['resume']);
    assert.deepEqual(importActions({ import: { status: 'completed' }, selected: false }), [{ action: 'select', selected: true, label: 'Select chat' }]);
});

test('only ongoing discovery or imports require frequent visible polling', () => {
    assert.equal(historyPollingDelay({ discovery: { status: 'active' }, chats: [] }), 3000);
    assert.equal(historyPollingDelay({ discovery: { status: 'completed' }, chats: [{ import: { status: 'waiting' } }] }), 3000);
    assert.equal(historyPollingDelay({ discovery: { status: 'completed' }, chats: [{ import: { status: 'paused' } }] }), 15000);
});

test('completed selected histories offer an explicit sync pause', () => {
    assert.deepEqual(importActions({ selected: true, import: { status: 'completed' }, sync: { enabled: true } }).map(a => a.label), ['Pause sync', 'Deselect chat']);
});


test('hosted sync guidance retains offline recovery without local device setup', () => {
    const status = syncStatus({ status: 'worker_offline' }, true);
    assert.match(status, /service offline/);
    assert.match(status, /resumes/);
    assert.equal(status.includes('Mac'), false);
    assert.match(syncStatus({ status: 'worker_offline' }), /Mac offline/);
    assert.equal(importGuidance({ errorCode: 'PEER_CACHE_MISSING' }).includes('Mac'), false);
});

test('completed history keeps sync labels while incremental work is paused or active', () => {
    for (const status of ['queued', 'leased', 'waiting']) assert.equal(importActions({ historyCompleted: true, selected: true, import: { status } })[0].label, 'Pause sync');
    for (const status of ['paused', 'capacity_paused', 'failed', 'cancelled']) assert.equal(importActions({ historyCompleted: true, selected: true, import: { status } })[0].label, 'Resume sync');
    assert.equal(importActions({ historyCompleted: false, import: { status: 'paused' } })[0].label, 'Resume import');
});


test('pending sign-in guidance identifies the remaining approval step without permitting imports', () => {
    for (const [status, title] of [['requested', 'Preparing Telegram sign-in'], ['qr_pending', 'Finish Telegram approval on your phone'], ['awaiting_password', 'Complete Telegram two-step verification']]) {
        const snapshot = { canImport: false, blockedReason: 'NOT_CONNECTED', connection: { status } };
        assert.equal(connectionGuidance(snapshot).title, title);
        assert.equal(connectionGuidance(snapshot).action, 'Continue sign-in');
        assert.match(connectionGuidance(snapshot).empty, /choose chats to import afterward/);
        assert.equal(historyPollingDelay(snapshot), 2000);
        assert.equal(snapshot.canImport, false);
    }
    assert.match(connectionGuidance({ canImport: false, blockedReason: 'NOT_CONNECTED', connection: { status: 'awaiting_password' } }).description, /password on the connection page/);
    assert.equal(connectionGuidance({ canImport: false, blockedReason: 'NOT_CONNECTED', connection: { status: 'failed' } }).action, 'Retry sign-in');
    for (const connection of [null, { status: 'disconnected' }]) {
        assert.equal(connectionGuidance({ canImport: false, blockedReason: 'NOT_CONNECTED', connection }).action, 'Connect Telegram');
        assert.equal(historyPollingDelay({ connection }), 15000);
    }
    assert.equal(connectionGuidance({ canImport: true, connection: { status: 'connected' } }), null);
});
