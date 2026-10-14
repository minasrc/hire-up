import test from 'node:test';
import assert from 'node:assert/strict';
import { searchIndexingStatus } from '../../src/app/staff/candidates/search/search-model.js';
import { candidateSearchIntent, relevantCandidateResults } from '../../src/lib/candidate-search-query.js';

test('candidate search separates experience constraints from skills and titles', () => {
    assert.deepEqual(candidateSearchIntent('staff engineers'), { terms: ['staff', 'engineer'], experience: null });
    for (const query of ['6 years', 'six years of experience']) {
        assert.deepEqual(candidateSearchIntent(query), { terms: [], experience: { years: 6, comparison: 'eq' } });
    }
    assert.deepEqual(candidateSearchIntent('Solidity engineers with at least five years of experience'), {
        terms: ['solidity', 'engineer'], experience: { years: 5, comparison: 'gte' },
    });
    assert.deepEqual(candidateSearchIntent('6+ years remote'), { terms: ['remote'], experience: { years: 6, comparison: 'gte' } });
    assert.equal(candidateSearchIntent('less than 5 years').experience.comparison, 'lt');
    assert.equal(candidateSearchIntent('six projects').experience, null);
});

test('semantic directory results exclude weak matches and invalid scores', () => {
    const results = [
        { sourceType: 'candidate', score: 0.6, sourceId: 'strong' },
        { sourceType: 'candidate', score: 0.1, sourceId: 'weak' },
        { sourceType: 'candidate', score: 0.3, sourceId: 'distant' },
        { sourceType: 'candidate', score: 0.19, sourceId: 'weak2' },
        { sourceType: 'candidate', sourceId: 'missing' },
        { sourceType: 'draft', score: 0.9 },
    ];
    assert.deepEqual(relevantCandidateResults(results).map(row => row.sourceId), ['strong']);
    assert.deepEqual(relevantCandidateResults([{ sourceType: 'candidate', score: 0.11 }]), []);
    assert.deepEqual(relevantCandidateResults([{ sourceType: 'candidate', score: 0.3 }], 0.6), [], 'later pages use the original top score');
});

test('search distinguishes missing indexes, failures, changed profiles and complete coverage', () => {
    assert.equal(searchIndexingStatus(null), null);
    assert.equal(searchIndexingStatus({ eligible: 4, indexed: 4, fullyIndexed: 4, pending: 0, failed: 0 }), null);
    assert.equal(searchIndexingStatus({ eligible: 4, indexed: 1, pending: 2, failed: 1 }).label, 'Indexing 2 profiles · 1 profile needs attention');
    assert.equal(searchIndexingStatus({ eligible: 1, indexed: 1, fullyIndexed: 0, pending: 0, failed: 1 }).incomplete, true, 'partial profile/CV coverage is still incomplete');
    assert.equal(searchIndexingStatus({ eligible: 2, indexed: 1 }).label, '1 profile awaiting indexing');
    assert.equal(searchIndexingStatus({ eligible: 2, indexed: 2, corpusChanged: true }).label, 'Profiles updated');
});
