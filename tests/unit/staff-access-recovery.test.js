import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function boundary(file, overrides = {}) {
    const session = { provider: 'google', subject: '123', emailVerified: true, user: { email: 'person@example.com' } };
    const imports = {
        'server-only': {},
        react: { cache: (fn) => fn },
        'next/headers': { cookies: async () => ({ get: () => ({ value: 'proof' }) }) },
        'next/navigation': { redirect: (url) => { throw new Error(url); } },
        'next-auth': { getServerSession: async () => session },
        './auth-options': { authOptions: {} },
        './staff-identity': { staffIdentityFromSession: (s) => s, staffInviteEmailFromSession: () => session.user.email },
        './staff-db.server': {
            getStaffPool: () => ({}),
            resolveOrClaimStaffPrincipal: async () => ({ user_id: 'user' }),
        },
        './staff-google.server': { staffGoogleCredentialStatus: async () => 'active' },
        './staff-mfa.server': { getTotpStatus: async () => ({ status: 'active', credentialId: 'credential' }) },
        './staff-mfa-cookie': { STAFF_MFA_COOKIE: 'staff_mfa', readStaffMfaProof: () => ({}) },
        './staff-operations': { StaffOperationsError: class extends Error {} },
        './client-job-contracts': { ClientJobContractError: class extends Error {} },
        './staff-authorization': { StaffAuthorizationError: class extends Error {} },
        ...overrides,
    };
    const exports = {};
    runInNewContext(ts.transpileModule(readFileSync(new URL(`../../src/lib/${file}`, import.meta.url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText, {
        exports, require: (name) => { assert.ok(imports[name], name); return imports[name]; },
        process: { env: { STAFF_ORGANIZATION_ID: 'org', NEXTAUTH_SECRET: 'secret' } },
        console: { error: () => {} }, Response,
    });
    return exports;
}

test('revoked Google authorization directs an existing session to reauthentication', async () => {
    const gate = boundary('staff-gate.server.js', {
        './staff-google.server': { staffGoogleCredentialStatus: async () => 'revoked' },
    });
    assert.equal((await gate.staffGate()).stage, 'reauthenticate');
    await assert.rejects(gate.requireStaffVerified, { message: '/staff/sign-in' });
});

for (const failure of ['resolution', 'mfa']) {
    const overrides = failure === 'resolution'
        ? { './staff-db.server': { getStaffPool: () => ({}), resolveOrClaimStaffPrincipal: async () => { throw new Error('DB unavailable'); } } }
        : { './staff-mfa.server': { getTotpStatus: async () => { throw new Error('DB unavailable'); } } };
    test(`${failure} outage is unavailable, never a missing membership`, async () => {
        const gate = boundary('staff-gate.server.js', overrides);
        assert.equal((await gate.staffGate()).stage, 'unavailable');
        await assert.rejects(gate.requireStaffVerified, { message: '/staff/unavailable' });
        const api = boundary('staff-api.server.js', overrides);
        const context = await api.staffApiContext();
        assert.equal(context.status, 'unavailable');
        assert.equal(api.staffGateResponse(context).status, 503);
    });
}

test('real missing membership stays denied and a verified member still enters', async () => {
    const gate = boundary('staff-gate.server.js', {
        './staff-db.server': { getStaffPool: () => ({}), resolveOrClaimStaffPrincipal: async () => null },
    });
    assert.equal((await gate.staffGate()).stage, 'unresolved');
    await assert.rejects(gate.requireStaffVerified, { message: '/staff/no-access' });
    assert.equal((await boundary('staff-gate.server.js').requireStaffVerified()).stage, 'verified');
});

for (const code of ['42501', '23505']) {
    test(`invite denial ${code} is not reported as an outage`, async () => {
        const overrides = {
            './staff-db.server': { getStaffPool: () => ({}), resolveOrClaimStaffPrincipal: async () => {
                throw Object.assign(new Error('denied'), { code });
            } },
        };
        assert.equal((await boundary('staff-gate.server.js', overrides).staffGate()).stage, 'unresolved');
        assert.equal((await boundary('staff-api.server.js', overrides).staffApiContext()).status, 'unauthorized');
    });
}
