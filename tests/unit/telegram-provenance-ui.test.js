import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const compiled = ts.transpileModule(readFileSync(new URL('../../src/app/staff/candidates/[candidateId]/telegram-provenance-model.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { provenanceLink, provenanceSourceLabel, provenanceVisible } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
test('private provenance does not assert a source exists when the owner read returns none', () => {
    assert.equal(provenanceVisible(null), false);
    assert.equal(provenanceVisible({ sources: [], nextAfter: null, provenanceUnavailable: false }), false);
    assert.equal(provenanceVisible({ sources: [], nextAfter: null, provenanceUnavailable: true }), true);
});
test('available and released sources keep the same original identifier anchor without quote metadata', () => {
    const source = { id: 'source', chatId: '11111111-1111-4111-8111-111111111111', messageId: '99', extractionJobId: 'job', available: true, sourceChanged: false, text: 'private quote' };
    const href = provenanceLink(source);
    assert.equal(href, '/staff/telegram-intake/context?chatId=11111111-1111-4111-8111-111111111111&messageId=99');
    assert.equal(provenanceLink({ ...source, available: false, sourceChanged: true }), href);
    assert.equal(href.includes('private'), false);
    assert.equal(href.includes('job'), false);
    assert.equal(provenanceSourceLabel(source), 'View original message');
    assert.match(provenanceSourceLabel({ ...source, available: false }), /Source unavailable/);
});
