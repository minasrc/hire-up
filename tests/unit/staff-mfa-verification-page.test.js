import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const source = ts.transpileModule(readFileSync(new URL('../../src/app/staff/mfa/verify/page.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

async function render(gate, multiWorkspace = false) {
    const exports = {};
    const modules = {
        'react/jsx-runtime': require('react/jsx-runtime'),
        'next/navigation': { redirect: (url) => { throw Object.assign(new Error('redirect'), { url }); } },
        '@/lib/staff-gate.server': { staffGate: async () => gate },
        '@/lib/staff-workspace-context.server': { multiWorkspaceEnabled: () => multiWorkspace },
        '../mfa-forms': { MfaVerifyForm: () => null },
    };
    vm.runInNewContext(source, { exports, require: (name) => { assert.ok(modules[name], name); return modules[name]; } });
    return exports.default();
}

test('verified sessions leave the verification form on revisits and reloads', async () => {
    await assert.rejects(render({ stage: 'verified', totp: { status: 'active' } }), { url: '/staff' });
});

test('pending MFA still renders a verification form', async () => {
    assert.ok(await render({ stage: 'mfa-pending', totp: { status: 'active' } }));
});

for (const [stage, destination] of [
    ['signed-out', '/staff/sign-in'], ['reauthenticate', '/staff/sign-in'],
    ['unresolved', '/staff/no-access'], ['unavailable', '/staff/unavailable'],
    ['resolved', '/staff/mfa/enroll'],
]) {
    test(`${stage} sessions retain their access recovery redirect`, async () => {
        await assert.rejects(render({ stage }), { url: destination });
    });
}

test('pending verification identifies its workspace and offers a full navigation escape', async () => {
    const html = renderToStaticMarkup(await render({ stage: 'mfa-pending', totp: { status: 'active' }, principal: { workspace_name: 'Independent workspace' } }, true));
    assert.match(html, /Independent workspace/);
    assert.match(html, /href="\/staff\/workspaces"/);
    assert.match(html, /Choose another workspace/);
});
