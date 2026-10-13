import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { workspaceNavigationUrl } from '../../src/app/staff/workspace-navigation-model.js';

function load(path, modules) {
    const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    const exports = {};
    runInNewContext(source, {
        exports, URLSearchParams,
        require: name => { assert.ok(modules[name], name); return modules[name]; },
    });
    return exports;
}
const base = { react: React, 'react/jsx-runtime': jsxRuntime };
const boundary = load('../../src/app/staff/workspace-boundary.tsx', {
    ...base,
    '@/components/staff-ui/button': { Button: () => null },
    './workspace-navigation-model': { workspaceNavigationUrl },
    '@/lib/staff-workspace-fetch': { WORKSPACE_CHANGED_EVENT: 'staff-workspace-changed' },
});
const { StaffDocumentLink } = load('../../src/components/staff-ui/staff-document-link.tsx', {
    ...base, '@/app/staff/workspace-boundary': boundary,
});
const documentId = '10000000-0000-4000-8000-000000000001';
const organizationId = '20000000-0000-4000-8000-000000000002';
function render(multiWorkspace, link = {}, scope = organizationId) {
    return renderToStaticMarkup(jsxRuntime.jsx(boundary.WorkspaceBoundary, {
        multiWorkspace, organizationId: scope,
        children: jsxRuntime.jsx(StaffDocumentLink, { documentId, ...link, children: 'Open CV' }),
    }));
}

test('server-rendered document href binds the original workspace without DOM or hydration', () => {
    assert.match(render(true), new RegExp(`href="/api/staff/documents/${documentId}\\?_workspace=${organizationId}"`));
    assert.match(render(true, { view: 'inline' }), new RegExp(`view=inline&amp;_workspace=${organizationId}`));
});
test('legacy and unscoped contexts do not invent document expectations', () => {
    assert.match(render(false), new RegExp(`href="/api/staff/documents/${documentId}"`));
    assert.doesNotMatch(render(false, { view: 'inline' }), /_workspace/);
    assert.doesNotMatch(render(true, {}, null), /_workspace/);
});
test('scoped document anchors preserve native download/new-tab and accessibility attributes', () => {
    const html = render(true, { target: '_blank', rel: 'noreferrer', download: 'CV.pdf', className: 'document-link', 'aria-label': 'Download CV' });
    assert.match(html, /target="_blank"/);
    assert.match(html, /rel="noreferrer"/);
    assert.match(html, /download="CV.pdf"/);
    assert.match(html, /class="document-link"/);
    assert.match(html, /aria-label="Download CV"/);
    assert.match(html, />Open CV<\/a>/);
});
