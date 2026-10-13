import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { staffRequestOriginAllowed } from '../../src/lib/staff-request-origin.js';

function helper({ signedIn = true, google = 'active', retry = 0 } = {}) {
    let reservations = 0;
    const imports = {
        './staff-request-origin.js': { staffRequestOriginAllowed },
        'server-only': {}, 'next/headers': { cookies: async () => ({ set: () => {} }) },
        'next-auth': { getServerSession: async () => signedIn ? {} : null },
        './auth-options': { authOptions: {} },
        './staff-identity': { staffIdentityFromSession: (s) => s ? { subject: '123' } : null },
        './staff-db.server': { getStaffPool: () => ({}), resolveStaffPrincipal: async () => ({ user_id: 'user' }) },
        './staff-workspace-context.server.js': { staffWorkspaceContext: async () => ({ status: 'ok', organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }) },
        './staff-google.server': { staffGoogleCredentialStatus: async () => google },
        './staff-mfa.server': { reserveMfaAttempt: async () => { reservations++; return retry; } },
        './staff-mfa-cookie': { STAFF_MFA_COOKIE: 'proof', STAFF_MFA_TTL_MS: 1000, createStaffMfaProof: () => 'proof' },
    };
    const exports = {};
    runInNewContext(ts.transpileModule(readFileSync(new URL('../../src/lib/staff-mfa-http.server.js', import.meta.url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText, { exports, require: (name) => { assert.ok(imports[name], name); return imports[name]; },
        process: { env: { STAFF_ORGANIZATION_ID: 'org', NEXTAUTH_SECRET: 'secret' } }, Response, URL, console });
    return { ...exports, reservations: () => reservations };
}
const request = (origin) => new Request('https://app.test/api/staff/mfa/verify', {
    method: 'POST', headers: origin ? { origin } : {},
});

test('Google session and liveness checks apply before reserving an MFA attempt', async () => {
    for (const options of [{ signedIn: false }, { google: 'revoked' }]) {
        const h = helper(options);
        assert.equal((await h.staffMfaContext(request())).denied.status, 401);
        assert.equal(h.reservations(), 0);
    }
});
test('cross-origin verification cannot mutate rate limits or credentials', async () => {
    const h = helper();
    assert.equal((await h.staffMfaContext(request('https://other.test'))).denied.status, 403);
    assert.equal(h.reservations(), 0);
});
test('persistent limiter returns a retry duration and responses are not cacheable', async () => {
    const h = helper({ retry: 123 });
    const response = (await h.staffMfaContext(request('https://app.test'))).denied;
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '123');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).retryAfter, 123);
    assert.equal(h.reservations(), 1);
});
