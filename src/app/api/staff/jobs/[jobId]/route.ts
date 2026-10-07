import { getJobWorkspace } from '@/lib/recruitment-operations';
import {
    staffApiContext,
    staffErrorResponse,
    staffGateResponse,
} from '@/lib/staff-api.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const JSON_PRIVATE = { 'Cache-Control': 'private, no-store' } as const;

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ jobId: string }> },
) {
    const context = await staffApiContext();
    const denied = staffGateResponse(context);
    if (denied) {
        return denied;
    }
    const { jobId } = await params;
    try {
        const result = await getJobWorkspace(
            context.pool, context.identity, context.organizationId, jobId);
        return Response.json({ ok: true, result }, { headers: JSON_PRIVATE });
    } catch (error) {
        return staffErrorResponse(error);
    }
}
