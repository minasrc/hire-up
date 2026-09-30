import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ClientJobContractError } from '../../src/lib/client-job-contracts.js';
import { installRouteMocks, setRouteStub, stubModule } from '../support/staff-route-mocks.js';
installRouteMocks();
stubModule('@/lib/staff-api.server', { staffApiContext: 'fn', staffGateResponse: 'fn', staffErrorResponse: 'fn' });
stubModule('@/lib/candidate-upload-operations', { authorizeCandidateUpload: 'fn', saveCandidateUpload: 'fn' });
stubModule('@/lib/candidate-upload-storage', { CANDIDATE_CV_BUCKET: { value: 'cv-submissions' }, createCandidateUploadStorage: 'fn', candidateCvObjectKey: 'fn', cleanupCandidateCv: 'fn' });
const { POST } = await import('../../src/app/api/staff/candidates/upload/route.ts');
const context = { organizationId: randomUUID(), pool: {}, identity: {} };
let calls;
let outcome;
let denied;
const storage = { storage: { from: () => ({ upload: async (...args) => { calls.push(['storage', ...args]); return {}; } }) } };
setRouteStub((specifier, name, args) => {
    calls.push([name, ...args]);
    if (name === 'staffApiContext') return context;
    if (name === 'staffGateResponse') return denied;
    if (name === 'authorizeCandidateUpload') return true;
    if (name === 'createCandidateUploadStorage') return storage;
    if (name === 'candidateCvObjectKey') return 'staff/test.pdf';
    if (name === 'cleanupCandidateCv') return;
    if (name === 'saveCandidateUpload') { if (outcome instanceof Error) throw outcome; return outcome; }
    if (name === 'staffErrorResponse') { if (args[0] instanceof ClientJobContractError) return Response.json({ fields: args[0].fieldErrors }, { status: 400 }); throw args[0]; }
    throw new Error(`Unexpected ${specifier}:${name}`);
});
const fields = { firstName: 'Ada', lastName: 'Lovelace', primaryEmail: 'ada@example.test', secondaryEmails: [], compensationPreference: '' };
function request(file = new File(['%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF'], 'resume.pdf', { type: 'application/pdf' }), raw = JSON.stringify(fields)) {
    const form = new FormData(); form.append('fields', raw); form.append('operationId', randomUUID()); if (file) form.append('cvFile', file);
    return new Request('http://localhost/api/staff/candidates/upload', { method: 'POST', body: form });
}
test('candidate upload route validates actual file bytes before any storage mutation', async () => {
    for (const file of [null, new File(['%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF'], 'disguised.docx'), new File(['fake PDF'], 'resume.pdf', { type: 'application/pdf' }), new File([new Uint8Array([0x50,0x4b,0x03,0x04])], 'broken.docx')]) {
        calls = []; denied = null;
        const response = await POST(request(file));
        assert.equal(response.status, 400); assert.ok((await response.json()).fields.cvFile);
        assert.equal(calls.some(([name]) => name === 'storage'), false);
    }
});
test('candidate upload route rejects oversized fields without relying on content length', async () => {
    calls = []; const response = await POST(request(undefined, JSON.stringify({ ...fields, professionalSummary: 'x'.repeat(50000) })));
    assert.equal(response.status, 400); assert.equal(calls.some(([name]) => name === 'storage'), false);
});
test('candidate upload route persists successful CV and cleans duplicate and replay attempts', async () => {
    for (const result of [{ status: 'created', candidateId: 'one' }, { status: 'created', candidateId: 'one', replayed: true }, { status: 'duplicate', candidateId: 'one' }]) {
        calls = []; outcome = result; const response = await POST(request());
        assert.equal(response.status, result.status === 'duplicate' ? 409 : 200);
        assert.equal(calls.filter(([name]) => name === 'cleanupCandidateCv').length, result.replayed || result.status === 'duplicate' ? 1 : 0);
        const save = calls.find(([name]) => name === 'saveCandidateUpload'); assert.equal(save[4].document.extension, 'pdf');
        assert.equal(save[4].document.sha256.length, 64);
    }
});
test('candidate upload route checks reference on lost commit and stops at auth gate', async () => {
    calls = []; outcome = new Error('commit lost'); const response = await POST(request()); assert.equal(response.status, 503);
    assert.equal(calls.filter(([name]) => name === 'cleanupCandidateCv').length, 1);
    calls = []; denied = Response.json({ error: 'unauthorized' }, { status: 401 }); assert.equal((await POST(request())).status, 401);
    assert.equal(calls.some(([name]) => name === 'authorizeCandidateUpload'), false);
});
