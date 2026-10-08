import assert from 'node:assert/strict';
import test from 'node:test';

import { createSyntheticDocx, createSyntheticPdf, syntheticCvText } from '../support/cv-fixtures.js';
import { installRouteMocks, setRouteStub, stubModule } from '../support/staff-route-mocks.js';

const stubs = new Map();
setRouteStub((specifier, name, args) => {
    const handler = stubs.get(`${specifier}:${name}`);
    if (!handler) throw new Error(`unstubbed route dependency ${specifier}:${name}`);
    return handler(...args);
});
installRouteMocks();
stubModule('@/lib/staff-api.server', {
    staffApiContext: 'fn', staffGateResponse: 'fn', staffErrorResponse: 'fn',
});
stubModule('@/lib/pipeline-operations', { getDocumentDownload: 'fn' });
stubModule('@/lib/client-job-operations', { getJobWorkspace: 'fn', getClient: 'fn' });
stubModule('@supabase/supabase-js', { createClient: 'fn' });

const documents = await import('../../src/app/api/staff/documents/[documentId]/route.ts');
const jobs = await import('../../src/app/api/staff/jobs/[jobId]/route.ts');
const ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const context = { status: 'ok', pool: {}, identity: {}, organizationId: ID };

function setup() {
    stubs.clear();
    stubs.set('@/lib/staff-api.server:staffApiContext', async () => context);
    stubs.set('@/lib/staff-api.server:staffGateResponse', (value) => value.status === 'ok'
        ? null : Response.json({ error: 'unauthorized' }, { status: 401 }));
    stubs.set('@/lib/staff-api.server:staffErrorResponse', (error) => {
        throw error;
    });
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://storage.example.test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-service-role';
}

function request(view, version) {
    return new Request(`http://localhost/api/staff/documents/${ID}${view ? `?view=${view}` : ''}`,
        { headers: version ? { 'if-none-match': version } : {} });
}

function storageStub(mimeType) {
    const calls = [];
    stubs.set('@/lib/pipeline-operations:getDocumentDownload', async () => ({
        bucket: 'private-cvs', objectKey: 'one.docx', filename: 'one.docx', mimeType,
    }));
    stubs.set('@supabase/supabase-js:createClient', () => ({ storage: {
        from: (bucket) => {
            calls.push(['bucket', bucket]);
            return {
                download: async (key) => {
                    calls.push(['download', key]);
                    return { data: new Blob([mimeType === 'application/pdf'
                        ? createSyntheticPdf() : createSyntheticDocx()]), error: null };
                },
                createSignedUrl: async (key, ttl, options) => {
                    calls.push(['sign', key, ttl, options]);
                    return { data: { signedUrl: 'https://storage.example.test/signed' }, error: null };
                },
            };
        },
    } }));
    return calls;
}

