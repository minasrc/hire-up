import assert from 'node:assert/strict';
import test from 'node:test';
import { activeCvStatus, classifyCvDraftRefresh, cvGuidance, cvStatusLabel } from '../../src/app/staff/telegram-intake/cv/cv-model.js';

const current = { id: 'draft-one', version: 4, status: 'pending' };
const baselineFields = { firstName: 'Ada', location: 'London', secondaryEmails: '' };
const state = { current, incoming: { ...current, version: 5 }, baselineFields, localFields: baselineFields, nextFields: baselineFields };

test('background CV attachment advances the baseline without discarding unsaved profile edits', () => {
    assert.equal(classifyCvDraftRefresh({ ...state, localFields: { ...baselineFields, location: 'Paris' } }), 'preserve_edits');
    assert.equal(classifyCvDraftRefresh(state), 'replace_fields');
    assert.equal(classifyCvDraftRefresh({ ...state, nextFields: { secondaryEmails: '', location: 'London', firstName: 'Ada' }, localFields: { ...baselineFields, location: '' } }), 'preserve_edits');
});

test('newer server profile changes conflict with local edits instead of authorizing an overwrite', () => {
    assert.equal(classifyCvDraftRefresh({ ...state, localFields: { ...baselineFields, location: 'Paris' }, nextFields: { ...baselineFields, firstName: 'Augusta' } }), 'conflict');
    assert.equal(classifyCvDraftRefresh({ ...state, nextFields: { ...baselineFields, firstName: 'Augusta' } }), 'replace_fields');
});

test('stale, unrelated and closed draft updates cannot reopen or roll back the editor', () => {
    for (const incoming of [{ ...current }, { ...current, version: 3 }, { ...current, id: 'another-draft', version: 8 }]) {
        assert.equal(classifyCvDraftRefresh({ ...state, incoming }), 'ignore');
    }
    assert.equal(classifyCvDraftRefresh({ ...state, current: { ...current, status: 'approved' } }), 'ignore');
    for (const status of ['approved', 'discarded']) {
        assert.equal(classifyCvDraftRefresh({ ...state, incoming: { ...state.incoming, status }, localFields: { ...baselineFields, location: 'Paris' } }), 'closed');
    }
});

test('CV status never promises attachment before validation and errors give fixed guidance', () => {
    assert.equal(activeCvStatus('leased'), true);
    assert.equal(activeCvStatus('completed'), false);
    assert.match(cvStatusLabel('leased'), /Downloading and validating/);
    assert.match(cvStatusLabel('completed'), /validated and attached/);
    assert.match(cvGuidance('SOURCE_CHANGED'), /will not substitute/);
    assert.match(cvGuidance('FILE_TOO_LARGE'), /4 MB/);
    assert.match(cvGuidance('CV_EXISTS'), /will not replace/);
    assert.match(cvGuidance('DRAFT_DOCUMENT_CHANGED'), /protect the chosen file/);
    assert.match(cvGuidance('CANCELLED'), /You cancelled/);
    assert.match(cvGuidance('ACCOUNT_MISMATCH'), /account that imported/);
    assert.doesNotMatch(cvGuidance('secret worker error payload'), /secret/);
});
