import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_CV_SIZE_BYTES } from '../../src/lib/application.js';
import { validateCvFile } from '../../src/lib/application-file.js';
import {
    CV_BUCKET,
    cleanupUploadDecision,
    createCandidateGateError,
    removeUploadedObject,
    shouldDiscardResultUpload,
    staffCvObjectKey,
} from '../../src/lib/staff-cv-upload.js';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const CANDIDATE = '00000000-0000-4000-8000-0000000000b2';

const trackedStorage = () => {
    const calls = [];
    const supabase = {
        storage: {
            from: (bucket) => ({
                remove: async (keys) => {
                    calls.push({ bucket, keys });
                    return { data: keys, error: null };
                },
            }),
        },
    };
    return { supabase, calls };
};

test('staffCvObjectKey scopes objects to the organization and candidate', () => {
    const first = staffCvObjectKey(ORG, CANDIDATE, 'pdf');
    const second = staffCvObjectKey(ORG, CANDIDATE, 'pdf');
    assert.match(
        first,
        new RegExp(`^staff/${ORG}/${CANDIDATE}/[0-9a-f-]{36}\\.pdf$`),
    );
    assert.notEqual(first, second, 'each upload gets its own object key');
});

test('removeUploadedObject deletes only the key the request created', async () => {
    const { supabase, calls } = trackedStorage();
    await removeUploadedObject(supabase, `staff/${ORG}/${CANDIDATE}/own.pdf`);
    assert.deepEqual(calls, [
        { bucket: CV_BUCKET, keys: [`staff/${ORG}/${CANDIDATE}/own.pdf`] },
    ]);
});

test('ambiguous commit keeps the upload when the reference check fails', async () => {
    let removed = 0;
    await cleanupUploadDecision({
        check: async () => {
            throw Object.assign(new Error('database unreachable'), { code: 'ECONN' });
        },
        remove: async () => { removed += 1; },
    });
    assert.equal(removed, 0, 'an unverifiable commit must not delete the object');
});

test('a still-referenced upload is never deleted', async () => {
    let removed = 0;
    await cleanupUploadDecision({
        check: async () => true,
        remove: async () => { removed += 1; },
    });
    assert.equal(removed, 0);
});

test('a confirmed-unreferenced upload is removed', async () => {
    let removed = 0;
    await cleanupUploadDecision({
        check: async () => false,
        remove: async () => { removed += 1; },
    });
    assert.equal(removed, 1);
});

test('duplicate and replayed results discard the new upload; created keeps it', () => {
    assert.equal(shouldDiscardResultUpload({ status: 'duplicate' }), true);
    assert.equal(shouldDiscardResultUpload({ status: 'created', replayed: true }), true);
    assert.equal(shouldDiscardResultUpload({ status: 'created' }), false);
    assert.equal(shouldDiscardResultUpload(null), false);
});

test('create-candidate gate denies before any storage write', () => {
    const allowed = {
        writeCandidates: true,
        uploadDocuments: true,
        addApplications: true,
    };
    assert.equal(
        createCandidateGateError(
            { ...allowed, writeCandidates: false },
            { hasCv: true, hasJob: false, noteAllowed: true },
        ),
        'permission denied',
    );
    assert.equal(
        createCandidateGateError(
            { ...allowed, uploadDocuments: false },
            { hasCv: true, hasJob: false, noteAllowed: true },
        ),
        'permission denied',
    );
    assert.equal(
        createCandidateGateError(
            { ...allowed, addApplications: false },
            { hasCv: false, hasJob: true, noteAllowed: true },
        ),
        'permission denied',
    );
    assert.equal(
        createCandidateGateError(
            allowed,
            { hasCv: false, hasJob: false, noteAllowed: false },
        ),
        'permission denied',
    );
    assert.equal(
        createCandidateGateError(
            allowed,
            { hasCv: true, hasJob: true, noteAllowed: true },
        ),
        null,
    );
});

test('CV validation rejects oversize files and non-PDF/DOCX bytes', async () => {
    const oversized = await validateCvFile({
        name: 'cv.pdf',
        size: MAX_CV_SIZE_BYTES + 1,
        arrayBuffer: async () => new ArrayBuffer(0),
    });
    assert.equal(oversized.ok, false);
    assert.equal(oversized.code, 'FILE_TOO_LARGE');

    const wrongType = await validateCvFile({
        name: 'cv.pdf',
        size: 8,
        arrayBuffer: async () =>
            Uint8Array.from([0x6e, 0x6f, 0x74, 0x2d, 0x61, 0x2d, 0x63, 0x76]).buffer,
    });
    assert.equal(wrongType.ok, false);
    assert.equal(wrongType.code, 'INVALID_FILE_TYPE');
});
