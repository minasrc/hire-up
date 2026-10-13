import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as cookie from '../../src/lib/staff-workspace-cookie.js';

const first = '11111111-1111-4111-8111-111111111111', second = '22222222-2222-4222-8222-222222222222';
const subject = '123456', secret = 'synthetic-signing-secret';
const compiled = ts.transpileModule(readFileSync(new URL('../../src/lib/staff-workspace-context.server.js', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;

function context(value, expected, enabled = true, pageExpected = null) {
    const exports = {};
    const imports = { 'server-only': {}, './staff-workspace-cookie.js': cookie,
        'next/headers': { cookies: async () => ({ get: () => value ? { value } : undefined }), headers: async () => new Headers({ ...(expected ? { 'x-staff-workspace-id': expected } : {}), ...(pageExpected ? { 'x-staff-page-workspace-id': pageExpected } : {}) }) } };
    runInNewContext(compiled, { exports, require: name => imports[name],
        process: { env: { STAFF_ORGANIZATION_ID: first, NEXTAUTH_SECRET: secret, STAFF_MULTI_WORKSPACE_ENABLED: enabled ? '1' : '0' } } });
    return exports.staffWorkspaceContext;
}

test('stale and missing API scope are denied before any business work; pages can resolve a signed selection', async () => {
    const selection = cookie.signStaffWorkspace(secret, subject, second, Date.now() + 3600000);
    assert.equal((await context(selection, first)({ subject }, { api: true })).status, 'workspace-changed');
    assert.equal((await context(selection, null)({ subject }, { api: true })).status, 'workspace-changed');
    assert.equal((await context(selection, second)({ subject }, { api: true })).organizationId, second);
    assert.equal((await context(selection, null)({ subject })).organizationId, second);
    assert.equal((await context(selection, second)({ subject: '9999' }, { api: true })).status, 'workspace-required');
    assert.equal((await context('tampered', first)({ subject })).status, 'workspace-required');
    assert.equal((await context(null, null, false)({ subject }, { api: true })).organizationId, first);
    assert.equal((await context(null, second, false)({ subject }, { api: true })).status, 'workspace-changed');
    assert.equal((await context(selection, null, true, first)({ subject })).status, 'workspace-required', 'stale programmatic page navigation is denied before principal or business reads');
    assert.equal((await context(selection, null, true, second)({ subject })).organizationId, second);
    assert.equal((await context(selection, null, true, 'invalid')({ subject })).status, 'workspace-required');
});

test('disabled rollout ignores stale selection cookies and keeps legacy API scope checks', async () => {
    const foreign = cookie.signStaffWorkspace(secret, '9999', second, Date.now() + 3600000);
    for (const value of ['expired-or-invalid', foreign]) {
        assert.equal((await context(value, null, false)({ subject })).organizationId, first);
        assert.equal((await context(value, first, false)({ subject }, { api: true })).organizationId, first);
        assert.equal((await context(value, second, false)({ subject }, { api: true })).status, 'workspace-changed');
    }
});
