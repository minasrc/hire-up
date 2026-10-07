import {
    getCandidateWorkspace,
    saveCandidateProfile,
} from '@/lib/recruitment-operations';
import {
    staffApiContext,
    staffErrorResponse,
    staffGateResponse,
} from '@/lib/staff-api.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const JSON_PRIVATE = { 'Cache-Control': 'private, no-store' } as const;

function jsonResponse(body: unknown, init: ResponseInit = {}) {
    return Response.json(body, {
        ...init,
        headers: { ...JSON_PRIVATE, ...(init.headers ?? {}) },
    });
}

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ candidateId: string }> },
) {
    const context = await staffApiContext();
    const denied = staffGateResponse(context);
    if (denied) {
        return denied;
    }
    const { candidateId } = await params;
    try {
        const result = await getCandidateWorkspace(
            context.pool, context.identity, context.organizationId, candidateId);
        return jsonResponse({ ok: true, result });
    } catch (error) {
        return staffErrorResponse(error);
    }
}

export async function PATCH(
    request: Request,
    { params }: { params: Promise<{ candidateId: string }> },
) {
    const context = await staffApiContext();
    const denied = staffGateResponse(context);
    if (denied) {
        return denied;
    }
    const { candidateId } = await params;
    const body = await request.json().catch(() => ({}));
    try {
        const result = await saveCandidateProfile(
            context.pool, context.identity, context.organizationId,
            {
                candidateId,
                expectedVersion: body?.expectedVersion,
                fields: body?.fields,
                operationId: body?.operationId,
            },
        );
        return jsonResponse({ ok: true, result });
    } catch (error) {
        return staffErrorResponse(error);
    }
}
