import assert from 'node:assert/strict';
import test from 'node:test';
import { canResolveSuggestion, extractionChatIds, extractionGuidance, extractionStatus, suggestionValue } from '../../src/app/staff/telegram-intake/extraction/extraction-model.js';

test('extraction targets only marked chats that have imported messages', () => {
    const chats = [{ id: 'one', import: null }, { id: 'two', import: { importedMessages: 4 } }, { id: 'three', import: { importedMessages: 9 } }];
    assert.deepEqual(extractionChatIds(chats, ['one', 'two']), ['two']);
    assert.deepEqual(extractionChatIds(chats, []), []);
    assert.equal(extractionChatIds(Array.from({ length: 55 }, (_, i) => ({ id: String(i), import: { importedMessages: 1 } })), Array.from({ length: 55 }, (_, i) => String(i))).length, 50);
});

test('manual edits and in-flight changes prevent proposal decisions; closed drafts only allow dismiss', () => {
    const state = { dirty: false, busy: false, conflict: false, terminal: false };
    assert.equal(canResolveSuggestion(state, 'apply'), true);
    for (const key of ['dirty', 'busy', 'conflict']) {
        assert.equal(canResolveSuggestion({ ...state, [key]: true }, 'apply'), false);
        assert.equal(canResolveSuggestion({ ...state, [key]: true }, 'dismiss'), false);
    }
    assert.equal(canResolveSuggestion({ ...state, terminal: true }, 'apply'), false);
    assert.equal(canResolveSuggestion({ ...state, terminal: true }, 'dismiss'), true);
});

test('model completion is distinguished from recruiter review acknowledgment', () => {
    assert.equal(extractionStatus({ status: 'completed', reviewedAt: null }), 'Ready for review');
    assert.equal(extractionStatus({ status: 'completed', reviewedAt: '2026-01-01T00:00:00Z' }), 'Review acknowledged');
    assert.equal(extractionStatus({ status: 'failed' }), 'Needs attention');
    assert.match(extractionGuidance('INVALID_RESULT'), /retained/);
    assert.match(extractionGuidance('INPUT_TOO_LARGE'), /administrator/);
    assert.match(extractionGuidance('INPUT_TOO_LARGE'), /not been skipped or deleted/);
    assert.equal(extractionGuidance('private provider response sentinel').includes('sentinel'), false);
});

test('cleared human fields and secondary emails have clear review labels', () => {
    assert.equal(suggestionValue(''), 'Not provided');
    assert.equal(suggestionValue(null), 'Not provided');
    assert.equal(suggestionValue([]), 'Not provided');
    assert.equal(suggestionValue(['one@example.test', 'two@example.test']), 'one@example.test, two@example.test');
});
