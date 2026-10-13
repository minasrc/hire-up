import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createPrivateSnapshotGuard, privateAccessDenied } from '../../src/app/staff/telegram-intake/extraction/private-snapshot-guard.js';
const compiled = ts.transpileModule(readFileSync(new URL('../../src/app/staff/telegram-intake/extraction/batch-source-model.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { batchAuthor, primaryHasAttachments } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
test('a held private source response cannot restore data after auth invalidation or an explicit retry', async () => {
    let epoch = 1;
    const guard = createPrivateSnapshotGuard(() => epoch);
    const old = guard.begin('source');
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let privateSnapshot = { primary: 'earlier source', contextOnly: 'earlier private context' };
    const completion = held.then(data => { if (guard.accepts(old)) privateSnapshot = data; });
    guard.invalidate(); privateSnapshot = null; epoch++;
    assert.equal(old.controller.signal.aborted, true);
    assert.equal(guard.begin('source'), null);
    guard.retry(); const authorized = guard.begin('source');
    release({ primary: 'late primary', contextOnly: 'late private context' }); await completion;
    assert.equal(privateSnapshot, null);
    assert.equal(guard.accepts(authorized), true);
});
test('replacement reads, permission denial and MFA invalidate private reads and retention mutations', () => {
    let epoch = 3;
    const guard = createPrivateSnapshotGuard(() => epoch);
    const old = guard.begin('read'), replacement = guard.begin('read'), mutation = guard.begin('action');
    assert.equal(guard.accepts(old), false);
    assert.equal(guard.accepts(replacement), true);
    assert.equal(guard.accepts(mutation), true);
    epoch++;
    assert.equal(guard.accepts(replacement), false);
    assert.equal(guard.accepts(mutation), false);
    for (const status of [401, 403, 428]) assert.equal(privateAccessDenied(status), true);
    assert.equal(privateAccessDenied(404), false);
    guard.invalidate();
    assert.equal(mutation.controller.signal.aborted, true);
    assert.equal(guard.begin('read'), null);
});
test('background authors remain their actual authors and context attachments do not unlock CV actions', () => {
    const reply = { messageId: '2', text: 'I agree', sender: { displayName: 'Reply author', username: 'reply' }, attachments: [] };
    const context = { messageId: '1', text: 'Earlier background', sender: { displayName: 'Original background author', username: 'original' }, attachments: [{ kind: 'document', filename: 'Context-only.pdf' }] };
    const snapshot = { messages: [reply], contextOnly: [context] };
    assert.equal(batchAuthor(reply), 'Reply author');
    assert.equal(batchAuthor(context), 'Original background author');
    assert.equal(primaryHasAttachments(snapshot), false);
    assert.equal(primaryHasAttachments({ ...snapshot, messages: [{ ...reply, attachments: [{ kind: 'document' }] }] }), true);
    assert.equal(primaryHasAttachments({ messages: [reply] }), false);
    assert.equal(batchAuthor({ sender: null }), 'Unknown original author');
});

test('real extraction access handling clears snapshots on MFA and permission loss, while feature-off stays local', async () => {
    const apiSource = readFileSync(new URL('../../src/app/staff/telegram-intake/extraction/extraction-api.ts', import.meta.url), 'utf8');
    const apiCompiled = ts.transpileModule(apiSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
        .replace("'@/lib/staff-workspace-fetch'", JSON.stringify(new URL('../../src/lib/staff-workspace-fetch.js', import.meta.url).href))
        .replace("'@/lib/staff-auth-recovery'", JSON.stringify(new URL('../../src/lib/staff-auth-recovery.js', import.meta.url).href))
        .replace("'./private-snapshot-guard'", JSON.stringify(new URL('../../src/app/staff/telegram-intake/extraction/private-snapshot-guard.js', import.meta.url).href));
    const { ExtractionError, extractionAccessLost } = await import(`data:text/javascript;base64,${Buffer.from(apiCompiled).toString('base64')}`);
    const { staffAuthRecovery } = await import('../../src/lib/staff-auth-recovery.js');
    const previousWindow = globalThis.window;
    let privateSnapshot, invalidations;
    globalThis.window = { dispatchEvent(event) { if (event.type === 'staff-session-invalidated') { invalidations++; privateSnapshot = null; } } };
    try {
        for (const status of [401, 403, 428]) {
            staffAuthRecovery.reset(); privateSnapshot = { text: 'private primary', contextOnly: 'private background' }; invalidations = 0;
            assert.equal(extractionAccessLost(new ExtractionError(status), staffAuthRecovery.requestEpoch()), true);
            assert.equal(privateSnapshot, null); assert.equal(invalidations, 1);
            assert.equal(staffAuthRecovery.getSnapshot().required, status !== 403);
            assert.equal(staffAuthRecovery.getSnapshot().mfa, status === 428);
        }
        staffAuthRecovery.reset(); privateSnapshot = { text: 'private source' }; invalidations = 0;
        assert.equal(extractionAccessLost(new ExtractionError(404), staffAuthRecovery.requestEpoch()), false);
        assert.equal(invalidations, 0);
        assert.notEqual(privateSnapshot, null);
    } finally { staffAuthRecovery.reset(); if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
});
