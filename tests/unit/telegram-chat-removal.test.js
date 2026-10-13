import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { telegramChatRemovalInput } from '../../src/lib/telegram-chat-removal-contracts.js';
test('removal is an explicit versioned operation with exact confirmation', () => {
    const input = { action: 'request', chatId: randomUUID(), expectedVersion: 3, operationId: randomUUID(), confirmation: 'remove_imported_history' };
    assert.deepEqual(telegramChatRemovalInput(input), input);
    for (const change of [{ confirmation: undefined }, { confirmation: true }, { confirmation: 'remove' }, { expectedVersion: 0 }, { expectedVersion: 1.5 }, { expectedVersion: Number.MAX_SAFE_INTEGER + 1 }, { operationId: undefined }, { accountId: randomUUID() }]) assert.throws(() => telegramChatRemovalInput({ ...input, ...change }));
});
test('preview and status accept only the private chat identifier', () => {
    for (const action of ['preview', 'status']) {
        const input = { action, chatId: randomUUID() };
        assert.deepEqual(telegramChatRemovalInput(input), input);
        assert.throws(() => telegramChatRemovalInput({ ...input, ownerUserId: randomUUID() }));
    }
});
test('reimport requires a fresh explicit operation and never silently selects a removed chat', () => {
    const input = { action: 'reimport', chatId: randomUUID(), expectedVersion: 7, operationId: randomUUID() };
    assert.deepEqual(telegramChatRemovalInput(input), input);
    assert.throws(() => telegramChatRemovalInput({ ...input, selected: true }));
    assert.throws(() => telegramChatRemovalInput({ ...input, operationId: null }));
});