test('DOCX text preview extracts readable content after document authorization', async () => {
    setup();
    const calls = storageStub(DOCX);
    const response = await documents.GET(request('text'), { params: Promise.resolve({ documentId: ID }) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.match((await response.json()).text, new RegExp(syntheticCvText));
    assert.deepEqual(calls, [['bucket', 'private-cvs'], ['download', 'one.docx']]);
});

test('PDF inline view signs without download disposition; ordinary download keeps it', async () => {
    setup();
    const calls = storageStub('application/pdf');
    const params = { params: Promise.resolve({ documentId: ID }) };
    const inline = await documents.GET(request('inline'), params);
    assert.equal(inline.status, 302);
    assert.equal(inline.headers.get('cache-control'), 'private, no-store');
    assert.equal(calls.at(-1)[3], undefined);
    const download = await documents.GET(request(), params);
    assert.equal(download.status, 302);
    assert.deepEqual(calls.at(-1)[3], { download: 'one.docx' });
});

test('PDF page renderer receives authorized same-origin bytes without caching', async () => {
    setup();
    const calls = storageStub('application/pdf');
    const response = await documents.GET(request('bytes'),
        { params: Promise.resolve({ documentId: ID }) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.ok(Buffer.from(await response.arrayBuffer()).toString('utf8').startsWith('%PDF-'));
    assert.deepEqual(calls, [['bucket', 'private-cvs'], ['download', 'one.docx']]);
});

test('preview refuses mismatched content type and unauthenticated requests', async () => {
    setup();
    const calls = storageStub('application/pdf');
    const response = await documents.GET(request('text'), { params: Promise.resolve({ documentId: ID }) });
    assert.equal(response.status, 415);
    assert.deepEqual(calls, []);
    stubs.set('@/lib/staff-api.server:staffApiContext', async () => ({ status: 'unauthorized' }));
    const denied = await documents.GET(request('inline'), { params: Promise.resolve({ documentId: ID }) });
    assert.equal(denied.status, 401);
});

test('conditional preview rechecks authorization and avoids storage only for the current version', async () => {
    setup();
    const calls = storageStub('application/pdf');
    let reads = 0, version = 'a'.repeat(64);
    stubs.set('@/lib/pipeline-operations:getDocumentDownload', async () => {
        reads++;
        return { bucket: 'private-cvs', objectKey: 'one.pdf', filename: 'one.pdf',
            mimeType: 'application/pdf', previewVersion: version };
    });
    const params = { params: Promise.resolve({ documentId: ID }) };
    const first = await documents.GET(request('bytes'), params);
    const etag = first.headers.get('etag');
    assert.ok(etag); assert.equal(first.status, 200);
    const unchanged = await documents.GET(request('bytes', etag), params);
    assert.equal(unchanged.status, 304);
    assert.equal(unchanged.headers.get('cache-control'), 'private, no-store');
    assert.equal((await unchanged.arrayBuffer()).byteLength, 0);
    assert.equal(reads, 2, 'cached reuse must recheck document access');
    assert.equal(calls.filter(([name]) => name === 'download').length, 1);
    version = 'b'.repeat(64);
    const changed = await documents.GET(request('bytes', etag), params);
    assert.equal(changed.status, 200); assert.notEqual(changed.headers.get('etag'), etag);
    assert.equal(calls.filter(([name]) => name === 'download').length, 2);
    const differentView = await documents.GET(request('text', etag), params);
    assert.equal(differentView.status, 415);
});

test('a matching cached version cannot bypass lost membership, permissions or document availability', async () => {
    setup(); const calls = storageStub('application/pdf');
    stubs.set('@/lib/staff-api.server:staffErrorResponse', (error) => Response.json({ error: 'denied' }, { status: error.status }));
    const params = { params: Promise.resolve({ documentId: ID }) };
    for (const status of [403, 404]) {
        stubs.set('@/lib/pipeline-operations:getDocumentDownload', async () => { throw Object.assign(new Error('Denied'), { status }); });
        const response = await documents.GET(request('bytes', `"preview-v1-bytes-${'a'.repeat(64)}"`), params);
        assert.equal(response.status, status);
    }
    stubs.set('@/lib/staff-api.server:staffApiContext', async () => ({ status: 'unauthorized' }));
    const denied = await documents.GET(request('bytes', `"preview-v1-bytes-${'a'.repeat(64)}"`), params);
    assert.equal(denied.status, 401); assert.deepEqual(calls, []);
});

test('an older database without a document version never approves cached reuse', async () => {
    setup(); const calls = storageStub(DOCX);
    const response = await documents.GET(request('text', '"preview-v1-text-old"'),
        { params: Promise.resolve({ documentId: ID }) });
    assert.equal(response.status, 200); assert.equal(response.headers.get('etag'), null);
    assert.equal(calls.filter(([name]) => name === 'download').length, 1);
});

test('job preview reads the authorized workspace and client', async () => {
    setup();
    const calls = [];
    stubs.set('@/lib/client-job-operations:getJobWorkspace', async (_pool, _identity, _org, input) => {
        calls.push(['job', input.jobId]);
        return { job: { id: ID, clientId: ID, title: 'Engineer' }, draft: null, published: null };
    });
    stubs.set('@/lib/client-job-operations:getClient', async (_pool, _identity, _org, input) => {
        calls.push(['client', input.clientId]);
        return { client: { name: 'Acme' } };
    });
    const response = await jobs.GET(new Request(`http://localhost/api/staff/jobs/${ID}`),
        { params: Promise.resolve({ jobId: ID }) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal((await response.json()).result.client.name, 'Acme');
    assert.deepEqual(calls, [['job', ID], ['client', ID]]);
});
