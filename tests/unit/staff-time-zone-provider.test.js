import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { staffTimeZone } from '../../src/lib/staff-dates.js';

const compiled = ts.transpileModule(readFileSync(
    new URL('../../src/app/staff/time-zone-provider.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const exports = {};
runInNewContext(compiled, {
    exports,
    require: name => {
        if (name === 'react') return React;
        if (name === 'react/jsx-runtime') return jsxRuntime;
        if (name === '@/lib/staff-dates') return { staffTimeZone };
        assert.fail(name);
    },
});

function Consumer() {
    const value = exports.useStaffTimeZone();
    return jsxRuntime.jsx('span', {
        'data-account': value.accountId,
        'data-saved': String(value.savedTimeZone),
        'data-zone': value.timeZone,
        'data-version': value.version,
    });
}

const render = props => renderToStaticMarkup(jsxRuntime.jsx(
    exports.StaffTimeZoneProvider,
    { ...props, children: jsxRuntime.jsx(Consumer, {}) },
));

test('provider exposes the authoritative account preference during SSR', () => {
    const madrid = render({ accountId: 'account-a', savedTimeZone: 'Europe/Madrid', version: '3' });
    assert.match(madrid, /data-account="account-a"/);
    assert.match(madrid, /data-saved="Europe\/Madrid"/);
    assert.match(madrid, /data-zone="Europe\/Madrid"/);
    assert.match(madrid, /data-version="3"/);

    const fallback = render({ accountId: 'account-b', savedTimeZone: null, version: '0' });
    assert.match(fallback, /data-account="account-b"/);
    assert.match(fallback, /data-saved="null"/);
    assert.match(fallback, /data-zone="UTC"/);
    assert.match(fallback, /data-version="0"/);
});
