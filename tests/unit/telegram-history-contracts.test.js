import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { historyStaffAction, historyWorkerInput, historyCursor } from '../../src/lib/telegram-history-contracts.js';
const proof = { connectionId: randomUUID(), generation: 1, connectionLeaseToken: randomUUID(), accountUserId: '900719925474099345' };
const message = { messageId: '100', kind: 'message', sentAt: '2026-01-01T00:00:00Z', editedAt: null, sender: null, replyToMessageId: null, forwardedFrom: null, text: '', attachments: [] };
const page = { ...proof, jobId: randomUUID(), jobLeaseToken: randomUUID(), pageId: randomUUID(), fromCursor: { beforeMessageId: null, upperMessageId: null }, nextCursor: { beforeMessageId: '100', upperMessageId: '100' }, done: false, records: [message] };
test('history preserves attachment-only messages and stable decimal identities', () => {
    const record = { ...message, attachments: [{ id: '900719925474099388', kind: 'document', filename: 'CV.pdf', mimeType: 'application/pdf', sizeBytes: 100 }] };
    const normalized = historyWorkerInput('complete', { ...page, records: [record] });
    assert.equal(normalized.proof.accountUserId, proof.accountUserId); assert.equal(normalized.payload.records[0].text, '');
    assert.equal(normalized.payload.records[0].attachments[0].id, record.attachments[0].id);
    assert.throws(() => historyWorkerInput('complete', { ...page, records: [{ ...message, messageId: 100 }] }));
});
test('unavailable raw placeholders retain IDs without invented dates or facts', () => {
    const unavailable = { ...message, kind: 'unavailable', sentAt: null };
    assert.equal(historyWorkerInput('complete', { ...page, records: [unavailable] }).payload.records[0].sentAt, null);
    for (const change of [{ text: 'inferred facts' }, { sentAt: message.sentAt }, { attachments: [{ id: null, kind: 'other', filename: null, mimeType: null, sizeBytes: null }] }]) assert.throws(() => historyWorkerInput('complete', { ...page, records: [{ ...unavailable, ...change }] }));
    assert.throws(() => historyWorkerInput('complete', { ...page, records: [{ ...message, sentAt: null }] }));
});
test('wire bounds, unknown secret fields and false exhaustion are rejected', () => {
    for (const record of [{ ...message, text: 'x'.repeat(32769) }, { ...message, accessHash: 'secret' }, { ...message, sender: { peer: { kind: 'user', id: '4', accessHash: 'secret' }, username: null, displayName: null } }]) assert.throws(() => historyWorkerInput('complete', { ...page, records: [record] }));
    assert.throws(() => historyWorkerInput('complete', { ...page, done: true }));
    assert.throws(() => historyWorkerInput('complete', { ...page, records: Array.from({ length: 101 }, () => message) }));
    assert.throws(() => historyWorkerInput('complete', { ...page, records: Array.from({ length: 10 }, () => ({ ...message, text: 'x'.repeat(30000) })) }));
});
test('selection batches cap at50 and preserve unique per-row version guards', () => {
    const chats = Array.from({ length: 50 }, () => ({ chatId: randomUUID(), expectedVersion: 1 }));
    assert.equal(historyStaffAction({ action: 'selectMany', selected: true, chats }).chats.length, 50);
    assert.throws(() => historyStaffAction({ action: 'selectMany', selected: true, chats: [...chats, { chatId: randomUUID(), expectedVersion: 1 }] }));
    assert.throws(() => historyStaffAction({ action: 'selectMany', selected: true, chats: [chats[0], chats[0]] }));
    assert.throws(() => historyStaffAction({ action: 'resume', chatId: chats[0].chatId, expectedVersion: 0 }));
});
test('cursor and flood-wait contracts exclude private SDK locators and bound delays', () => {
    assert.throws(() => historyCursor({ folder: 0, offsetDate: 0, offsetId: '0', offsetPeer: { kind: 'channel', id: '42', accessHash: 'secret' }, excludePinned: true }, 'dialogs'));
    const input = { ...proof, jobId: page.jobId, jobLeaseToken: page.jobLeaseToken, code: 'FLOOD_WAIT', retryAfterSeconds: 3600 };
    assert.equal(historyWorkerInput('defer', input).retryAfterSeconds, 3600);
    assert.throws(() => historyWorkerInput('defer', { ...input, retryAfterSeconds: 604801 }));
    assert.throws(() => historyWorkerInput('claim', { ...proof, accountUserId: 'not-an-id' }));
});

test('sync cursors retain decimal checkpoints including empty-history zero, without widening the wire schema', () => {
    for (const afterMessageId of ['0', '99', '2147483647']) {
        const cursor = { beforeMessageId: null, upperMessageId: null, afterMessageId };
        assert.deepEqual(historyCursor(cursor, 'history'), cursor);
        assert.deepEqual(historyWorkerInput('complete', { ...page, records: [], done: true, fromCursor: cursor, nextCursor: cursor }).payload.fromCursor, cursor);
    }
    for (const afterMessageId of [0, null, '-1', '00', '2147483648']) assert.throws(() => historyCursor({ beforeMessageId: null, upperMessageId: null, afterMessageId }, 'history'));
    assert.throws(() => historyCursor({ beforeMessageId: null, upperMessageId: null, afterMessageId: '0', secret: 'private' }, 'history'));
});

test('exclude and restore use versioned private chat identifiers and bounded batches', () => {
 const chat={chatId:randomUUID(),expectedVersion:2};
 assert.deepEqual(historyStaffAction({action:'exclude',...chat}),{action:'exclude',...chat});
 assert.deepEqual(historyStaffAction({action:'restore',...chat}),{action:'restore',...chat});
 assert.deepEqual(historyStaffAction({action:'excludeMany',chats:[chat]}),{action:'excludeMany',chats:[chat]});
 assert.throws(()=>historyStaffAction({action:'excludeMany',chats:[chat,chat]}));
 assert.throws(()=>historyStaffAction({action:'excludeMany',chats:[]}));
 assert.throws(()=>historyStaffAction({action:'exclude',...chat,expectedVersion:0}));
});
