import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const compiled = ts.transpileModule(readFileSync(new URL('../../src/app/staff/telegram-intake/context/context-model.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { searchPayload, contextUrl, senderLabel, forwardedLabel, messageExcerpt, pendingFilterChanges, conversationDeepLink } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
test('search retains quoted terms and inclusive dates in a POST payload', () => {
    assert.deepEqual(searchPayload({ query: '  "product designer" OR engineer ', chatId: '', sender: ' @ada ', from: '2026-10-01', to: '2026-10-11', attachmentsOnly: true }, 'cursor'), { action: 'search', query: '"product designer" OR engineer', chatId: null, sender: '@ada', from: '2026-10-01', to: '2026-10-11', attachmentsOnly: true, after: 'cursor' });
});
test('conversation navigation sends one bounded direction and only identifiers', () => {
    assert.equal(contextUrl('chat', { chatId: 'chat', anchor: '19', before: '10', after: '20' }), '/api/staff/telegram-context?chatId=chat&anchor=19');
    assert.equal(contextUrl('chat', { after: '20' }), '/api/staff/telegram-context?chatId=chat&after=20');
});
test('missing attribution remains truthful', () => {
    assert.equal(senderLabel(null), 'Unknown sender');
    assert.equal(senderLabel({ displayName: null, username: '@ada' }), '@ada');
    assert.equal(forwardedLabel({ peer: { kind: 'user', id: '5' }, displayName: null }), 'Forwarded message');
    assert.equal(forwardedLabel({ displayName: 'Original sender' }), 'Original sender');
    assert.equal(forwardedLabel(null), null);
});

test('results excerpts bound rendering without changing the original text', () => {
    const original = 'word '.repeat(7000);
    const excerpt = messageExcerpt(original);
    assert.equal(excerpt.length, 601);
    assert.equal(excerpt.endsWith('…'), true);
    assert.equal(original.length, 35000);
    assert.equal(messageExcerpt('Short original'), 'Short original');
    assert.equal(messageExcerpt('a'.repeat(599) + '😀').includes('\ud83d'), false);
});
test('filter notices compare submitted search while pagination keeps that payload', () => {
    const submitted = { query: 'engineer', chatId: '', sender: '', from: '', to: '', attachmentsOnly: false };
    assert.equal(pendingFilterChanges({ ...submitted, query: ' engineer ' }, submitted), false);
    assert.equal(pendingFilterChanges({ ...submitted, attachmentsOnly: true }, submitted), true);
    assert.equal(pendingFilterChanges(submitted, null), false);
    assert.equal(searchPayload(submitted, 'previous-cursor').query, 'engineer');
});
test('deep links require canonical identifier structure and positive bounded message ids', () => {
    const chatId = '11111111-1111-4111-8111-111111111111';
    assert.deepEqual(conversationDeepLink(chatId, '2147483647'), { chatId, anchor: '2147483647' });
    assert.deepEqual(conversationDeepLink(chatId, null), { chatId });
    for (const anchor of ['0', '01', '-1', '2147483648', '999999999999999999', '']) assert.equal(conversationDeepLink(chatId, anchor), null);
    assert.equal(conversationDeepLink('a'.repeat(36), '1'), null);
    assert.equal(conversationDeepLink('--------1111-4111-8111-111111111111', '1'), null);
});
