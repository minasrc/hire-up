import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as jsxRuntime from 'react/jsx-runtime';
import ts from 'typescript';
import { getCandidateDetail } from '../../src/lib/candidate-profile-operations.js';
import { StaffAuthorizationError } from '../../src/lib/staff-authorization.js';

const id = randomUUID();
const org = randomUUID();
const identity = { provider: 'google', issuer: 'https://accounts.google.com', subject: '1002' };
const workspace = { candidate: { candidateId: id, fullName: 'Synthetic candidate', version: '1' } };
const uploadDetails = { secondaryEmails: ['secondary@example.test'], compensationPreference: 'EUR 100k' };
const sqlError = (code, message) => Object.assign(new Error(message), { code });

function subject({ allowed = true, combinedError, profileError } = {}) {
    const queries = [], releases = [];
    let connections = 0;
    const pool = { connect: async () => {
        connections++;
        return { release: error => releases.push(error), query: async (sql, params) => {
            queries.push({ sql, params });
            if (sql.includes('resolve_staff_principal_v1')) return { rows: [{ user_id: randomUUID(), membership_id: randomUUID(), role_id: randomUUID() }] };
            if (sql.includes('has_permission_v1')) return { rows: params[0].map(() => ({ allowed })) };
            if (sql.includes('get_candidate_upload_details_v1')) {
                if (combinedError) throw combinedError;
                return { rows: [{ workspace, upload_details: uploadDetails }] };
            }
            if (sql.includes('get_candidate_profile_v1')) {
                if (profileError) throw profileError;
                return { rows: [{ result: workspace }] };
            }
            return { rows: [] };
        } };
    } };
    return { pool, queries, releases, connections: () => connections,
        read: () => getCandidateDetail(pool, identity, org, { candidateId: id }) };
}

test('candidate profile and upload details share one authorized read and connection', async () => {
    const page = subject();
    assert.deepEqual(await page.read(), { workspace, uploadDetails });
    assert.equal(page.connections(), 1);
    assert.equal(page.queries.length, 5);
    assert.deepEqual(page.queries.find(query => query.sql.includes('has_permission_v1')).params, [['candidates.read']]);
    assert.deepEqual(page.queries.find(query => query.sql.includes('get_candidate_upload_details_v1')).params, [id]);
    assert.equal(page.queries.at(-1).sql, 'commit');
    assert.equal(page.releases.length, 1);
});

test('invalid IDs and unknown fields fail before acquiring a connection', async () => {
    const page = subject();
    for (const input of [{ candidateId: 'invalid' }, { candidateId: id, extra: true }]) {
        await assert.rejects(getCandidateDetail(page.pool, identity, org, input), error => error.code === 'INVALID_INPUT');
    }
    assert.equal(page.connections(), 0);
});

test('permission denial and operation errors never bypass the shared authorization', async () => {
    const denied = subject({ allowed: false });
    await assert.rejects(denied.read(), error => error.code === 'FORBIDDEN');
    assert.ok(!denied.queries.some(query => query.sql.includes('get_candidate_profile_v1')));
    assert.equal(denied.queries.at(-1).sql, 'rollback');
    for (const code of ['42501', 'P0002', '57014']) {
        const failure = sqlError(code, 'record unavailable');
        const page = subject({ combinedError: failure });
        await assert.rejects(page.read(), error => error === failure);
        assert.equal(page.connections(), 1);
        assert.equal(page.queries.at(-1).sql, 'rollback');
    }
});

test('missing optional upload function rolls back then retries only the profile read', async () => {
    const page = subject({ combinedError: sqlError('42883', 'function app.get_candidate_upload_details_v1(uuid) does not exist') });
    assert.deepEqual(await page.read(), { workspace, uploadDetails: null });
    assert.equal(page.connections(), 2);
    assert.equal(page.queries.filter(query => query.sql === 'rollback').length, 1);
    assert.equal(page.queries.filter(query => query.sql.includes('has_permission_v1')).length, 2);
    assert.equal(page.queries.filter(query => query.sql.includes('get_candidate_upload_details_v1')).length, 1);
    assert.equal(page.queries.at(-1).sql, 'commit');
});

test('missing profile function remains visible to the page compatibility fallback', async () => {
    const failure = sqlError('42883', 'function app.get_candidate_profile_v1(uuid) does not exist');
    const page = subject({ combinedError: failure });
    await assert.rejects(page.read(), error => error === failure);
    assert.equal(page.connections(), 1);
});

