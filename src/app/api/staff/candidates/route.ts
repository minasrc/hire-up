import { randomUUID } from 'node:crypto';
import { addCandidateNote } from '@/lib/pipeline-operations';
import {
    staffApiContext,
    staffErrorResponse,
    staffGateResponse,
} from '@/lib/staff-api.server';
import {
    isMissingProfileFunctionError,
    saveCandidateProfile,
} from '@/lib/candidate-profile-operations';
import { ClientJobContractError } from '@/lib/client-job-contracts';

export const runtime = 'nodejs';

const privateJson = (init: ResponseInit = {}) => ({
    ...init,
    headers: {
        'cache-control': 'private, no-store',
        ...(init.headers ?? {}),
    },
});

const createCandidateKeys = new Set(['action', 'fields', 'operationId']);

export async function POST(request: Request) {
    const context = await staffApiContext();
    const denied = staffGateResponse(context);
    if (denied) {
        return denied;
    }
    const body = await request.json().catch(() => ({}));
    const action = typeof body?.action === 'string' ? body.action : 'addNote';
    try {
        if (action === 'addNote') {
            const result = await addCandidateNote(
                context.pool, context.identity, context.organizationId,
                {
                    candidateId: body?.candidateId,
                    body: body?.body,
                    operationId: randomUUID(),
                },
            );
            return Response.json({ ok: true, result }, privateJson());
        }
        if (action === 'createCandidate') {
            for (const key of Object.keys(body ?? {})) {
                if (!createCandidateKeys.has(key)) {
                    throw new ClientJobContractError({
                        input: `Unknown request field "${key}".`,
                    });
                }
            }
            const result = await saveCandidateProfile(
                context.pool, context.identity, context.organizationId,
                {
                    candidateId: randomUUID(),
                    expectedVersion: null,
                    fields: body?.fields,
                    operationId: body?.operationId,
                },
            );
            if (result?.status === 'duplicate') {
                return Response.json(
                    {
                        ok: false,
                        code: 'DUPLICATE_CANDIDATE',
                        candidateId: result.candidateId,
                        error: 'A candidate with this email already exists.',
                    },
                    privateJson({ status: 409 }));
            }
            return Response.json({ ok: true, result }, privateJson());
        }
        return Response.json(
            { error: 'unknown action' }, privateJson({ status: 400 }));
    } catch (error) {
        if (isMissingProfileFunctionError(error)) {
            return Response.json(
                { error: 'Profile editing is temporarily unavailable.' },
                privateJson({ status: 503 }));
        }
        return staffErrorResponse(error);
    }
}
