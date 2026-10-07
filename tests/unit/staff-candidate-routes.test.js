import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

import { ClientJobContractError } from '../../src/lib/client-job-contracts.js';
import { normalizeCandidateDirectoryFilters } from '../../src/lib/recruitment-contracts.js';
import {
    installRouteMocks,
    setRouteStub,
    stubModule,
} from '../support/staff-route-mocks.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const realCvUpload = pathToFileURL(
    join(repoRoot, 'src/lib/staff-cv-upload.js')).href;

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
stubModule('@/lib/recruitment-operations', {
    createStaffCandidate: 'fn',
    getRecruitmentContext: 'fn',
    listCandidateDirectory: 'fn',
    staffHasPermission: 'fn',
    getJobWorkspace: 'fn',
    duplicateJob: 'fn',
    reviewCandidateImport: 'fn',
    commitCandidateImport: 'fn',
});
stubModule('@/lib/pipeline-operations', {
    addCandidateNote: 'fn',
    getDocumentDownload: 'fn',
});
stubModule('@/lib/application-file', { validateCvFile: 'fn' });
stubModule('@supabase/supabase-js', { createClient: 'fn' });
stubModule('@/lib/staff-cv-upload', {
    CV_BUCKET: { value: 'cv-submissions' },
    assertCvFilename: { reexport: realCvUpload },
    cleanupUploadedObject: { reexport: realCvUpload },
    createCandidateGateError: { reexport: realCvUpload },
    createStaffCvStorage: 'fn',
    removeUploadedObject: { reexport: realCvUpload },
    shouldDiscardResultUpload: { reexport: realCvUpload },
    staffCvObjectKey: { reexport: realCvUpload },
});

const candidatesRoute = await import('../../src/app/api/staff/candidates/route.ts');
const importRoute = await import(
    '../../src/app/api/staff/candidates/import/route.ts');
const duplicateRoute = await import(
    '../../src/app/api/staff/jobs/[jobId]/duplicate/route.ts');
const documentsRoute = await import(
    '../../src/app/api/staff/documents/[documentId]/route.ts');

const ORG_ID = '11111111-2222-3333-4444-555555555555';
const OP_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const CANDIDATE_ID = 'bbbbbbbb-2222-3333-4444-555555555555';
const SOURCE_JOB = 'cccccccc-3333-4444-5555-666666666666';
const SOURCE_REVISION = 'dddddddd-4444-5555-6666-777777777777';
const NEW_JOB = 'eeeeeeee-5555-6666-7777-888888888888';
const NEW_REVISION = 'ffffffff-6666-7777-8888-999999999999';
const DOC_ID = '12345678-1111-2222-3333-444444444444';

const IDENTITY = {
    provider: 'google',
    issuer: 'https://accounts.google.com',
    subject: '123456789',
};

const fakePool = (referenced) => ({
    connect: async () => ({
        query: async (text, params) => {
            if (text.includes('resolve_staff_principal_v1')) {
                return { rows: [{ user_id: 'u', membership_id: 'm', role_id: 'r' }] };
            }
            if (text.includes('has_permission_v1')) {
                return { rows: params[0].map(() => ({ allowed: true })) };
            }
            if (text.includes('staff_upload_referenced_v1')) {
                return { rows: [{ result: referenced }] };
            }
            return { rows: [] };
        },
        release: () => {},
    }),
});

const ALL_CAPS = {
    writeCandidates: true,
    uploadDocuments: true,
    addApplications: true,
    writeNotes: true,
};

let context;
let calls;

