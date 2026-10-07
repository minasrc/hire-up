import { createHash, randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';
import { addCandidateNote } from '@/lib/pipeline-operations';
import { validateCvFile } from '@/lib/application-file';
import {
    createStaffCandidate,
    getRecruitmentContext,
    listCandidateDirectory,
    staffHasPermission,
} from '@/lib/recruitment-operations';
import {
    assertOperationId,
    optionalNoteText,
    uuidOrNull,
    validateCandidateFields,
    ClientJobContractError,
} from '@/lib/recruitment-contracts';
import {
    CV_BUCKET,
    assertCvFilename,
    cleanupUploadedObject,
    createCandidateGateError,
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
export const dynamic = 'force-dynamic';

const JSON_PRIVATE = { 'Cache-Control': 'private, no-store' } as const;
const MAX_FIELDS_BYTES = 64 * 1024;

function jsonResponse(body: unknown, init: ResponseInit = {}) {
    return Response.json(body, {
        ...init,
        headers: { ...JSON_PRIVATE, ...(init.headers ?? {}) },
    });
}

export async function GET(request: Request) {
    const context = await staffApiContext();
    const denied = staffGateResponse(context);
    if (denied) {
        return denied;
    }
    const params = new URL(request.url).searchParams;
    try {
        const result = await listCandidateDirectory(
            context.pool, context.identity, context.organizationId,
            {
                query: params.get('q') ?? undefined,
                owner: params.get('owner') ?? undefined,
                tag: params.get('tag') ?? undefined,
                tab: params.get('tab') ?? undefined,
                page: params.get('page') ?? undefined,
            },
        );
        return jsonResponse({ ok: true, result });
    } catch (error) {
        return staffErrorResponse(error);
    }
}

type CreateCandidatePayload = {
    fields: unknown;
    jobId: string | null;
    note: string | null;
    operationId: string;
    candidateId: string;
    cvFile: File | null;
};

function createPayloadFromJson(body: Record<string, unknown>): CreateCandidatePayload {
    return {
        fields: body?.fields,
        jobId: uuidOrNull(body?.jobId, 'jobId'),
        note: optionalNoteText(body?.note),
        operationId: assertOperationId(body?.operationId),
        candidateId: randomUUID(),
        cvFile: null,
    };
}

async function createPayloadFromFormData(formData: FormData): Promise<CreateCandidatePayload> {
    if (formData.get('action') !== 'createCandidate') {
        throw new ClientJobContractError({ action: 'Unsupported candidate action.' });
    }
    const rawFields = formData.get('fields');
    if (typeof rawFields !== 'string'
        || Buffer.byteLength(rawFields, 'utf8') > MAX_FIELDS_BYTES) {
        throw new ClientJobContractError({ fields: 'fields must be a JSON object.' });
    }
    let fields: unknown;
    try {
        fields = JSON.parse(rawFields);
    } catch {
        throw new ClientJobContractError({ fields: 'fields must be valid JSON.' });
    }
    const cvEntry = formData.get('cvFile');
    if (cvEntry !== null && !(cvEntry instanceof File)) {
        throw new ClientJobContractError({ cvFile: 'cvFile must be a file upload.' });
    }
    return {
        fields,
        jobId: uuidOrNull(formData.get('jobId'), 'jobId'),
        note: optionalNoteText(formData.get('note')),
        operationId: assertOperationId(formData.get('operationId')),
        candidateId: randomUUID(),
        cvFile: cvEntry as File | null,
    };
}

export async function POST(request: Request) {
    const context = await staffApiContext();
    const denied = staffGateResponse(context);
    if (denied) {
        return denied;
    }

    const isMultipart = (request.headers.get('content-type') ?? '')
        .includes('multipart/form-data');

    try {
        let payload: CreateCandidatePayload;
        if (isMultipart) {
            let formData: FormData;
            try {
                formData = await request.formData();
            } catch {
                throw new ClientJobContractError({
                    fields: 'The form data could not be read.',
                });
            }
            payload = await createPayloadFromFormData(formData);
        } else {
            const body = await request.json().catch(() => ({}));
            const action = typeof body?.action === 'string' ? body.action : 'addNote';
            if (action === 'addNote') {
                const result = await addCandidateNote(
                    context.pool, context.identity, context.organizationId,
                    {
                        candidateId: body?.candidateId,
                        body: body?.body,
                        operationId: body?.operationId ?? randomUUID(),
                    },
                );
                return jsonResponse({ ok: true, result });
            }
            if (action !== 'createCandidate') {
                return jsonResponse({ error: 'unknown action' }, { status: 400 });
            }
            payload = createPayloadFromJson(body);
        }

        const fields = validateCandidateFields(payload.fields);
        const jobId = payload.jobId;
        const note = payload.note;
        const operationId = payload.operationId;

        const recruitmentContext = await getRecruitmentContext(
            context.pool, context.identity, context.organizationId);
        const capabilities = recruitmentContext?.capabilities ?? {};
        const noteAllowed = !note || await staffHasPermission(
            context.pool, context.identity, context.organizationId,
            'collaboration.write');
        const gateError = createCandidateGateError(capabilities, {
            hasCv: payload.cvFile !== null,
            hasJob: jobId !== null,
            noteAllowed,
        });
        if (gateError) {
            return jsonResponse({ error: gateError }, { status: 403 });
        }

        let document: {
            filename: string;
            mimeType: string;
            extension: string;
            sizeBytes: number;
            sha256: string;
            bucket: string;
            objectKey: string;
        } | null = null;
        let supabase: SupabaseClient | null = null;

        if (payload.cvFile) {
            const validation = await validateCvFile(payload.cvFile);
            if (!validation.ok) {
                return jsonResponse({ error: validation.message }, { status: 400 });
            }
            const filename = assertCvFilename(payload.cvFile.name);
            supabase = createStaffCvStorage();
            if (!supabase) {
                return jsonResponse({ error: 'storage is not configured' }, { status: 503 });
            }
            const bytes = new Uint8Array(await payload.cvFile.arrayBuffer());
            const objectKey = staffCvObjectKey(
                context.organizationId, payload.candidateId, validation.extension);
            const { error: uploadError } = await supabase.storage
                .from(CV_BUCKET)
                .upload(objectKey, bytes, {
                    contentType: validation.mimeType,
                    upsert: false,
                });
            if (uploadError) {
                return jsonResponse({ error: 'upload failed' }, { status: 502 });
            }
            document = {
                filename,
                mimeType: validation.mimeType,
                extension: validation.extension,
                sizeBytes: payload.cvFile.size,
                sha256: createHash('sha256').update(bytes).digest('hex'),
                bucket: CV_BUCKET,
                objectKey,
            };
        }

        try {
            const result = await createStaffCandidate(
                context.pool, context.identity, context.organizationId,
                {
                    candidateId: payload.candidateId,
                    fields,
                    document,
                    jobId,
                    note,
                    operationId,
                },
            );
            if (
                document
                && supabase
                && shouldDiscardResultUpload(result)
            ) {
                await removeUploadedObject(supabase, document.objectKey);
            }
            return jsonResponse(
                { ok: true, result },
                { status: result?.status === 'duplicate' ? 409 : 200 },
            );
        } catch (error) {
            if (document && supabase) {
                await cleanupUploadedObject(
                    context as {
                        pool: unknown;
                        identity: unknown;
                        organizationId: string;
                    },
                    supabase,
                    document.objectKey,
                );
            }
            throw error;
        }
    } catch (error) {
        return staffErrorResponse(error);
    }
}
