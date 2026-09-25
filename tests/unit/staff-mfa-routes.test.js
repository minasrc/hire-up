import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as mfaCookie from '../../src/lib/staff-mfa-cookie.js';

const identity = { subject: '1001', provider: 'google', issuer: 'https://accounts.google.com' };
const binding = { subject: identity.subject, userId: 'test-user', credentialId: 'test-credential' };
const signingSecret = 'synthetic-route-test-secret';

function routeFixture(mode, { validCode = true } = {}) {
    const writes = [];
    const verifiedCredentials = [];
    const source = readFileSync(new URL(`../../src/app/api/staff/mfa/${mode}/route.ts`, import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const imports = {
        'next/headers': { cookies: async () => ({ set: (...args) => writes.push(args) }) },
        'next-auth': { getServerSession: async () => ({ user: { email: 'staff@example.test' } }) },
        '@/lib/auth-options': { authOptions: {} },
        '@/lib/staff-identity': { staffIdentityFromSession: () => identity },
        '@/lib/staff-db.server': {
            getStaffPool: () => ({}),
            resolveStaffPrincipal: async () => ({ user_id: binding.userId }),
        },
        '@/lib/staff-mfa.server': {
            getTotpStatus: async () => ({
                status: mode === 'enroll' ? 'pending' : 'active',
                credentialId: binding.credentialId,
                secret: 'SYNTHETIC-TOTP-SECRET',
                lastUsedCounter: 9,
            }),
            verifyTotpCode: () => validCode ? 10 : null,
            confirmTotpEnrollment: async (...args) => verifiedCredentials.push(args[3]),
            recordTotpUse: async (...args) => verifiedCredentials.push(args[3]),
        },
        '@/lib/staff-mfa-cookie': mfaCookie,
    };
    const exports = {};
    runInNewContext(compiled, {
        exports,
        Response,
        process: { env: { NODE_ENV: 'production', STAFF_ORGANIZATION_ID: 'test-org', NEXTAUTH_SECRET: signingSecret } },
        require: (name) => {
            assert.ok(Object.hasOwn(imports, name), `Unexpected dependency: ${name}`);
            return imports[name];
        },
    });
    const submit = () => exports.POST(new Request(`https://example.test/api/staff/mfa/${mode}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: '123456' }),
    }));
    return { submit, writes, verifiedCredentials };
}

for (const mode of ['enroll', 'verify']) {
    test(`MFA ${mode} issues a protected cookie covering staff pages and APIs`, async () => {
        const fixture = routeFixture(mode);
        assert.equal((await fixture.submit()).status, 200);
        assert.deepEqual(fixture.verifiedCredentials, [binding.credentialId]);
        assert.equal(fixture.writes.length, 1);
        const [name, proof, options] = fixture.writes[0];
        assert.equal(name, mfaCookie.STAFF_MFA_COOKIE);
        assert.equal(options.path, '/');
        assert.equal(options.httpOnly, true);
        assert.equal(options.secure, true);
        assert.equal(options.sameSite, 'lax');
        assert.equal(options.maxAge, mfaCookie.STAFF_MFA_TTL_MS / 1000);
        assert.ok(mfaCookie.readStaffMfaProof(signingSecret, proof, binding));
    });

    test(`MFA ${mode} never sets a cookie for an invalid code`, async () => {
        const fixture = routeFixture(mode, { validCode: false });
        assert.equal((await fixture.submit()).status, 401);
        assert.equal(fixture.writes.length, 0);
        assert.equal(fixture.verifiedCredentials.length, 0);
    });
}
