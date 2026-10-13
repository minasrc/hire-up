import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as jsxRuntime from 'react/jsx-runtime';
import ts from 'typescript';

const id = '97000000-0000-4000-8000-000000000001';
const base = {
    candidate: { candidateId: id, fullName: 'Before', version: '1', professionalSummary: null, lifecycle: 'active', ownerName: null, createdAt: '2026-10-11T00:00:00Z', email: 'first@example.test', secondaryEmails: ['second@example.test'] },
    identifiers: [], applications: [], stages: [], documents: [], notes: [],
    capabilities: { writeCandidates: true }, profileOptions: { canWrite: true, owners: [] },
};
const snapshot = (name, version) => ({ candidate: { ...base.candidate, fullName: name, version, email: 'second@example.test' }, identifiers: [{ kind: 'email', value: 'second@example.test', verification: 'unverified' }] });
const code = ts.transpileModule(readFileSync(new URL('../../src/app/staff/candidates/[candidateId]/candidate-detail.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object'
    ? [...(value.type ? [value] : []), ...Object.values(value.props ?? {}).flatMap(nodes)] : [];
function subject() {
    const state = [];
    let cursor = 0, refreshes = 0, workspace = base;
    const exports = {};
    runInNewContext(code, { exports, require: name => {
        if (name === 'react/jsx-runtime') return jsxRuntime;
        if (name === 'react') return { useState: initial => {
            const index = cursor++;
            if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
            return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
        } };
        if (name === 'next/navigation') return { useRouter: () => ({ refresh: () => { refreshes++; } }), useSearchParams: () => new URLSearchParams(), usePathname: () => `/staff/candidates/${id}` };
        if (name === '@/lib/staff-workspace-fetch') return { staffWorkspaceUrl: href => href, refreshStaffWorkspace: router => router.refresh() };
        if (name === '@/lib/utils') return { cn: (...values) => values.join(' ') };
        return new Proxy({}, { get: (_, property) => String(property) });
    } });
    const render = () => { cursor = 0; return nodes(exports.CandidateDetail({ workspace })); };
    const edit = () => render().find(node => node.type === 'EditCandidateProfileButton');
    return { render, edit, refreshes: () => refreshes, seed: value => { workspace = value; }, save: profile => edit().props.onSaved(profile?.candidate.candidateId ?? id, profile) };
}
test('acknowledged candidate fields and version appear together without refreshing the page', () => {
    const page = subject();
    assert.equal(page.edit().props.version, '1');
    page.save(snapshot('After', '2'));
    assert.equal(page.edit().props.candidate.fullName, 'After');
    assert.equal(page.edit().props.version, '2');
    assert.equal(page.refreshes(), 0);
    assert.ok(page.render().some(node => node.props.children === 'Profile updated.'));
    assert.ok(!JSON.stringify(page.render()).includes('· Secondary emails:'));
});
test('older streamed props and responses cannot overwrite newer saved fields', () => {
    const page = subject();
    page.save(snapshot('Newest', '4'));
    page.save(snapshot('Old response', '2'));
    page.seed({ ...base, candidate: { ...base.candidate, fullName: 'Old stream', version: '3' } });
    assert.equal(page.edit().props.candidate.fullName, 'Newest');
    assert.equal(page.edit().props.version, '4');
    page.seed({ ...base, candidate: { ...base.candidate, fullName: 'External update', version: '5' } });
    assert.equal(page.edit().props.candidate.fullName, 'External update');
    assert.equal(page.edit().props.version, '5');
});
test('cleared contact fields stay empty even when historical identifiers remain', () => {
    const page = subject();
    const cleared = snapshot('After', '2');
    cleared.candidate.email = null;
    cleared.candidate.professionalUrl = null;
    cleared.identifiers = [{ kind: 'email', value: 'old@example.test', verification: 'unverified' }];
    page.save(cleared);
    assert.equal(page.edit().props.candidate.email, null);
    assert.equal(page.edit().props.candidate.professionalUrl, null);
    assert.ok(!page.render().some(node => node.props['data-testid'] === 'candidate-primary-email'));
});
test('candidate navigation does not reuse a prior record or acknowledgement', () => {
    const page = subject();
    page.save(snapshot('After', '2'));
    page.seed({ ...base, candidate: { ...base.candidate, candidateId: '97000000-0000-4000-8000-000000000002', fullName: 'Another' } });
    assert.equal(page.edit().props.candidate.fullName, 'Another');
    assert.ok(!page.render().some(node => node.props.children === 'Profile updated.'));
    page.save(snapshot('Late prior record', '3'));
    assert.equal(page.edit().props.candidate.fullName, 'Another');
});
test('a metadata-only or invalid-version acknowledgement requests one server refresh', () => {
    for (const profile of [undefined, snapshot('Invalid', 'bad')]) {
        const page = subject();
        page.save(profile);
        assert.equal(page.refreshes(), 1);
        assert.equal(page.edit().props.version, '1');
    }
});
