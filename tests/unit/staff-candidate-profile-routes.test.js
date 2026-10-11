import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

import { ClientJobContractError } from '../../src/lib/client-job-contracts.js';
import { StaffAuthorizationError } from '../../src/lib/staff-authorization.js';
import {
    installRouteMocks,
    setRouteStub,
    stubModule,
} from '../support/staff-route-mocks.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const realProfileOperations = pathToFileURL(
    join(repoRoot, 'src/lib/candidate-profile-operations.js')).href;

const stubs = new Map();
setRouteStub((specifier, name, args) => {
    const handler = stubs.get(`${specifier}:${name}`);
    if (!handler) {
        throw new Error(`unstubbed route dependency ${specifier}:${name}`);
    }
    return handler(...args);
});

installRouteMocks();

stubModule('@/lib/staff-api.server', {
    staffApiContext: 'fn',
    staffGateResponse: 'fn',
    staffErrorResponse: 'fn',
});
stubModule('@/lib/pipeline-operations', { addCandidateNote: 'fn' });
stubModule('@/lib/candidate-profile-operations', {
    getCandidateProfile: 'fn',
    saveCandidateProfileWithSnapshot: 'fn',
    isMissingProfileFunctionError: { reexport: realProfileOperations },
});

const candidatesRoute = await import('../../src/app/api/staff/candidates/route.ts');
const candidateRoute = await import(
    '../../src/app/api/staff/candidates/[candidateId]/route.ts');

const ORG_ID = '11111111-2222-3333-4444-555555555555';
const OP_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const CANDIDATE_ID = 'bbbbbbbb-2222-3333-4444-555555555555';

const IDENTITY = {
    provider: 'google',
    issuer: 'https://accounts.google.com',
    subject: '123456789',
};

const PG_ERROR_CODES = {
    '22023': 400, '23505': 409, '23514': 422, '40001': 409,
    '42501': 403, P0002: 404,
};

let context;
let calls;

const installBaseStubs = () => {
    stubs.clear();
    calls = { operations: [] };
    context = {
        status: 'ok',
        pool: { connect: async () => { throw new Error('no db in unit tests'); } },
        identity: IDENTITY,
        organizationId: ORG_ID,
    };
    stubs.set('@/lib/staff-api.server:staffApiContext', async () => context);
    stubs.set('@/lib/staff-api.server:staffGateResponse', (ctx) => {
        if (ctx.status === 'ok') return null;
        if (ctx.status === 'unconfigured') {
            return Response.json(
                { error: 'staff workspace not configured' }, { status: 503 });
        }
        if (ctx.status === 'mfa-required') {
            return Response.json({ error: 'mfa required' }, { status: 428 });
        }
        return Response.json({ error: 'unauthorized' }, { status: 401 });
    });
    stubs.set('@/lib/staff-api.server:staffErrorResponse', (error) => {
        if (error instanceof ClientJobContractError) {
            return Response.json(
                { error: 'invalid input', fields: error.fieldErrors },
                { status: 400 });
        }
        if (error instanceof StaffAuthorizationError) {
            const status = error.code === 'FORBIDDEN' ? 403 : 401;
            return Response.json(
                { error: error.code.toLowerCase() }, { status });
        }
        if (typeof error?.code === 'string' && error.code in PG_ERROR_CODES) {
            return Response.json(
                { error: 'operation rejected', code: error.code },
                { status: PG_ERROR_CODES[error.code] });
        }
        throw error;
    });
    stubs.set('@/lib/candidate-profile-operations:saveCandidateProfileWithSnapshot',
        async (pool, identity, org, input) => {
            calls.operations.push(['saveCandidateProfileWithSnapshot', input]);
            return {
                status: input.expectedVersion === null ? 'created' : 'updated',
                candidateId: input.candidateId,
                version: '1',
            };
        });
    stubs.set('@/lib/candidate-profile-operations:getCandidateProfile',
        async (pool, identity, org, input) => {
            calls.operations.push(['getCandidateProfile', input]);
            return { candidate: { candidateId: input.candidateId } };
        });
    stubs.set('@/lib/pipeline-operations:addCandidateNote',
        async () => ({ noteId: 'note-1' }));
};