test('an undefined dependency of the profile cannot be swallowed as optional upload data', async () => {
    const failure = sqlError('42883', 'function app.profile_dependency_v1() does not exist');
    const page = subject({ combinedError: failure, profileError: failure });
    await assert.rejects(page.read(), error => error === failure);
    assert.equal(page.connections(), 2);
    assert.equal(page.queries.at(-1).sql, 'rollback');
});

const compiled = ts.transpileModule(readFileSync(new URL('../../src/app/staff/candidates/[candidateId]/page.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
function pageSubject({ detailError, legacyError, optionalError, target = null } = {}) {
    const calls = [];
    const imports = {
        'react/jsx-runtime': jsxRuntime,
        'next/navigation': { notFound: () => { throw new Error('NOT_FOUND'); }, redirect: path => { throw new Error(`REDIRECT ${path}`); } },
        '@/lib/staff-gate.server': { requireStaffVerified: async () => ({ pool: {}, identity, organizationId: org }) },
        '@/lib/staff-authorization': { StaffAuthorizationError },
        '@/lib/candidate-profile-read': { resolveCandidateRedirect: async () => { calls.push('redirect'); return target; } },
        '@/lib/candidate-profile-operations': {
            getCandidateDetail: async () => { calls.push('detail'); if (detailError) throw detailError; return { workspace, uploadDetails }; },
            isMissingProfileFunctionError: error => error.code === '42883' && error.message.includes('app.get_candidate_profile_v1'),
        },
        '@/lib/pipeline-operations': { getCandidateWorkspace: async () => { calls.push('legacy'); if (legacyError) throw legacyError; return workspace; } },
        '@/lib/candidate-upload-operations': { getCandidateUploadDetails: async () => { calls.push('upload'); if (optionalError) throw optionalError; return uploadDetails; } },
        '@/components/staff-preview/shared': { PageHeader: 'PageHeader' },
        '@/components/staff-ui/card': { Card: 'Card', CardContent: 'CardContent' },
        './candidate-detail': { CandidateDetail: 'CandidateDetail' },
    };
    const exports = {};
    runInNewContext(compiled, { exports, require: name => { assert.ok(Object.hasOwn(imports, name), name); return imports[name]; } });
    return { calls, render: () => exports.default({ params: Promise.resolve({ candidateId: id }) }) };
}
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object'
    ? [...(value.type ? [value] : []), ...Object.values(value.props ?? {}).flatMap(nodes)] : [];

test('candidate detail page displays upload fields without a separate read', async () => {
    const page = pageSubject();
    const tree = await page.render();
    const detail = nodes(tree).find(node => node.type === 'CandidateDetail');
    assert.deepEqual(detail.props.workspace.candidate.secondaryEmails, uploadDetails.secondaryEmails);
    assert.equal(detail.props.profileUnavailable, false);
    assert.deepEqual(page.calls, ['detail']);
});

test('candidate detail page preserves forbidden, missing and merged-candidate behavior', async () => {
    const denied = pageSubject({ detailError: new StaffAuthorizationError('FORBIDDEN', 'denied') });
    await denied.render();
    assert.deepEqual(denied.calls, ['detail']);
    const missing = pageSubject({ detailError: sqlError('P0002', 'missing') });
    await assert.rejects(missing.render(), /NOT_FOUND/);
    const merged = pageSubject({ detailError: sqlError('P0002', 'merged'), target: id });
    await assert.rejects(merged.render(), new RegExp(`REDIRECT /staff/candidates/${id}`));
});

test('older profile deployments retain the legacy workspace and optional-upload fallback', async () => {
    const page = pageSubject({ detailError: sqlError('42883', 'app.get_candidate_profile_v1 unavailable'), optionalError: sqlError('42883', 'optional function absent') });
    const detail = nodes(await page.render()).find(node => node.type === 'CandidateDetail');
    assert.equal(detail.props.profileUnavailable, true);
    assert.deepEqual(page.calls, ['detail', 'legacy', 'upload']);
    const failure = sqlError('42501', 'upload denied');
    await assert.rejects(pageSubject({ detailError: sqlError('42883', 'app.get_candidate_profile_v1 unavailable'), optionalError: failure }).render(), error => error === failure);
});
