import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const { jsx } = jsxRuntime;

const compiled = ts.transpileModule(
    readFileSync(new URL('../../src/app/staff/layout.tsx', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } },
).outputText;

function staffLayout(loadStaffCapabilities) {
    const exports = {};
    const imports = {
        'react/jsx-runtime': jsxRuntime,
        react: { Suspense: ({ children }) => children },
        './staff-shell-summary': { StaffShellSummarySeed: () => null },
        '@/lib/workspace.server': { loadStaffCapabilities, loadStaffWorkspace: () => {
            assert.fail('layout must not block on workspace metrics');
        } },
        './staff-shell': {
            StaffShell: (props) => jsx('div', {
                'data-shell': 'true',
                'data-capabilities': props.initialCapabilities ? 'present' : 'absent',
                'data-stream': Boolean(props.summaryContent),
                'data-user': props.userEmail,
                children: props.children,
            }),
        },
    };
    runInNewContext(compiled, {
        exports,
        require: (name) => {
            assert.ok(Object.hasOwn(imports, name), `Unexpected dependency: ${name}`);
            return imports[name];
        },
    });
    return exports.default;
}

test('unverified stages render bare children inside the staff scope', async () => {
    const Layout = staffLayout(async () => ({
        gate: { stage: 'sign_in' },
        capabilities: null,
    }));
    const html = renderToStaticMarkup(
        await Layout({ children: jsx('p', { children: 'sign-in-here' }) }),
    );
    assert.match(html, /sign-in-here/);
    assert.match(html, /staff-scope/);
    assert.doesNotMatch(html, /data-shell/);
});

test('verified members get the shell with the lightweight capabilities', async () => {
    const Layout = staffLayout(async () => ({
        gate: {
            stage: 'verified',
            session: { user: { email: 'staff@example.test' } },
        },
        capabilities: { candidates: true },
    }));
    const html = renderToStaticMarkup(
        await Layout({ children: jsx('p', { children: 'page-body' }) }),
    );
    assert.match(html, /data-shell="true"/);
    assert.match(html, /data-capabilities="present"/);
    assert.match(html, /data-stream="true"/);
    assert.match(html, /data-user="staff@example\.test"/);
    assert.match(html, /page-body/);
});

test('a capability outage still renders the shell so pages stay usable', async () => {
    const Layout = staffLayout(async () => ({
        gate: {
            stage: 'verified',
            session: { user: { email: 'staff@example.test' } },
        },
        capabilities: null,
    }));
    const html = renderToStaticMarkup(
        await Layout({ children: jsx('p', { children: 'page-body' }) }),
    );
    assert.match(html, /data-shell="true"/);
    assert.match(html, /data-capabilities="absent"/);
});
