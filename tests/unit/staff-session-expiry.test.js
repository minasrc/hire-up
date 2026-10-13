import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { encode, getToken } from 'next-auth/jwt';

const secret = 'synthetic-workspace-expiry-secret';
const source = ts.transpileModule(readFileSync(new URL('../../src/lib/staff-google.server.js', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;

async function expiry(token, signedSecret = secret) {
    const exports = {};
    const imports = { 'server-only': {}, 'next-auth/jwt': { getToken },
        'next/headers': { cookies: async () => ({ getAll: () => [{ name: 'next-auth.session-token', value: token }] }) },
        './staff-google-check': {}, './staff-google-cache': { createGoogleCredentialCache: () => () => 'active' } };
    runInNewContext(source, { exports, require: name => imports[name], process: { env: { NEXTAUTH_SECRET: signedSecret } } });
    return exports.staffSessionExpiresAt('123456');
}

test('workspace selection expiry comes from a verified account-bound JWT even when the server session omits expires', async () => {
    const token = await encode({ secret, maxAge: 3600, token: { provider: 'google', providerAccountId: '123456', googleRefreshToken: 'synthetic-private-refresh' } });
    const result = await expiry(token);
    assert.equal(typeof result, 'number');
    assert.ok(result > Date.now() && result <= Date.now() + 3600000);
    assert.equal(await expiry(token, 'wrong-key'), null);
    for (const claims of [{ provider: 'github', providerAccountId: '123456' }, { provider: 'google', providerAccountId: '9999' }]) {
        assert.equal(await expiry(await encode({ secret, maxAge: 3600, token: claims })), null);
    }
    assert.equal(await expiry(await encode({ secret, maxAge: -1, token: { provider: 'google', providerAccountId: '123456' } })), null);
});
