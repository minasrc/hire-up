import assert from 'node:assert/strict';
import test from 'node:test';
import { hasIncompleteCoverage, searchGuidance, searchIsActive, searchStatusLabel, validResultHref } from '../../src/app/staff/candidates/search/search-model.js';
const sourceId = '11111111-2222-4333-8444-555555555555';

test('result destinations distinguish canonical profiles and owner-private draft review', () => {
    assert.equal(validResultHref({ sourceType: 'candidate', sourceId, href: 'https://untrusted.invalid' }), `/staff/candidates/${sourceId}`);
    assert.equal(validResultHref({ sourceType: 'draft', sourceId }), `/staff/telegram-intake?draft=${sourceId}`);
    assert.equal(validResultHref({ sourceType: 'message', sourceId }), null);
    assert.equal(validResultHref({ sourceType: 'candidate', sourceId: '../settings' }), null);
});

test('worker availability never turns a pending request into an empty completed search', () => {
    assert.equal(searchIsActive('queued'), true);
    assert.equal(searchIsActive('running'), true);
    for (const status of ['completed', 'failed', 'cancelled', 'expired']) assert.equal(searchIsActive(status), false);
    assert.match(searchStatusLabel('queued', false), /Waiting for/);
    assert.equal(searchStatusLabel('completed', false), 'Search complete');
});

test('coverage warns on pending, failed and unindexed eligible profiles', () => {
    assert.equal(hasIncompleteCoverage({ eligible: 4, indexed: 4, pending: 0, failed: 0 }), false);
    assert.equal(hasIncompleteCoverage({ eligible: 4, indexed: 3, pending: 1, failed: 0 }), true);
    assert.equal(hasIncompleteCoverage({ eligible: 4, indexed: 3, pending: 0, failed: 1 }), true);
    assert.equal(hasIncompleteCoverage({ eligible: 4, indexed: 3, pending: 0, failed: 0 }), true);
});

test('token and timeout failures have actionable copy without echoing raw worker errors', () => {
    assert.match(searchGuidance('INPUT_TOO_LONG'), /Shorten/);
    assert.match(searchGuidance('SEARCH_TIMEOUT'), /narrower scope/);
    assert.match(searchGuidance('SOURCE_TOO_LARGE'), /exceeds the indexing limit/);
    assert.doesNotMatch(searchGuidance('Private query: secret phrase'), /secret phrase/);
});
