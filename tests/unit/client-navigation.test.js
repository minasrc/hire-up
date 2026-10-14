import { profileLinksImports } from '../support/ui-port-fixtures.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { SOCIAL_PLATFORM_NAMES } from '../../src/lib/client-job-contracts.js';
import { StaffAuthorizationError } from '../../src/lib/staff-authorization.js';

const { jsx, jsxs, Fragment } = jsxRuntime;
const activeClient = {
    id: randomUUID(), name: 'Synthetic Client', status: 'active',
    socialLinks: [{ platform: 'linkedin', url: 'https://linkedin.com/company/synthetic' }],
    version: '1', publicProfileVersion: '1',
};
const draftClient = { id: randomUUID(), name: 'Draft Client', status: 'draft' };
const capabilities = { jobs: true, writeJobs: true, applications: true, writeClients: true };
const detailPath = 'src/app/staff/clients/[clientId]/page.tsx';
const newJobPath = 'src/app/staff/jobs/new/page.tsx';
const childrenOnly = ({ children }) => jsx(Fragment, { children });

function loadPage(path, options = {}) {
    const calls = [];
    const forms = [];
    const exports = {};
    const imports = {
        ...profileLinksImports,
        './job-form': { JobForm: 'JobForm' },
        'react/jsx-runtime': jsxRuntime,
        react: React,
        'next/link': { default: ({ children, ...props }) => jsx('a', { ...props, children }) },
        'next/navigation': { notFound: () => assert.fail('unexpected notFound') },
        'lucide-react': { ArrowLeft: () => null, Pencil: () => null, Briefcase: () => null },
        '@/lib/client-job-contracts': { SOCIAL_PLATFORM_NAMES },
        '@/lib/staff-authorization': { StaffAuthorizationError },
        '@/lib/staff-gate.server': {
            requireStaffVerified: async () => ({ pool: {}, identity: {}, organizationId: randomUUID() }),
        },
        '@/lib/workspace.server': {
            loadStaffCapabilities: async () => ({
                capabilities: options.capabilities === null ? null : {
                    ...capabilities, ...options.capabilities,
                },
            }),
        },
        '@/lib/client-job-operations': {
            listClients: async (...args) => {
                calls.push(['list', args[3]]);
                if (options.listError) throw options.listError;
                return options.clients ?? [activeClient, draftClient];
            },
            getClient: async (...args) => {
                calls.push(['get', args[3]]);
                if (options.getError) throw options.getError;
                return options.client ?? activeClient;
            },
        },
        '@/components/staff-preview/shared': {
            PageHeader: ({ title, description, actions }) => jsxs(Fragment, {
                children: [jsx('h1', { children: title }), jsx('p', { children: description }), actions],
            }),
            StatusBadge: childrenOnly,
            FieldLabel: ({ label, children }) => jsxs('div', {
                children: [jsx('dt', { children: label }), jsx('dd', { children })],
            }),
            EmptyState: ({ title, description, action }) => jsxs('div', {
                children: [jsx('h2', { children: title }), jsx('p', { children: description }), action],
            }),
        },
        '@/components/staff-ui/button': { Button: childrenOnly },
        '@/components/staff-ui/card': Object.fromEntries(
            ['Card', 'CardContent', 'CardDescription', 'CardHeader', 'CardTitle']
                .map((name) => [name, childrenOnly]),
        ),
        '../../workspace-forms': {
            ClientForm: () => null,
            JobForm: (props) => {
                forms.push(props);
                return jsx('div', { children: 'Job form' });
            },
        },
    };
    const detailExports = {};
    runInNewContext(ts.transpileModule(
        readFileSync(new URL(
            '../../src/app/staff/clients/[clientId]/client-detail.tsx',
            import.meta.url,
        ), 'utf8'),
        { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } },
    ).outputText, {
        exports: detailExports,
        require: (name) => {
            assert.ok(Object.hasOwn(imports, name), `Unexpected dependency: ${name}`);
            return imports[name];
        },
    });
    imports['./client-detail'] = { ClientDetail: detailExports.ClientDetail };
    runInNewContext(ts.transpileModule(
        readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'),
        { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } },
    ).outputText, {
        exports,
        require: (name) => {
            assert.ok(Object.hasOwn(imports, name), `Unexpected dependency: ${name}`);
            return imports[name];
        },
    });
    return {
        calls, forms,
        render: async (query = {}) => renderToStaticMarkup(await exports.default({
            params: Promise.resolve({ clientId: activeClient.id }),
            searchParams: Promise.resolve(query),
        })),
    };
}

