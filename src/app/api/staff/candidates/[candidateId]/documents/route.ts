import { createHash } from 'node:crypto';

import { validateCvFile } from '@/lib/application-file';
import {
    addCandidateDocument,
    getCandidateWorkspace,
    getRecruitmentContext,
} from '@/lib/recruitment-operations';
import {
    assertUuid,
    assertVersion,
} from '@/lib/recruitment-contracts';
import {
    CV_BUCKET,
    assertCvFilename,
    cleanupUploadedObject,
    createStaffCvStorage,
    removeUploadedObject,
    shouldDiscardResultUpload,
    staffCvObjectKey,
} from '@/lib/staff-cv-upload';
import {
    staffApiContext,
    staffErrorResponse,
    staffGateResponse,
} from '@/lib/staff-api.server';

export const runtime = 'nodejs';

const JSON_PRIVATE = { 'Cache-Control': 'private, no-store' } as const;

export async function POST(
    request: Request,
    { params }: { params: Promise<{ candidateId: string }> },
) {
    const context = await staffApiContext();
    const denied = staffGateResponse(context);
    if (denied) {
        return denied;
    }
    const { candidateId } = await params;

    let cvFile: File | null = null;
    let expectedVersion: string;
    let operationId: string;
    try {
        const formData = await request.formData();
        const cvEntry = formData.get('cvFile');
        cvFile = cvEntry instanceof File ? cvEntry : null;
        if (cvEntry !== null && !(cvEntry instanceof File)) {
            return Response.json(
                { error: 'cvFile must be a file upload.' },
                { status: 400, headers: JSON_PRIVATE },
            );
        }
        expectedVersion = assertVersion(formData.get('expectedVersion')).toString();
        operationId = assertUuid(formData.get('operationId'), 'operationId');
        assertUuid(candidateId, 'candidateId');
        if (cvFile) {
            assertCvFilename(cvFile.name);
        }
    } catch (error) {
        return staffErrorResponse(error);
    }

    const validation = cvFile ? await validateCvFile(cvFile) : null;
    if (!validation?.ok) {
        return Response.json(
            { error: validation?.message ?? 'Attach a CV file.' },
            { status: 400, headers: JSON_PRIVATE },
        );
    }

    try {
        const recruitmentContext = await getRecruitmentContext(
            context.pool, context.identity, context.organizationId);
        if (!recruitmentContext?.capabilities?.uploadDocuments) {
            return Response.json(
                { error: 'permission denied' },
                { status: 403, headers: JSON_PRIVATE },
            );
        }
        const workspace = await getCandidateWorkspace(
            context.pool, context.identity, context.organizationId, candidateId);
        if (workspace?.candidate?.lifecycle !== 'active') {
            return Response.json(
                { error: 'This candidate cannot be changed.' },
                { status: 409, headers: JSON_PRIVATE },
            );
        }

        const supabase = createStaffCvStorage();
        if (!supabase) {
            return Response.json(
                { error: 'storage is not configured' },
                { status: 503, headers: JSON_PRIVATE },
            );
        }
        const bytes = new Uint8Array(await cvFile!.arrayBuffer());
        const objectKey = staffCvObjectKey(
            context.organizationId, candidateId, validation.extension!);
        const { error: uploadError } = await supabase.storage
            .from(CV_BUCKET)
            .upload(objectKey, bytes, {
                contentType: validation.mimeType,
                upsert: false,
            });
        if (uploadError) {
            return Response.json(
                { error: 'upload failed' },
                { status: 502, headers: JSON_PRIVATE },
            );
        }
        const document = {
            filename: cvFile!.name,
            mimeType: validation.mimeType!,
            extension: validation.extension!,
            sizeBytes: cvFile!.size,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            bucket: CV_BUCKET,
            objectKey,
        };

        try {
            const result = await addCandidateDocument(
                context.pool, context.identity, context.organizationId,
                { candidateId, expectedVersion, document, operationId },
            );
            if (shouldDiscardResultUpload(result)) {
                await removeUploadedObject(supabase, objectKey);
            }
            return Response.json(
                { ok: true, result },
                {
                    status: result?.status === 'duplicate' ? 409 : 200,
                    headers: JSON_PRIVATE,
                },
            );
        } catch (error) {
            await cleanupUploadedObject(
                context as {
                    pool: unknown;
                    identity: unknown;
                    organizationId: string;
                },
                supabase,
                objectKey,
            );
            throw error;
        }
    } catch (error) {
        return staffErrorResponse(error);
    }
}
