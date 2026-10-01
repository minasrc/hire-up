import assert from 'node:assert/strict';
import test from 'node:test';
import { searchInvalidated, hasIncompleteCoverage, safeSearchSnapshot, searchCvMode, searchGuidance } from '../../src/app/staff/candidates/search/search-model.js';
test('CV coverage remains incomplete when profiles are ready but CV components are not', () => {
    assert.equal(hasIncompleteCoverage({ eligible: 2, indexed: 2, fullyIndexed: 1, pending: 0, failed: 0 }), true);
    assert.equal(hasIncompleteCoverage({ eligible: 2, indexed: 2, fullyIndexed: 2, pending: 0, failed: 0 }), false);
    assert.equal(hasIncompleteCoverage({ eligible: 2, indexed: 2, pending: 0, failed: 0 }), false);
});
test('private-draft scope never enables CV text even when the recruiter prefers it', () => {
    assert.equal(searchCvMode('my_drafts', true), false);
    assert.equal(searchCvMode('approved', true), true);
    assert.equal(searchCvMode('all', true), true);
    assert.equal(searchCvMode('all', false), false);
});
test('CV access, content and index invalidation remove cached snippets, cursor and CV coverage', () => {
    const cached = { status: 'completed', results: [{ matchedText: 'Private CV sentinel' }], nextAfter: 'page-two', capacity: { readyChunks: 100 }, coverage: { indexed: 2, cv: { indexed: 2 } } };
    for (const errorCode of ['CV_ACCESS_CHANGED', 'CV_RESULTS_CHANGED', 'INDEX_CHANGED']) {
        const result = safeSearchSnapshot({ ...cached, errorCode });
        assert.equal(result.status, 'failed'); assert.deepEqual(result.results, []); assert.equal(result.nextAfter, null); assert.equal(result.capacity, null); assert.equal(result.coverage.cv, null);
        assert.equal(searchInvalidated(errorCode), true);
    }
    assert.equal(safeSearchSnapshot(cached), cached);
    assert.equal(searchInvalidated('SEARCH_CAPACITY'), false);
});
test('capacity and stale access guidance require an explicit fresh search', () => {
    assert.equal(searchGuidance('INDEX_CHANGED'), 'Our search index was updated. Run this search again.');
    assert.match(searchGuidance('SEARCH_CAPACITY'), /Search profiles only/);
    assert.match(searchGuidance('CV_RESULTS_CHANGED'), /Previous results were cleared/);
    assert.match(searchGuidance('CV_ACCESS_CHANGED'), /access.*changed/);
});
