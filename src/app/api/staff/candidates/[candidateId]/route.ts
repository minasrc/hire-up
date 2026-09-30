import {
    staffApiContext,
    staffErrorResponse,
    staffGateResponse,
} from '@/lib/staff-api.server';
import {
    getCandidateProfile,
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

const unavailable = () => Response.json(
    { error: 'Profile editing is temporarily unavailable.' },
    privateJson({ status: 503 }));

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ candidateId: string }> },
) {
    const context = await staffApiContext();
    const gate = staffGateResponse(context);
    if (gate) return gate;
    if (context.status !== 'ok') {
        return Response.json({ error: 'unauthorized' }, privateJson({ status: 401 }));
    }
    try {
        const { candidateId } = await params;
        const result = await getCandidateProfile(
            context.pool, context.identity, context.organizationId, { candidateId });
        return Response.json({ ok: true, result }, privateJson());
    } catch (error) {
        if (isMissingProfileFunctionError(error)) return unavailable();
        return staffErrorResponse(error);
    }
}

const patchKeys = new Set(['fields', 'expectedVersion', 'operationId']);

export async function PATCH(
    request: Request,
    { params }: { params: Promise<{ candidateId: string }> },
) {
    const context = await staffApiContext();
    const gate = staffGateResponse(context);
    if (gate) return gate;
    if (context.status !== 'ok') {
        return Response.json({ error: 'unauthorized' }, privateJson({ status: 401 }));
    }
    try {
        const { candidateId } = await params;
        let body: unknown;
        try {
            body = await request.json();
        } catch {
            throw new ClientJobContractError({
                input: 'Request body must be valid JSON.',
            });
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
            throw new ClientJobContractError({
                input: 'A request object is required.',
            });
        }
        const record = body as Record<string, unknown>;
        for (const key of Object.keys(record)) {
            if (!patchKeys.has(key)) {
                throw new ClientJobContractError({
                    input: `Unknown request field "${key}".`,
                });
            }
        }
        if (typeof record.expectedVersion !== 'string') {
            throw new ClientJobContractError({
                expectedVersion: 'A numeric record version is required.',
            });
        }
        const result = await saveCandidateProfile(
            context.pool, context.identity, context.organizationId, {
                candidateId,
                expectedVersion: record.expectedVersion,
                fields: record.fields,
                operationId: record.operationId,
            });
        return Response.json({ ok: true, result }, privateJson());
    } catch (error) {
        if (isMissingProfileFunctionError(error)) return unavailable();
        return staffErrorResponse(error);
    }
}
