import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { LITERAL_BOUNDARY_RANGES, LITERAL_BOUNDARY_UNICODE_VERSION, literalValueBoundary } from '../../src/lib/telegram-literal-boundaries.js';
test('pinned Unicode separator intervals are sorted, maximal and match their documented Unicode16.0 generation', () => {
  assert.equal(LITERAL_BOUNDARY_UNICODE_VERSION, '16.0');
  const reference = readFileSync(new URL('../../scripts/reference/unicode-16.0.0/DerivedGeneralCategory.txt', import.meta.url));
  assert.equal(createHash('sha256').update(reference).digest('hex'), '7676ab755a41ef82108460238569e60ad65c191ddafe61b36c6765ec1353f293');
  const oracle = new Uint8Array(0x110000);
  const covered = new Uint8Array(0x110000);
  for (const line of reference.toString('utf8').split('\n')) {
    const record = line.split('#')[0].trim();
    if (!record || record.startsWith('#')) continue;
    const [interval, category] = record.split(';').map(part => part.trim());
    const [start, end = start] = interval.split('..').map(hex => Number.parseInt(hex, 16));
    assert.ok(Number.isInteger(start) && start <= end && end < 0x110000);
    for (let cp = start; cp <= end; cp++) {
      assert.equal(covered[cp], 0); covered[cp] = 1;
      oracle[cp] = ['P', 'S', 'Z'].includes(category[0]) ? 1 : 0;
    }
  }
  assert.ok(covered.every(value => value === 1));
  let previousEnd = -1;
  for (const [from, to] of LITERAL_BOUNDARY_RANGES) {
    assert.ok(Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to <= 0x110000 && from < to && from > previousEnd);
    previousEnd = to;
  }
  assert.equal(literalValueBoundary(''), true);
  for (const invalid of [null, undefined, 'ab', '\ud800']) assert.equal(literalValueBoundary(invalid), false);
  for (let cp = 0; cp < 0x110000; cp++) {
    const character = String.fromCodePoint(cp);
    const expected = cp >= 9 && cp <= 13 || oracle[cp] === 1;
    if (literalValueBoundary(character) !== expected) assert.fail(`Pinned category mismatch at U+${cp.toString(16)}`);
  }
});

test('generation ignores engine Unicode version and property regex data', () => {
  const script = new URL('../../scripts/generate-telegram-literal-boundaries.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `Object.defineProperty(process.versions, 'unicode', {value: '17.0'}); const original = RegExp.prototype.test; RegExp.prototype.test = function(value) { if (this.source.includes('\\p{')) throw new Error('Engine Unicode category use'); return original.call(this, value); }; process.argv.push('--check'); await import(${JSON.stringify(script)});`], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /351 pinned ranges/);
});
