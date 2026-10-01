import assert from 'node:assert/strict';
import test from 'node:test';
import { clientDirectoryQuery, jobDirectoryQuery } from '../../src/lib/staff-directory-query.js';

test('directory query bounds untrusted URL parameters and preserves literal searches', () => {
    assert.deepEqual(clientDirectoryQuery({ q: '  100%_client  ', page: '-1', status: 'bad' }), {
        query: '100%_client', status: 'all', page: 1,
    });
    assert.equal(clientDirectoryQuery({ q: 'x'.repeat(201) }).query.length, 200);
    for (const page of ['Infinity', '1.5', '1000001', ['2'], undefined]) {
        assert.equal(jobDirectoryQuery({ page }).page, 1);
    }
    assert.equal(jobDirectoryQuery({ client: "' or true", state: 'nope', sort: 'sql', dir: 'nope' }).clientId, null);
});

test('job filters retain legacy URLs and all status/sort combinations', () => {
    const id = '90000000-0000-4000-8000-000000000001';
    assert.deepEqual(jobDirectoryQuery({ q: 'Engineer', client: id, state: 'unlisted',
        intake: 'closed', owner: 'me', sort: 'publication', dir: 'desc', page: '3' }), {
        query: 'Engineer', clientId: id, state: 'unlisted', intake: 'closed', mine: true,
        sortBy: 'publication', sortDirection: 'desc', page: 3,
    });
});
