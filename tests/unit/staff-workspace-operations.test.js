import assert from 'node:assert/strict';
import test from 'node:test';
import { workspaceCreationInput } from '../../src/lib/staff-workspace-operations.js';

const input = { operationId: '11111111-1111-4111-8111-111111111111', name: ' Synthetic workspace ', adminEmail: ' Admin@Example.test ' };
test('workspace creation accepts bounded display data and a stable operation id, never caller-supplied access scope', () => {
    assert.deepEqual(workspaceCreationInput(input), { ...input, name: 'Synthetic workspace', adminEmail: 'admin@example.test' });
    for (const changed of [{ organizationId: input.operationId }, { role: 'admin' }, { name: '' }, { name: 'a'.repeat(81) }, { name: 'hidden\u0000' }, { adminEmail: 'unverified' }, { operationId: 'arbitrary' }]) {
        assert.throws(() => workspaceCreationInput({ ...input, ...changed }));
    }
});
