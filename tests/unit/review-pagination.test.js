import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAdjacentReviewPage } from '../../src/lib/review-pagination.js';
const rows = Array.from({ length: 80 }, (_, index) => ({ applicationId: `app-${String(80 - index).padStart(3, '0')}`, receivedAt: '2026-09-23T00:00:00Z' }));
const loader = (data) => async (page) => ({ applications: data.slice((page - 1) * 25, page * 25), total: data.length, pageSize: 25 });
test('review loads the next page and supports going back from a later starting page', async () => {
    const next = await loadAdjacentReviewPage({ queue: rows.slice(0, 25), direction: 1, frontier: 1, offset: 0, loadPage: loader(rows) });
    assert.deepEqual(next.rows, rows.slice(25, 50));
    const previous = await loadAdjacentReviewPage({ queue: rows.slice(50, 75), direction: -1, frontier: 3, offset: 50, loadPage: loader(rows) });
    assert.deepEqual(previous.rows, rows.slice(25, 50));
});
test('review does not skip applications when decisions remove a whole page from the filter', async () => {
    const next = await loadAdjacentReviewPage({ queue: rows.slice(0, 50), direction: 1, frontier: 2, offset: 0, loadPage: loader(rows.slice(25)) });
    assert.deepEqual(next.rows, rows.slice(50, 75));
});
test('review starting in the middle stays beyond the original boundary after decisions', async () => {
    const next = await loadAdjacentReviewPage({ queue: rows.slice(50, 75), direction: 1, frontier: 3, offset: 50, loadPage: loader(rows.filter((_, index) => index < 50 || index >= 75)) });
    assert.deepEqual(next.rows, rows.slice(75));
});
test('review stops at the end and discards stale navigation responses', async () => {
    assert.equal(await loadAdjacentReviewPage({ queue: rows, direction: 1, frontier: 4, offset: 0, loadPage: loader(rows) }), null);
    assert.equal(await loadAdjacentReviewPage({ queue: rows.slice(0, 25), direction: 1, frontier: 1, offset: 0, loadPage: loader(rows), isCurrent: () => false }), null);
});
