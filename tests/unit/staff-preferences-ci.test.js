import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
test('the existing TOTP CI command covers preference security serially', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    assert.equal(pkg.scripts['test:db:totp'], 'node --test --test-concurrency=1 tests/database/staff-totp.test.js tests/database/staff-time-zone.test.js');
});