const installBaseStubs = () => {
    stubs.clear();
    calls = { upload: [], remove: [], operations: [] };
    context = { status: 'ok', pool: fakePool(null), identity: IDENTITY, organizationId: ORG_ID };
    stubs.set('@/lib/staff-api.server:staffApiContext', async () => context);
    stubs.set('@/lib/staff-api.server:staffGateResponse', (ctx) => {
        if (ctx.status === 'ok') return null;
        if (ctx.status === 'unconfigured') {
            return Response.json({ error: 'staff workspace not configured' }, { status: 503 });
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
        throw error;
    });
    stubs.set('@/lib/recruitment-operations:getRecruitmentContext',
        async () => ({ capabilities: { ...ALL_CAPS } }));
    stubs.set('@/lib/recruitment-operations:staffHasPermission', async () => true);
    stubs.set('@/lib/recruitment-operations:createStaffCandidate',
        async (pool, identity, org, input) => {
            calls.operations.push(['createStaffCandidate', input]);
            return { status: 'created', candidateId: input.candidateId };
        });
    stubs.set('@/lib/recruitment-operations:listCandidateDirectory',
        async (pool, identity, org, filters) => ({
            filters: normalizeCandidateDirectoryFilters(filters),
            rows: [],
        }));
    stubs.set('@/lib/recruitment-operations:getJobWorkspace',
        async () => ({ draft: { id: SOURCE_REVISION, version: 3 }, published: null }));
    stubs.set('@/lib/recruitment-operations:duplicateJob',
        async (pool, identity, org, input) => {
            calls.operations.push(['duplicateJob', input]);
            return { status: 'created', jobId: input.jobId, revisionId: input.revisionId };
        });
    stubs.set('@/lib/recruitment-operations:reviewCandidateImport',
        async (pool, identity, org, records) => {
            calls.operations.push(['reviewCandidateImport', records]);
            return { rows: records.map(() => ({ status: 'new' })) };
        });
    stubs.set('@/lib/recruitment-operations:commitCandidateImport',
        async (pool, identity, org, input) => {
            calls.operations.push(['commitCandidateImport', input]);
            return { rows: input.records.map(() => ({ status: 'created' })) };
        });
    stubs.set('@/lib/pipeline-operations:addCandidateNote',
        async () => ({ noteId: 'note-1' }));
    stubs.set('@/lib/pipeline-operations:getDocumentDownload',
        async () => ({
            bucket: 'cv-submissions',
            objectKey: `staff/${ORG_ID}/doc.pdf`,
            filename: 'cv.pdf',
            mimeType: 'application/pdf',
        }));
    stubs.set('@/lib/application-file:validateCvFile',
        async () => ({ ok: true, mimeType: 'application/pdf', extension: 'pdf' }));
    const storage = {
        calls,
        from: () => ({
            upload: async (key, bytes, options) => {
                calls.upload.push({ key, bytes, options });
                return { error: null };
            },
            remove: async (keys) => {
                calls.remove.push(keys);
                return { error: null };
            },
            createSignedUrl: async (key, ttl, options) => {
                calls.signed = calls.signed ?? [];
                calls.signed.push({ key, ttl, options });
                return { data: { signedUrl: `https://signed.example/${key}` }, error: null };
            },
        }),
    };
    stubs.set('@/lib/staff-cv-upload:createStaffCvStorage', () => ({ storage }));
    stubs.set('@supabase/supabase-js:createClient',
        () => ({ storage }));
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
};

const multipart = (entries) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(entries)) {
        form.set(key, value);
    }
    return new Request('http://localhost/api/staff/candidates', {
        method: 'POST',
        body: form,
    });
};

const jsonPost = (url, body) => new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
});

const validFields = JSON.stringify({ fullName: 'Ada Lovelace' });
const pdfFile = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'cv.pdf', {
    type: 'application/pdf',
});

test.beforeEach(installBaseStubs);

test('multipart create rejects malformed fields JSON with 400', async () => {
    const response = await candidatesRoute.POST(multipart({
        action: 'createCandidate',
        fields: '{not-json',
        operationId: OP_ID,
    }));
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, 'invalid input');
    assert.ok(body.fields.fields);
});

