import { createHash, randomUUID } from 'node:crypto';
import { staffApiContext, staffGateResponse, staffErrorResponse } from '@/lib/staff-api.server';
import { ClientJobContractError } from '@/lib/client-job-contracts';
import { MAX_CV_SIZE_BYTES, validateCvFileMetadata } from '@/lib/application';
import { validateCvFile } from '@/lib/application-file';
import { assertOperationId } from '@/lib/candidate-profile-contracts';
import { assertCandidateCvFilename, validateCandidateUploadFields } from '@/lib/candidate-upload-contracts';
import { authorizeCandidateUpload, saveCandidateUpload } from '@/lib/candidate-upload-operations';
import { CANDIDATE_CV_BUCKET, createCandidateUploadStorage, candidateCvObjectKey, cleanupCandidateCv } from '@/lib/candidate-upload-storage';

export const runtime = 'nodejs';
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'private, no-store' } });
export async function POST(request: Request) {
    const context = await staffApiContext();
    const denied = staffGateResponse(context);
    if (denied) return denied;
    let storage: ReturnType<typeof createCandidateUploadStorage> = null;
    let objectKey: string | null = null;
    try {
        await authorizeCandidateUpload(context);
        if (Number(request.headers.get('content-length')) > MAX_CV_SIZE_BYTES + 65536) return json({ error: 'The CV must be 4 MB or smaller.' }, 413);
        const form = await request.formData().catch(() => null);
        if (!form) throw new ClientJobContractError({ input: 'A multipart upload is required.' });
        for (const key of form.keys()) {
            if (!['fields', 'cvFile', 'operationId'].includes(key) || form.getAll(key).length !== 1) throw new ClientJobContractError({ input: 'Unexpected or repeated upload field.' });
        }
        const rawFields = form.get('fields');
        if (typeof rawFields !== 'string' || Buffer.byteLength(rawFields, 'utf8') > 49152) throw new ClientJobContractError({ fields: 'Candidate fields exceed the maximum request size.' });
        let input;
        try { input = JSON.parse(rawFields); } catch { throw new ClientJobContractError({ fields: 'Candidate fields must be valid JSON.' }); }
        const fields = validateCandidateUploadFields(input);
        const operationId = assertOperationId(form.get('operationId'));
        const file = form.get('cvFile');
        const metadata = validateCvFileMetadata(file);
        if (!metadata.ok) throw new ClientJobContractError({ cvFile: metadata.message });
        const validated = await validateCvFile(file).catch(() => ({ ok: false as const, message: 'Only valid PDF and DOCX CVs are accepted.' }));
        if (!validated.ok) throw new ClientJobContractError({ cvFile: 'message' in validated ? validated.message : 'Invalid CV file.' });
        const filename = assertCandidateCvFilename((file as File).name);
        if (filename.split('.').pop()?.toLowerCase() !== validated.extension) {
            throw new ClientJobContractError({ cvFile: 'The CV contents must match its PDF or DOCX file extension.' });
        }
        const bytes = Buffer.from(await (file as File).arrayBuffer());
        storage = createCandidateUploadStorage();
        if (!storage) return json({ error: 'CV uploads are temporarily unavailable.' }, 503);
        const candidateId = randomUUID();
        objectKey = candidateCvObjectKey(context.organizationId, candidateId, validated.extension);
        const { error } = await storage.storage.from(CANDIDATE_CV_BUCKET).upload(objectKey, bytes, { contentType: validated.mimeType, upsert: false });
        if (error) throw error;
        const result = await saveCandidateUpload(context.pool, context.identity, context.organizationId, {
            candidateId, fields, operationId,
            document: { filename, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length,
                mimeType: validated.mimeType, extension: validated.extension, objectKey },
        });
        if (result.status === 'duplicate' || result.replayed) await cleanupCandidateCv(context, storage, objectKey);
        if (result.status === 'duplicate') return json({ ok: false, code: 'DUPLICATE_CANDIDATE', candidateId: result.candidateId, error: 'A candidate with one of these email addresses already exists.' }, 409);
        return json({ ok: true, result });
    } catch (error) {
        if (storage && objectKey) await cleanupCandidateCv(context, storage, objectKey);
        try {
            const response = staffErrorResponse(error);
            response.headers.set('cache-control', 'private, no-store');
            return response;
        } catch {
            console.error('candidate upload failed', (error as { code?: string })?.code ?? 'UNKNOWN');
            return json({ error: 'Candidate upload could not be completed. Retry with the same details and CV.' }, 503);
        }
    }
}