const jsonPost = (body) => new Request(
    'http://localhost/api/staff/candidates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });

const jsonPatch = (candidateId, body) => new Request(
    `http://localhost/api/staff/candidates/${candidateId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });

const params = (candidateId) => ({ params: Promise.resolve({ candidateId }) });

const createBody = (overrides = {}) => ({
    action: 'createCandidate',
    fields: { fullName: 'Grace Hopper' },
    operationId: OP_ID,
    ...overrides,
});

test.beforeEach(installBaseStubs);

test('missing Google session denies the write before any operation', async () => {
    context = { status: 'unauthorized' };
    const response = await candidatesRoute.POST(jsonPost(createBody()));
    assert.equal(response.status, 401);
    assert.equal(calls.operations.length, 0);
    const patch = await candidateRoute.PATCH(
        jsonPatch(CANDIDATE_ID, {
            fields: { fullName: 'x' },
            expectedVersion: '1',
            operationId: OP_ID,
        }), params(CANDIDATE_ID));
    assert.equal(patch.status, 401);
    assert.equal(calls.operations.length, 0);
});

test('missing MFA denies the write before any operation', async () => {
    context = { status: 'mfa-required' };
    const response = await candidatesRoute.POST(jsonPost(createBody()));
    assert.equal(response.status, 428);
    assert.equal(calls.operations.length, 0);
});

test('legacy creation cannot bypass required CV upload, even with complete profile fields', async () => {
    for (const extra of [{}, { cvFile: 'fake.pdf' }, { fields: { fullName: 'Grace Hopper', email: 'grace@example.test' } }, { jobId: CANDIDATE_ID }]) {
        const response = await candidatesRoute.POST(jsonPost(createBody(extra)));
        assert.equal(response.status, 400);
        assert.equal(response.headers.get('cache-control'), 'private, no-store');
        const body = await response.json();
        assert.equal(body.code, 'CANDIDATE_UPLOAD_REQUIRED');
        assert.match(body.error, /\/api\/staff\/candidates\/upload/);
    }
    assert.equal(calls.operations.length, 0);
});

test('a stale edit returns 409 without discarding fields', async () => {
    const fields = {
        fullName: 'Grace Hopper',
        email: 'grace@example.test',
        headline: 'Admiral',
        location: 'Arlington',
        professionalUrl: 'https://example.test/grace',
        ownerMembershipId: null,
        professionalSummary: 'COBOL.',
    };
    stubs.set('@/lib/candidate-profile-operations:saveCandidateProfileWithSnapshot',
        async (pool, identity, org, input) => {
            calls.operations.push(['saveCandidateProfileWithSnapshot', input]);
            throw Object.assign(
                new Error('Candidate changed; reload before saving'),
                { code: '40001' });
        });
    const response = await candidateRoute.PATCH(
        jsonPatch(CANDIDATE_ID, {
            fields,
            expectedVersion: '4',
            operationId: OP_ID,
        }), params(CANDIDATE_ID));
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.code, '40001');
    const [call] = calls.operations;
    assert.equal(call[1].candidateId, CANDIDATE_ID);
    assert.equal(call[1].expectedVersion, '4');
    assert.deepEqual(call[1].fields, fields,
        'the route forwards the full field set to the operation');
});

test('PATCH rejects malformed JSON before any operation', async () => {
    for (const body of ['{not json', '[1,2]', '"text"']) {
        const response = await candidateRoute.PATCH(
            new Request(
                `http://localhost/api/staff/candidates/${CANDIDATE_ID}`, {
                    method: 'PATCH',
                    headers: { 'content-type': 'application/json' },
                    body,
                }),
            params(CANDIDATE_ID));
        assert.equal(response.status, 400, JSON.stringify(body));
    }
    assert.equal(calls.operations.length, 0);
});

test('PATCH returns the acknowledged profile snapshot without another authorized operation', async () => {
    const profile = { candidate: { candidateId: CANDIDATE_ID, fullName: 'Canonical Name', version: '5' }, identifiers: [] };
    stubs.set('@/lib/candidate-profile-operations:saveCandidateProfileWithSnapshot', async (_pool, _identity, _org, input) => {
        calls.operations.push(['saveCandidateProfileWithSnapshot', input]);
        return { candidateId: CANDIDATE_ID, status: 'updated', version: '5', profile };
    });
    const response = await candidateRoute.PATCH(jsonPatch(CANDIDATE_ID, {
        fields: { fullName: 'Canonical Name' }, expectedVersion: '4', operationId: OP_ID,
    }), params(CANDIDATE_ID));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual((await response.json()).result.profile, profile);
    assert.equal(calls.operations.length, 1);
});