test('multipart create rejects a non-file cvFile entry', async () => {
    const response = await candidatesRoute.POST(multipart({
        action: 'createCandidate',
        fields: validFields,
        operationId: OP_ID,
        cvFile: 'cv.pdf',
    }));
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.ok(body.fields.cvFile);
});

test('multipart create rejects an unsupported action', async () => {
    const response = await candidatesRoute.POST(multipart({
        action: 'somethingElse',
        fields: validFields,
        operationId: OP_ID,
    }));
    assert.equal(response.status, 400);
});

test('denied context returns 401 without storage or operations', async () => {
    context = { status: 'unauthorized' };
    const response = await candidatesRoute.POST(multipart({
        action: 'createCandidate',
        fields: validFields,
        operationId: OP_ID,
        cvFile: pdfFile(),
    }));
    assert.equal(response.status, 401);
    assert.equal(calls.upload.length, 0);
    assert.equal(calls.operations.length, 0);
});

test('capability denial happens before any storage write', async () => {
    let storageCreated = 0;
    stubs.set('@/lib/staff-cv-upload:createStaffCvStorage', () => {
        storageCreated += 1;
        return { storage: { from: () => ({ upload: async () => ({}) }) } };
    });
    stubs.set('@/lib/recruitment-operations:getRecruitmentContext',
        async () => ({ capabilities: { writeCandidates: false } }));
    const response = await candidatesRoute.POST(multipart({
        action: 'createCandidate',
        fields: validFields,
        operationId: OP_ID,
        cvFile: pdfFile(),
    }));
    assert.equal(response.status, 403);
    assert.equal(storageCreated, 0);
    assert.equal(calls.upload.length, 0);
});

test('multipart create uploads the CV then commits the bundle', async () => {
    const response = await candidatesRoute.POST(multipart({
        action: 'createCandidate',
        fields: validFields,
        operationId: OP_ID,
        cvFile: pdfFile(),
    }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.result.status, 'created');
    assert.equal(calls.upload.length, 1);
    assert.match(calls.upload[0].key, new RegExp(`^staff/${ORG_ID}/.+\\.pdf$`));
    const [operation] = calls.operations;
    assert.equal(operation[0], 'createStaffCandidate');
    assert.equal(operation[1].operationId, OP_ID);
    assert.equal(operation[1].document.mimeType, 'application/pdf');
    assert.equal(calls.remove.length, 0);
});

test('duplicate result returns 409 with a nested candidate id', async () => {
    stubs.set('@/lib/recruitment-operations:createStaffCandidate',
        async () => ({ status: 'duplicate', candidateId: CANDIDATE_ID }));
    const response = await candidatesRoute.POST(multipart({
        action: 'createCandidate',
        fields: validFields,
        operationId: OP_ID,
        cvFile: pdfFile(),
    }));
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.result.status, 'duplicate');
    assert.equal(body.result.candidateId, CANDIDATE_ID);
    assert.equal(calls.remove.length, 1);
});

test('replayed result discards only the object uploaded by this request', async () => {
    stubs.set('@/lib/recruitment-operations:createStaffCandidate',
        async (pool, identity, org, input) => ({
            status: 'created', candidateId: input.candidateId, replayed: true,
        }));
    const response = await candidatesRoute.POST(multipart({
        action: 'createCandidate',
        fields: validFields,
        operationId: OP_ID,
        cvFile: pdfFile(),
    }));
    assert.equal(response.status, 200);
    assert.equal(calls.upload.length, 1);
    assert.deepEqual(calls.remove, [[calls.upload[0].key]]);
});

test('failed commit with an unverifiable reference keeps the object', async () => {
    stubs.set('@/lib/recruitment-operations:createStaffCandidate',
        async () => {
            throw new Error('commit exploded');
        });
    context = {
        status: 'ok',
        pool: fakePool(null),
        identity: IDENTITY,
        organizationId: ORG_ID,
    };
    await assert.rejects(
        candidatesRoute.POST(multipart({
            action: 'createCandidate',
            fields: validFields,
            operationId: OP_ID,
            cvFile: pdfFile(),
        })),
        /commit exploded/u);
    assert.equal(calls.upload.length, 1);
    assert.equal(calls.remove.length, 0);
});

