import { addCandidateToJob } from '@/lib/recruitment-operations';
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
    const body = await request.json().catch(() => ({}));
    try {
        const result = await addCandidateToJob(
            context.pool, context.identity, context.organizationId,
            {
                candidateId,
                jobId: body?.jobId,
                operationId: body?.operationId,
            },
        );
        return Response.json(
            { ok: true, result },
            { headers: JSON_PRIVATE },
        );
    } catch (error) {
        return staffErrorResponse(error);
    }
}
