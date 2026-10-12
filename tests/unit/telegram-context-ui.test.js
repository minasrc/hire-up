import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const compiled = ts.transpileModule(readFileSync(new URL('../../src/app/staff/telegram-intake/context/context-model.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { searchPayload, contextUrl, senderLabel, forwardedLabel, messageExcerpt, pendingFilterChanges, conversationDeepLink, sourceStatusLabel, nativeFeedLabel, nativeRepairPending, retainedMessageText, sourceSummary } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
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

test('source freshness describes partial checks, offline and blocked states without raw codes', () => {
    assert.match(sourceStatusLabel({ status: 'worker_offline' }), /remain searchable/);
    assert.match(sourceStatusLabel({ status: 'reconnect_required' }), /Reconnect/);
    assert.match(sourceStatusLabel({ status: 'off' }), /not selected/);
    assert.match(sourceStatusLabel({ status: 'paused' }), /Paused or cancelled/);
    assert.match(sourceStatusLabel({ status: 'checking' }), /out of date until checks finish/);
    const delayed = sourceStatusLabel({ status: 'waiting', errorCode: 'SECRET_DB_CODE' });
    assert.match(delayed, /delayed/);
    assert.equal(delayed.includes('SECRET_DB_CODE'), false);
    assert.match(sourceStatusLabel({ status: 'scheduled' }), /Selected/);
});

test('update status explains saved messages may still need checking', () => {
    const source = { mode: 'native_updates_with_reconciliation', status: 'scheduled', nativeStatus: 'live' };
    assert.match(nativeFeedLabel(source), /updates checked/);
    assert.match(nativeFeedLabel(source), /may still need checking/);
    for (const status of ['off', 'paused', 'worker_offline', 'reconnect_required']) assert.equal(nativeFeedLabel({ ...source, status }), null);
    assert.equal(nativeFeedLabel({ ...source, mode: 'retained_message_reconciliation' }), null);
});
test('initial, selection and provider repair gaps remain pending until a whole repair completes', () => {
    const source = { mode: 'native_updates_with_reconciliation', status: 'scheduled', nativeStatus: 'live', repairRequestedAt: '2026-10-11T10:00:00Z', repairCompletedAt: '2026-10-11T09:00:00Z', gapReason: 'PROVIDER_GAP' };
    assert.equal(nativeRepairPending(source), true);
    assert.match(nativeFeedLabel(source), /catching up/);
    assert.equal(nativeRepairPending({ ...source, status: 'paused' }), true);
    assert.equal(nativeRepairPending({ ...source, repairCompletedAt: '2026-10-11T11:00:00Z' }), false);
    assert.equal(nativeRepairPending({ ...source, repairRequestedAt: null, repairCompletedAt: null, gapReason: 'SELECTION_GAP' }), false);
    assert.equal(nativeRepairPending({ ...source, nativeStatus: 'baseline_pending' }), true);
    assert.equal(nativeRepairPending({ ...source, nativeStatus: 'repair_required' }), true);
});
test('native delays use safe text without exposing provider or database codes', () => {
    const label = nativeFeedLabel({ mode: 'native_updates_with_reconciliation', status: 'scheduled', nativeStatus: 'waiting', nativeErrorCode: 'INVALID_RESULT' });
    assert.match(label, /delayed/);
    assert.equal(label.includes('INVALID_RESULT'), false);
});

test('an unavailable retained source is not presented as a confirmed provider deletion', () => {
    const unavailable = { kind: 'unavailable', text: '', sentAt: null, editedAt: null };
    const display = retainedMessageText(unavailable, true);
    assert.match(display, /source is unavailable/);
    assert.match(display, /does not confirm a Telegram deletion/);
    assert.equal(retainedMessageText(unavailable), display);
    assert.equal(retainedMessageText({ kind: 'service', text: '' }, true), 'No retained message text.');
});
test('an edited source keeps literal original text in the viewer while result excerpts remain bounded', () => {
    const text = 'Edited original <script>literal source</script>\n' + 'more source '.repeat(1000);
    const source = { kind: 'message', text, editedAt: '2026-10-11T12:00:00Z' };
    assert.equal(retainedMessageText(source, true), text);
    assert.ok(retainedMessageText(source).length <= 601);
    assert.equal(source.text, text);
    assert.equal(source.editedAt, '2026-10-11T12:00:00Z');
});

test('compact source summaries prioritize paused and offline states over update availability', () => {
    const source = { mode: 'native_updates_with_reconciliation', status: 'scheduled', nativeStatus: 'live' };
    assert.equal(sourceSummary(source), 'Telegram updates checked.');
    assert.match(sourceSummary({ ...source, status: 'worker_offline' }), /offline/);
    assert.match(sourceSummary({ ...source, status: 'paused' }), /paused/);
    assert.match(sourceSummary({ ...source, status: 'off' }), /not selected/);
    assert.match(sourceSummary({ ...source, nativeStatus: 'repair_required' }), /catching up/);
    assert.match(sourceSummary({ ...source, nativeStatus: 'waiting', nativeErrorCode: 'FLOOD_WAIT' }), /delayed/);
    assert.equal(sourceSummary(source).includes('checkpoint'), false);
});


test('capacity delays explain the action needed while paused state stays authoritative', () => {
    const source = { mode: 'native_updates_with_reconciliation', status: 'scheduled', nativeStatus: 'waiting', nativeErrorCode: 'CAPACITY_LIMIT' };
    assert.match(sourceSummary(source), /Storage limit reached/);
    assert.match(sourceSummary(source), /Review and release saved context/);
    assert.match(sourceSummary({ ...source, status: 'off' }), /not selected/);
});


test('search freshness guidance works without local device setup instructions', () => {
    for (const status of ['worker_offline', 'waiting', 'checking', 'reconnect_required']) {
        const source = { status, mode: 'native_updates_with_reconciliation', nativeStatus: 'waiting' };
        for (const text of [sourceSummary(source), sourceStatusLabel(source), nativeFeedLabel(source)]) {
            assert.equal(/Mac|Keep the connector running|checkpoint|update feed/i.test(text || ''), false);
        }
    }
});
