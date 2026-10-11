import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const compiled = ts.transpileModule(readFileSync(new URL('../../src/app/staff/telegram-intake/context/context-model.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { searchPayload, contextUrl, senderLabel, forwardedLabel } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
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