test('PATCH requires a string expectedVersion', async () => {
    for (const expectedVersion of [undefined, null, 4]) {
        const response = await candidateRoute.PATCH(
            jsonPatch(CANDIDATE_ID, {
                fields: { fullName: 'Grace Hopper' },
                expectedVersion,
                operationId: OP_ID,
            }), params(CANDIDATE_ID));
        assert.equal(response.status, 400,
            `expectedVersion ${JSON.stringify(expectedVersion)} must be rejected`);
    }
    assert.equal(calls.operations.length, 0);
});

test('a replayed PATCH operation id returns the stored result', async () => {
    stubs.set('@/lib/candidate-profile-operations:saveCandidateProfileWithSnapshot',
        async (pool, identity, org, input) => {
            calls.operations.push(['saveCandidateProfileWithSnapshot', input]);
            return {
                status: 'updated', candidateId: input.candidateId,
                version: '1', replayed: true,
            };
        });
    const edit = () => candidateRoute.PATCH(jsonPatch(CANDIDATE_ID, { fields: { fullName: 'Grace Hopper' }, expectedVersion: '1', operationId: OP_ID }), params(CANDIDATE_ID));
    const first = await edit();
    const second = await edit();
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(calls.operations.length, 2);
    assert.equal(calls.operations[0][1].operationId, OP_ID);
    assert.equal(calls.operations[1][1].operationId, OP_ID);
});

test('capability denial returns 403 and never reaches the fallback', async () => {
    stubs.set('@/lib/candidate-profile-operations:saveCandidateProfileWithSnapshot',
        async () => {
            throw new StaffAuthorizationError(
                'FORBIDDEN', 'a required permission is not granted');
        });
    const patch = await candidateRoute.PATCH(
        jsonPatch(CANDIDATE_ID, {
            fields: { fullName: 'x' },
            expectedVersion: '1',
            operationId: OP_ID,
        }), params(CANDIDATE_ID));
    assert.equal(patch.status, 403);
});

test('a missing profile function returns 503 instead of a stack', async () => {
    stubs.set('@/lib/candidate-profile-operations:saveCandidateProfileWithSnapshot',
        async () => {
            throw Object.assign(
                new Error(
                    'function app.save_candidate_profile_v1(uuid, bigint, jsonb, uuid, uuid) does not exist'),
                { code: '42883' });
        });
    const patch = await candidateRoute.PATCH(
        jsonPatch(CANDIDATE_ID, {
            fields: { fullName: 'x' },
            expectedVersion: '1',
            operationId: OP_ID,
        }), params(CANDIDATE_ID));
    assert.equal(patch.status, 503);
});

test('unrelated missing functions do not trigger the fallback response', async () => {
    stubs.set('@/lib/candidate-profile-operations:saveCandidateProfileWithSnapshot',
        async () => {
            throw Object.assign(
                new Error('function app.list_candidates_v1(text) does not exist'),
                { code: '42883' });
        });
    await assert.rejects(
        candidateRoute.PATCH(jsonPatch(CANDIDATE_ID, { fields: { fullName: 'Grace Hopper' }, expectedVersion: '1', operationId: OP_ID }), params(CANDIDATE_ID)),
        /list_candidates_v1/,
        'an unrelated 42883 must propagate to staffErrorResponse unchanged',
    );
});

test('GET returns the profile wrapper result', async () => {
    const response = await candidateRoute.GET(
        new Request(`http://localhost/api/staff/candidates/${CANDIDATE_ID}`),
        params(CANDIDATE_ID));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.result.candidate.candidateId, CANDIDATE_ID);
    assert.equal(calls.operations[0][0], 'getCandidateProfile');
});

test('addNote keeps working through the legacy action', async () => {
    const response = await candidatesRoute.POST(jsonPost({
        action: 'addNote',
        candidateId: CANDIDATE_ID,
        body: 'hello',
    }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.result.noteId, 'note-1');
});

test('an unknown action returns 400', async () => {
    const response = await candidatesRoute.POST(jsonPost({ action: 'explode' }));
    assert.equal(response.status, 400);
});

test('addNote retains permission denial mapping', async () => {
    stubs.set('@/lib/pipeline-operations:addCandidateNote', async () => {
        throw new StaffAuthorizationError('FORBIDDEN', 'a required permission is not granted');
    });
    const response = await candidatesRoute.POST(jsonPost({ action: 'addNote', candidateId: CANDIDATE_ID, body: 'hello' }));
    assert.equal(response.status, 403);
});
