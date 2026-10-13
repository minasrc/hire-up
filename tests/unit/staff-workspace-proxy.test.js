import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const id = '11111111-1111-4111-8111-111111111111';
const source = ts.transpileModule(readFileSync(new URL('../../src/proxy.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;

test('page routing expectation is derived from the URL; spoofed headers and ambiguous scopes never bypass the page gate', () => {
    const exports = {};
    const environment = { STAFF_MULTI_WORKSPACE_ENABLED: '1' };
    runInNewContext(source, { exports, Headers, process: { env: environment },
        require: () => ({ NextResponse: { next: result => result } }) });
    const run = query => exports.proxy({ headers: new Headers({ 'x-staff-page-workspace-id': 'spoofed', 'accept-language': 'en' }), nextUrl: new URL(`https://app.test/staff/jobs${query}`) }).request.headers;
    assert.equal(run('').has('x-staff-page-workspace-id'), false);
    assert.equal(run(`?_workspace=${id}`).get('x-staff-page-workspace-id'), id);
    assert.equal(run(`?_workspace=${id}&_workspace=${id}`).get('x-staff-page-workspace-id'), 'invalid');
    assert.equal(run('?_workspace=arbitrary').get('x-staff-page-workspace-id'), 'invalid');
    assert.equal(run(`?_workspace=${id}`).get('accept-language'), 'en');
    environment.STAFF_MULTI_WORKSPACE_ENABLED = '0';
    assert.equal(run(`?_workspace=${id}`).has('x-staff-page-workspace-id'), false);
    assert.equal(exports.config.matcher, '/staff/:path*');
});
