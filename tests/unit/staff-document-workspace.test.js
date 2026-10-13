import assert from 'node:assert/strict';
import test from 'node:test';
import { documentWorkspaceExpectation } from '../../src/lib/staff-document-workspace.js';

const id = '11111111-1111-4111-8111-111111111111';
test('document navigation rejects missing, malformed and ambiguous expectations without deriving authority from a URL', () => {
    const base = 'https://app.test/api/staff/documents/synthetic';
    assert.equal(documentWorkspaceExpectation(base), null);
    assert.equal(documentWorkspaceExpectation(`${base}?view=inline&_workspace=${id}`), id);
    for (const query of ['_workspace=', '_workspace=invalid', `_workspace=${id}&_workspace=${id}`]) {
        assert.equal(documentWorkspaceExpectation(`${base}?${query}`), 'invalid');
    }
});
