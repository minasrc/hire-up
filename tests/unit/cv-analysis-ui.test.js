import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisActive, analysisGuidance, analysisStatus, blockLabel, mergeAnalysisDraft } from '../../src/app/staff/telegram-intake/cv-analysis/analysis-model.js';
const current = { id: 'draft', version: 5, documentRevision: 2, status: 'pending' };
const baselineFields = { firstName: '', location: 'London', primaryEmail: '' };
const state = { current, incoming: { ...current, version: 6 }, baselineFields, localFields: baselineFields, nextFields: baselineFields };
test('analysis merges disjoint fields without saving or losing typed values', () => {
    assert.deepEqual(mergeAnalysisDraft({ ...state, localFields: { ...baselineFields, location: 'Paris' }, nextFields: { ...baselineFields, firstName: 'Ada' } }), { mode: 'merge', fields: { firstName: 'Ada', location: 'Paris', primaryEmail: '' } });
    assert.deepEqual(mergeAnalysisDraft({ ...state, localFields: { ...baselineFields, location: '' }, nextFields: { ...baselineFields, firstName: 'Ada' } }).fields, { firstName: 'Ada', location: '', primaryEmail: '' });
});
test('human clears and overlapping analysis changes require explicit conflict resolution', () => {
    assert.equal(mergeAnalysisDraft({ ...state, localFields: { ...baselineFields, location: '' }, nextFields: { ...baselineFields, location: 'Berlin' } }).mode, 'conflict');
    assert.equal(mergeAnalysisDraft({ ...state, localFields: { ...baselineFields, location: 'Paris' }, nextFields: { ...baselineFields, location: 'Berlin' } }).mode, 'conflict');
    assert.equal(mergeAnalysisDraft({ ...state, localFields: { ...baselineFields, location: 'Paris' }, nextFields: { ...baselineFields, location: 'Paris' } }).mode, 'merge');
});
test('document replacement and closure cannot silently accept a new baseline', () => {
    for (const incoming of [{ ...state.incoming, documentRevision: 3 }, { ...state.incoming, status: 'approved' }, { ...state.incoming, status: 'discarded' }]) assert.equal(mergeAnalysisDraft({ ...state, incoming }).mode, 'conflict');
    assert.equal(mergeAnalysisDraft({ ...state, incoming: { ...current, version: 4 } }).mode, 'ignore');
    assert.equal(mergeAnalysisDraft({ ...state, incoming: { ...current, id: 'someone-else' } }).mode, 'ignore');
    assert.equal(mergeAnalysisDraft({ ...state, incoming: current }).mode, 'merge');
});
test('CV status and references use actual parsed locations and fixed actionable errors', () => {
    assert.equal(analysisActive('leased'), true); assert.equal(analysisActive('completed'), false);
    assert.equal(analysisStatus({ stage: 'parse', status: 'leased' }), 'Reading CV text');
    assert.equal(blockLabel({ kind: 'pdf_page', page: 4 }), 'PDF page 4');
    assert.equal(blockLabel({ kind: 'docx_paragraph', part: 'word/document.xml', paragraph: 12 }), 'Document · Paragraph 12');
    assert.match(analysisGuidance('OCR_REQUIRED'), /review the original CV/);
    assert.match(analysisGuidance('TEXT_LIMIT'), /No text was truncated/);
    assert.doesNotMatch(analysisGuidance('secret provider data'), /secret provider/);
});
