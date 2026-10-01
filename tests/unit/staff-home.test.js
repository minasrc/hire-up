import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const { jsx, jsxs, Fragment } = jsxRuntime;

const compile = (path) => ts.transpileModule(
    readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } },
).outputText;

const div = (props) => jsx('div', { ...props, children: props?.children });

function overviewPage({ requireStaffVerified, loadStaffWorkspace }) {
    const exports = {};
    const imports = {
        'react/jsx-runtime': jsxRuntime,
        react: { Suspense: ({ children }) => children },
        '@/components/staff-ui/card': { Card: div, CardContent: div },
        '@/components/staff-preview/shared': {
            PageHeader: (props) => jsxs(Fragment, {
                children: [
                    jsx('h1', { children: props.title }, 'h'),
                    props.description ? jsx('p', { children: props.description }, 'd') : null,
                ],
            }),
        },
        '@/lib/staff-gate.server': { requireStaffVerified },
        '@/lib/workspace.server': { loadStaffWorkspace },
        './overview-sections': {
            OverviewMetrics: ({ summary }) =>
                jsx('div', { children: `metrics:${JSON.stringify(summary.metrics)}` }),
            ReviewQueue: ({ summary }) =>
                jsx('div', {
                    children: `review:${summary.recentApplications.length}`,
                }),
            ClientsHiring: ({ summary }) =>
                jsx('div', {
                    children: `hiring:${summary.clientsHiring.length}`,
                }),
        },
        './staff-todo-list': {
            StaffTodoList: ({ writeEnabled }) =>
                jsx('div', { children: `todo:${String(writeEnabled)}` }),
        },
        './summary-retry': {
            SummaryRetry: () => jsx('button', { children: 'retry-stub' }),
        },
    };
    runInNewContext(compile('src/app/staff/page.tsx'), {
        exports,
        require: (name) => {
            assert.ok(Object.hasOwn(imports, name), `Unexpected dependency: ${name}`);
            return imports[name];
        },
    });
    return exports.default;
}

async function resolveServerTree(node) {
    if (node == null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return Promise.all(node.map(resolveServerTree));
    if (typeof node.type === 'function') return resolveServerTree(await node.type(node.props));
    return { ...node, props: { ...node.props, children: await resolveServerTree(node.props.children) } };
}

const verified = async () => ({ stage: 'verified' });

const fullSummary = (overrides = {}) => ({
    capabilities: {
        candidates: true,
        applications: true,
        clients: true,
        jobs: true,
        members: true,
        tasks: true,
        writeTasks: true,
        writeClients: true,
        writeJobs: true,
        ...overrides.capabilities,
    },
    metrics: { candidates: 4, applications: 9, openRoles: 2, ...overrides.metrics },
    attention: {
        reviewApplications: 3,
        pendingInvites: 1,
        openTasks: 2,
        ...overrides.attention,
    },
    clientsHiring: [],
    clientsHiringTotal: 0,
    recentApplications: [],
    ...overrides,
});

test('staff overview renders real workspace content for a verified member', async () => {
    const Page = overviewPage({
        requireStaffVerified: verified,
        loadStaffWorkspace: async () => ({
            gate: { stage: 'verified' },
            summary: fullSummary(),
        }),
    });
    const html = renderToStaticMarkup(await resolveServerTree(await Page()));
    assert.match(html, /Overview/);
    assert.match(html, /snapshot of your recruiting pipeline/i);
    assert.match(html, /metrics:\{&quot;candidates&quot;:4,&quot;applications&quot;:9,&quot;openRoles&quot;:2\}/);
    assert.match(html, /todo:true/);
    assert.match(html, /review:0/);
    assert.match(html, /hiring:0/);
    // Section navigation lives in the workspace shell, not the page body.
    assert.doesNotMatch(html, /<nav/);
    assert.doesNotMatch(html, /temporarily unavailable/);
});

test('staff overview shows the unavailable state when the summary fails', async () => {
    const Page = overviewPage({
        requireStaffVerified: verified,
        loadStaffWorkspace: async () => ({
            gate: { stage: 'verified' },
            summary: null,
        }),
    });
    const html = renderToStaticMarkup(await resolveServerTree(await Page()));
    assert.match(html, /Workspace summary is temporarily unavailable/);
    assert.match(html, /retry-stub/);
    assert.doesNotMatch(html, /metrics:/);
});

test('staff overview explains missing task permission instead of a blank panel', async () => {
    const Page = overviewPage({
        requireStaffVerified: verified,
        loadStaffWorkspace: async () => ({
            gate: { stage: 'verified' },
            summary: fullSummary({
                capabilities: { tasks: false, writeTasks: false },
            }),
        }),
    });
    const html = renderToStaticMarkup(await resolveServerTree(await Page()));
    assert.match(html, /collaboration\.read permission/);
    assert.doesNotMatch(html, /todo:true/);
    assert.match(html, /review:0/);
});

test('staff overview still requires the full staff and MFA gate', async () => {
    const denied = new Error('MFA required');
    const Page = overviewPage({
        requireStaffVerified: async () => { throw denied; },
        loadStaffWorkspace: async () => {
            throw new Error('loadStaffWorkspace must not run when the gate fails');
        },
    });
    await assert.rejects(Page(), (error) => error === denied);
});

test('overview returns its heading and loading boundary before summary data resolves', async () => {
    let summaryReads = 0;
    const Page = overviewPage({
        requireStaffVerified: verified,
        loadStaffWorkspace: () => { summaryReads++; return new Promise(() => {}); },
    });
    const tree = await Page();
    assert.equal(summaryReads, 0, 'summary loads inside the suspended child, not the page gate');
    const boundary = tree.props.children[1];
    assert.ok(boundary.props.fallback);
    const pending = boundary.props.children.type(boundary.props.children.props);
    assert.equal(typeof pending.then, 'function');
    assert.equal(summaryReads, 1);
});
