import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as jsxRuntime from 'react/jsx-runtime';
import ts from 'typescript';

const id = '97000000-0000-4000-8000-000000000001';
const all = { candidates: true, applications: true, clients: true, jobs: true, members: true, tasks: true, writeTasks: true, writeClients: true, writeJobs: true };
const paths = ['jobs/new', 'jobs/[jobId]', 'jobs/[jobId]/edit', 'clients/new', 'clients/[clientId]'];
const compiled = new Map(paths.map(path => [path, ts.transpileModule(readFileSync(new URL(`../../src/app/staff/${path}/page.tsx`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText]));
class StaffAuthorizationError extends Error {}
function subject(path, capabilities, { emptyClients = false } = {}) {
    const calls = [];
    const client = { id, name: 'Synthetic client', status: 'active' };
    const workspace = { job: { id, clientId: id, title: 'Synthetic job', version: '1', publicationState: 'draft' }, draft: { id, title: 'Synthetic draft', version: '1', revisionNumber: 1 } };
    const forms = Object.fromEntries(['ClientForm', 'JobForm', 'JobListingToggle', 'NewRevisionButton', 'PublishButton'].map(name => [name, name]));
    const imports = {
        'react/jsx-runtime': jsxRuntime,
        'next/link': { default: 'Link' },
        'next/navigation': { notFound: () => { throw new Error('notFound'); }, redirect: () => { throw new Error('redirect'); } },
        'lucide-react': { ArrowLeft: 'ArrowLeft', Briefcase: 'Briefcase' },
        '@/lib/client-job-operations': { getClient: async () => ({ client }), getJobWorkspace: async () => workspace, previewJobPublic: async () => ({ projection: {}, clientVersion: '1', reviewHash: 'synthetic' }), listClients: async () => { calls.push('clients'); return emptyClients ? [] : [client]; } },
        '@/lib/client-job-contracts': { SOCIAL_PLATFORM_NAMES: {} },
        '@/lib/staff-authorization': { StaffAuthorizationError },
        '@/lib/staff-gate.server': { requireStaffVerified: async () => ({ pool: {}, identity: {}, organizationId: 'org' }) },
        '@/lib/workspace.server': { loadStaffCapabilities: async () => { calls.push('capabilities'); return { capabilities }; }, loadStaffWorkspace: async () => { calls.push('summary'); throw new Error('summary unavailable'); } },
        '@/components/staff-preview/shared': Object.fromEntries(['EmptyState', 'PageHeader', 'FieldLabel', 'StatusBadge', 'TagPill'].map(name => [name, name])),
        '@/components/staff-preview/job-document': { JobDocumentView: 'JobDocumentView' },
        '@/lib/job-display': { jobStatusLabel: () => 'Draft' },
        '@/components/staff-ui/button': { Button: 'Button' },
        '@/components/staff-ui/card': Object.fromEntries(['Card', 'CardContent', 'CardDescription', 'CardHeader', 'CardTitle'].map(name => [name, name])),
        '../../workspace-forms': forms, '../../../workspace-forms': forms,
    };
    const exports = {};
    runInNewContext(compiled.get(path), { exports, require: name => { assert.ok(Object.hasOwn(imports, name), name); return imports[name]; } });
    return { calls, render: () => exports.default({ params: Promise.resolve({ jobId: id, clientId: id }), searchParams: Promise.resolve({}) }) };
}
function elements(node) {
    if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node)) return node.flatMap(elements);
    return [...(node.type ? [node] : []), ...Object.values(node.props ?? {}).flatMap(elements)];
}
for (const path of paths) {
    test(`${path} renders controls without any dashboard read`, async () => {
        const page = subject(path, all);
        const nodes = elements(await page.render());
        assert.equal(page.calls.filter(call => call === 'capabilities').length, 1);
        assert.ok(!page.calls.includes('summary'));
        assert.ok(nodes.some(node => node.type === (path.startsWith('clients') ? 'ClientForm' : path === 'jobs/[jobId]' ? 'PublishButton' : 'JobForm')));
    });
    for (const capabilities of [null, Object.fromEntries(Object.keys(all).map(key => [key, false]))]) {
        test(`${path} fails closed for ${capabilities === null ? 'unavailable' : 'denied'} capabilities`, async () => {
            const page = subject(path, capabilities);
            const tree = await page.render();
            const nodes = elements(tree);
            assert.ok(!nodes.some(node => ['ClientForm', 'JobForm', 'JobListingToggle', 'NewRevisionButton', 'PublishButton'].includes(node.type)));
            assert.ok(!nodes.some(node => ['/staff/clients/new', `/staff/jobs/new?client=${id}`, `/staff/jobs?client=${id}`, `/staff/applications?client=${id}`, `/staff/jobs/${id}/edit`].includes(node.props.href)));
            assert.ok(!page.calls.includes('summary'));
            assert.ok(!page.calls.includes('clients'));
            if (capabilities === null && path !== 'jobs/[jobId]') assert.match(JSON.stringify(tree), /temporarily unavailable/);
            if (capabilities !== null) assert.match(JSON.stringify(tree), /requires the .*write permission/);
        });
    }
}
test('empty job client picker offers client creation only with client-write capability', async () => {
    for (const writeClients of [true, false]) {
        const page = subject('jobs/new', { ...all, writeClients }, { emptyClients: true });
        const nodes = elements(await page.render());
        assert.equal(nodes.some(node => node.props.href === '/staff/clients/new'), writeClients);
    }
});
