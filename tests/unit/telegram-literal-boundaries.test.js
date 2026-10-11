import assert from 'node:assert/strict';
import test from 'node:test';
import { LITERAL_BOUNDARY_RANGES, LITERAL_BOUNDARY_UNICODE_VERSION, literalValueBoundary } from '../../src/lib/telegram-literal-boundaries.js';
test('pinned Unicode separator intervals are sorted, maximal and match their documented Unicode16.0 generation', () => {
  assert.equal(process.versions.unicode, LITERAL_BOUNDARY_UNICODE_VERSION);
  let previousEnd = -1;
  for (const [from, to] of LITERAL_BOUNDARY_RANGES) {
    assert.ok(Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to <= 0x110000 && from < to && from > previousEnd);
    previousEnd = to;
  }
  assert.equal(literalValueBoundary(''), true);
  for (const invalid of [null, undefined, 'ab', '\ud800']) assert.equal(literalValueBoundary(invalid), false);
  for (let cp = 0; cp < 0x110000; cp++) {
    const character = String.fromCodePoint(cp);
    const expected = cp >= 9 && cp <= 13 || /[\p{P}\p{S}\p{Z}]/u.test(character);
    if (literalValueBoundary(character) !== expected) assert.fail(`Pinned category mismatch at U+${cp.toString(16)}`);
  }
});