test('client detail renders saved social URLs and permission-gated navigation links', async () => {
    const { render } = loadPage(detailPath);
    const html = await render();
    assert.ok(html.includes(`href="/staff/jobs?client=${activeClient.id}"`));
    assert.ok(html.includes(`href="/staff/jobs/new?client=${activeClient.id}"`));
    assert.ok(html.includes(`href="/staff/applications?client=${activeClient.id}"`));
    assert.match(html, /aria-label="Company profiles"/);
    assert.match(html, /href="https:\/\/linkedin.com\/company\/synthetic" target="_blank" rel="noopener noreferrer"/);
    assert.match(html, /aria-label="LinkedIn \(opens in a new tab\)"/);
    assert.doesNotMatch(html, /configured/);
});

test('client detail hides actions without their capabilities or an active client', async () => {
    const denied = await loadPage(detailPath, {
        capabilities: { jobs: false, writeJobs: false, applications: false },
    }).render();
    for (const label of ['View jobs', 'Add job', 'View applications']) {
        assert.ok(!denied.includes(label));
    }
    for (const status of ['draft', 'archived']) {
        const html = await loadPage(detailPath, { client: { ...activeClient, status } }).render();
        assert.ok(!html.includes('Add job'));
        assert.ok(html.includes('View applications'));
    }
    const unavailable = await loadPage(detailPath, { capabilities: null }).render();
    assert.ok(!unavailable.includes('Add job'));
    assert.ok(!unavailable.includes('View applications'));
    const noLinks = await loadPage(detailPath, { client: { ...activeClient, socialLinks: [] } }).render();
    assert.ok(!noLinks.includes('Client social links'));
});

test('new job requests up to 500 clients and preselects only a known active client', async () => {
    const { render, calls, forms } = loadPage(newJobPath);
    await render({ client: activeClient.id });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'list');
    assert.equal(calls[0][1].limit, 500);
    assert.equal(forms[0].preselectedClientId, activeClient.id);
    assert.deepEqual(JSON.parse(JSON.stringify(forms[0].clients)), [
        { id: activeClient.id, name: activeClient.name },
    ]);
});

test('an active client beyond the list is loaded through the existing getClient operation', async () => {
    const extra = { ...activeClient, id: randomUUID(), name: 'Another active client' };
    const { render, calls, forms } = loadPage(newJobPath, { client: { client: extra } });
    await render({ client: extra.id });
    assert.equal(calls[1][0], 'get');
    assert.equal(calls[1][1].clientId, extra.id);
    assert.equal(forms[0].preselectedClientId, extra.id);
    assert.equal(forms[0].clients.length, 2);
    assert.equal(forms[0].clients[1].name, extra.name);
});

test('invalid, missing and repeated client query values leave selection empty without a lookup', async () => {
    for (const client of [undefined, 'not-a-uuid', [activeClient.id, draftClient.id]]) {
        const { render, calls, forms } = loadPage(newJobPath);
        await render({ client });
        assert.equal(calls.length, 1);
        assert.equal(forms[0].preselectedClientId, undefined);
    }
});

test('missing or foreign clients and inactive clients cannot be preselected', async () => {
    const missing = loadPage(newJobPath, { getError: { code: 'P0002' } });
    await missing.render({ client: randomUUID() });
    assert.equal(missing.forms[0].preselectedClientId, undefined);
    assert.equal(missing.forms[0].clients.length, 1);
    for (const status of ['draft', 'archived']) {
        const inactive = { ...draftClient, status };
        const { render, forms } = loadPage(newJobPath, { client: inactive });
        await render({ client: inactive.id });
        assert.equal(forms[0].preselectedClientId, undefined);
        assert.ok(forms[0].clients.every((client) => client.id !== inactive.id));
    }
});

test('an all-draft list explains the active-client requirement instead of showing a form', async () => {
    const { render, forms } = loadPage(newJobPath, { clients: [draftClient] });
    assert.match(await render(), /Jobs require an active client/);
    assert.equal(forms.length, 0);
});

test('job creation denial and client read errors are not bypassed by preselection', async () => {
    const denied = loadPage(newJobPath, { capabilities: { writeJobs: false } });
    assert.match(await denied.render({ client: activeClient.id }), /requires the jobs.write permission/);
    assert.equal(denied.calls.length, 0);
    assert.equal(denied.forms.length, 0);
    for (const key of ['listError', 'getError']) {
        for (const error of [
            new StaffAuthorizationError('FORBIDDEN', 'denied'),
            Object.assign(new Error('database unavailable'), { code: '08006' }),
        ]) {
            const { render } = loadPage(newJobPath, { [key]: error });
            await assert.rejects(render({ client: randomUUID() }), (caught) => caught === error);
        }
    }
});
