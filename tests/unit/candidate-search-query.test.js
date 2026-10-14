import test from 'node:test';
import assert from 'node:assert/strict';
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
