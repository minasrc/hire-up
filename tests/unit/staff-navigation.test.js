import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { createStaffRefresh } from '../../src/lib/staff-refresh.js';

const { jsx } = jsxRuntime;

const compiled = ts.transpileModule(
    readFileSync(new URL('../../src/app/staff/staff-shell.tsx', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } },
).outputText;

const iconProxy = new Proxy({}, {
    get: (_target, property) => (typeof property === 'string'
        ? (props) => jsx('span', { 'data-icon': property, className: props?.className })
        : undefined),
});

const inertProxy = new Proxy({}, {
    get: (_target, property) => (typeof property === 'string'
        ? (props) => jsx('div', { children: props?.children })
        : undefined),
});

function loadShell() {
    const exports = {};
    const imports = {
        react: React,
        '@/lib/staff-refresh': { createStaffRefresh },
        'react/jsx-runtime': jsxRuntime,
        'next/link': {
            default: ({ href, children, ...rest }) =>
                jsx('a', { href, ...rest, children }),
        },
        'next/navigation': { usePathname: () => '/staff' },
        'next-auth/react': { signOut: () => {} },
        'lucide-react': iconProxy,
        '@/components/staff-ui/button': inertProxy,
        '@/components/staff-ui/popover': inertProxy,
        '@/components/staff-ui/separator': inertProxy,
        '@/components/staff-ui/sheet': inertProxy,
        './record-preview': inertProxy,
        '@/lib/utils': { cn: (...parts) => parts.filter(Boolean).join(' ') },
    };
    runInNewContext(compiled, {
        exports,
        require: (name) => {
            assert.ok(Object.hasOwn(imports, name), `Unexpected dependency: ${name}`);
            return imports[name];
        },
    });
    return exports;
}

const renderAnchors = (NavLinks, capabilities, pathname = '/staff') => {
    const html = renderToStaticMarkup(
        jsx(NavLinks, { pathname, capabilities }),
    );
    return [...html.matchAll(/<a\b[^>]*>/g)].map(([tag]) => ({
        href: tag.match(/href="([^"]+)"/)?.[1],
        current: /aria-current="page"/.test(tag),
    }));
};

const ALL_HREFS = [
    '/staff',
    '/staff/applications',
    '/staff/candidates',
    '/staff/jobs',
    '/staff/clients',
    '/staff/members',
];

test('an unknown summary keeps the full navigation visible', () => {
    const { NavLinks } = loadShell();
    assert.deepEqual(
        renderAnchors(NavLinks, null).map((anchor) => anchor.href),
        ALL_HREFS,
        'a missing/unloaded summary must not collapse navigation to Overview only',
    );
});

test('a denied session drops privileged navigation', () => {
    const { NavLinks } = loadShell();
    assert.deepEqual(
        renderAnchors(NavLinks, 'denied').map((anchor) => anchor.href),
        ['/staff'],
    );
});

test('known capabilities hide only the sections they deny', () => {
    const { NavLinks } = loadShell();
    const capabilities = {
        jobs: true,
        clients: true,
        applications: false,
        candidates: false,
        members: false,
        tasks: false,
        writeTasks: false,
        writeJobs: false,
        writeClients: false,
    };
    assert.deepEqual(
        renderAnchors(NavLinks, capabilities).map((anchor) => anchor.href),
        ['/staff', '/staff/jobs', '/staff/clients'],
    );
});

test('the matching section stays active on detail pages', () => {
    const { NavLinks } = loadShell();
    const anchors = renderAnchors(NavLinks, null, '/staff/jobs/some-id');
    const jobs = anchors.find((anchor) => anchor.href === '/staff/jobs');
    const overview = anchors.find((anchor) => anchor.href === '/staff');
    assert.ok(jobs?.current, 'Jobs must carry aria-current on a job detail page');
    assert.ok(overview && !overview.current, 'Overview must not be marked active');
});
