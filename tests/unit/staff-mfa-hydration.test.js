import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const compiled = ts.transpileModule(readFileSync(new URL('../../src/app/staff/mfa/mfa-forms.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

test('server-rendered MFA code fields wait for interactive handlers before accepting input', () => {
    const exports = {};
    const imports = {
        react: React,
        'react/jsx-runtime': jsxRuntime,
        '@/lib/staff-workspace-fetch': { staffWorkspaceFetch: () => assert.fail('Server rendering must not verify a code') },
    };
    runInNewContext(compiled, { exports, require: name => { assert.ok(imports[name], name); return imports[name]; } });
    const html = renderToStaticMarkup(jsxRuntime.jsx(exports.MfaVerifyForm, {}));
    assert.match(html, /<input[^>]*id="authenticator-code"[^>]*disabled/);
    assert.match(html, /<button[^>]*type="submit"[^>]*disabled/);
    assert.match(html, /Authenticator code/);
});