test('failed commit with a proven unreferenced object deletes it', async () => {
    stubs.set('@/lib/recruitment-operations:createStaffCandidate',
        async () => {
            throw new Error('commit exploded');
        });
    context = {
        status: 'ok',
        pool: fakePool(false),
        identity: IDENTITY,
        organizationId: ORG_ID,
    };
    await assert.rejects(
        candidatesRoute.POST(multipart({
            action: 'createCandidate',
            fields: validFields,
            operationId: OP_ID,
            cvFile: pdfFile(),
        })),
        /commit exploded/u);
    assert.equal(calls.upload.length, 1);
    assert.deepEqual(calls.remove, [[calls.upload[0].key]]);
});

test('JSON createCandidate path validates and commits', async () => {
    const response = await candidatesRoute.POST(jsonPost(
        'http://localhost/api/staff/candidates',
        {
            action: 'createCandidate',
            fields: { fullName: 'Grace Hopper' },
            operationId: OP_ID,
        }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.result.status, 'created');
    assert.equal(calls.operations[0][1].fields.fullName, 'Grace Hopper');
});

test('JSON unknown action returns 400', async () => {
    const response = await candidatesRoute.POST(jsonPost(
        'http://localhost/api/staff/candidates',
        { action: 'explode', fields: {} }));
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, 'unknown action');
});

test('JSON addNote delegates to the notes operation', async () => {
    const response = await candidatesRoute.POST(jsonPost(
        'http://localhost/api/staff/candidates',
        {
            action: 'addNote',
            candidateId: CANDIDATE_ID,
            body: 'hello',
            operationId: OP_ID,
        }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.result.noteId, 'note-1');
});

test('directory GET maps invalid filters to 400', async () => {
    const request = new Request(
        'http://localhost/api/staff/candidates?tab=bogus');
    const response = await candidatesRoute.GET(request);
    assert.equal(response.status, 400);
});

test('directory GET passes normalized filters through', async () => {
    const request = new Request(
        'http://localhost/api/staff/candidates?q=ada&tab=mine&page=2');
    const response = await candidatesRoute.GET(request);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.result.filters.tab, 'mine');
    assert.equal(body.result.filters.page, 2);
});

test('import review forwards field-invalid rows instead of 400', async () => {
    const response = await importRoute.POST(jsonPost(
        'http://localhost/api/staff/candidates/import',
        {
            action: 'review',
            records: [
                { fields: { fullName: 'Ada' }, operationId: OP_ID },
                { fields: { email: 'no-name@example.com' }, operationId: OP_ID },
            ],
        }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    const [call] = calls.operations;
    assert.equal(call[0], 'reviewCandidateImport');
    assert.equal(call[1].length, 2);
    assert.equal(call[1][0].fields.source, 'import');
    assert.equal(call[1][1].fields.email, 'no-name@example.com');
});

test('import review rejects the legacy index envelope', async () => {
    const response = await importRoute.POST(jsonPost(
        'http://localhost/api/staff/candidates/import',
        {
            action: 'review',
            records: [{ index: 0, fields: { fullName: 'Ada' }, operationId: OP_ID }],
        }));
    assert.equal(response.status, 400);
    assert.equal(calls.operations.length, 0);
});

test('import commit validates rows strictly before calling SQL', async () => {
    const response = await importRoute.POST(jsonPost(
        'http://localhost/api/staff/candidates/import',
        {
            action: 'commit',
            records: [
                { fields: { email: 'no-name@example.com' }, operationId: OP_ID },
            ],
        }));
    assert.equal(response.status, 400);
    assert.equal(calls.operations.length, 0);
});

test('import commit normalizes jobId and forces import source', async () => {
    const response = await importRoute.POST(jsonPost(
        'http://localhost/api/staff/candidates/import',
        {
            action: 'commit',
            jobId: SOURCE_JOB,
            records: [
                {
                    fields: { fullName: 'Ada', source: 'manual' },
                    operationId: OP_ID,
                },
            ],
        }));
    assert.equal(response.status, 200);
    const [call] = calls.operations;
    assert.equal(call[0], 'commitCandidateImport');
    assert.equal(call[1].jobId, SOURCE_JOB);
    assert.equal(call[1].records[0].fields.source, 'import');
});

test('duplicate job passes the new id, not the source path id', async () => {
    const response = await duplicateRoute.POST(
        jsonPost(`http://localhost/api/staff/jobs/${SOURCE_JOB}/duplicate`, {
            sourceRevisionId: SOURCE_REVISION,
            expectedSourceVersion: '3',
            clientId: ORG_ID,
            jobId: NEW_JOB,
            revisionId: NEW_REVISION,
            operationId: OP_ID,
        }),
        { params: Promise.resolve({ jobId: SOURCE_JOB }) },
    );
    assert.equal(response.status, 200);
    const [call] = calls.operations;
    assert.equal(call[0], 'duplicateJob');
    assert.equal(call[1].jobId, NEW_JOB);
    assert.equal(call[1].sourceRevisionId, SOURCE_REVISION);
    assert.equal(call[1].expectedSourceVersion, '3');
    const body = await response.json();
    assert.equal(body.result.jobId, NEW_JOB);
});

test('duplicate job returns 404 for a mismatched revision id', async () => {
    const response = await duplicateRoute.POST(
        jsonPost(`http://localhost/api/staff/jobs/${SOURCE_JOB}/duplicate`, {
            sourceRevisionId: NEW_REVISION,
            expectedSourceVersion: '3',
            jobId: NEW_JOB,
            revisionId: NEW_REVISION,
            operationId: OP_ID,
        }),
        { params: Promise.resolve({ jobId: SOURCE_JOB }) },
    );
    assert.equal(response.status, 404);
    assert.equal(calls.operations.length, 0);
});

test('document inline json returns a signed url, not a redirect', async () => {
    const request = new Request(
        `http://localhost/api/staff/documents/${DOC_ID}?inline=1&format=json`);
    const response = await documentsRoute.GET(
        request, { params: Promise.resolve({ documentId: DOC_ID }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.match(body.url, /^https:\/\/signed\.example\//u);
    assert.equal(body.expiresIn, 60);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(calls.signed[0].options.download, false);
});

test('document inline preview rejects non-PDF documents', async () => {
    stubs.set('@/lib/pipeline-operations:getDocumentDownload', async () => ({
        bucket: 'cv-submissions',
        objectKey: 'k.docx',
        filename: 'cv.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }));
    const request = new Request(
        `http://localhost/api/staff/documents/${DOC_ID}?inline=1&format=json`);
    const response = await documentsRoute.GET(
        request, { params: Promise.resolve({ documentId: DOC_ID }) });
    assert.equal(response.status, 400);
});

test('document default response is a 302 download redirect', async () => {
    const request = new Request(
        `http://localhost/api/staff/documents/${DOC_ID}`);
    const response = await documentsRoute.GET(
        request, { params: Promise.resolve({ documentId: DOC_ID }) });
    assert.equal(response.status, 302);
    assert.match(response.headers.get('location'), /^https:\/\/signed\.example\//u);
    assert.equal(calls.signed[0].options.download, 'cv.pdf');
});

test('document route denies unauthenticated callers before signing', async () => {
    context = { status: 'unauthorized' };
    const request = new Request(
        `http://localhost/api/staff/documents/${DOC_ID}`);
    const response = await documentsRoute.GET(
        request, { params: Promise.resolve({ documentId: DOC_ID }) });
    assert.equal(response.status, 401);
});
