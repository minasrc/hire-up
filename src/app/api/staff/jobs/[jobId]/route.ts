import { getJobPreview } from '@/lib/client-job-operations';
import { staffApiContext, staffErrorResponse, staffGateResponse } from '@/lib/staff-api.server';

export const runtime = 'nodejs';

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ jobId: string }> },
) {
    const context = await staffApiContext();
    const gate = staffGateResponse(context);
    if (gate) return gate;
    if (context.status !== 'ok') {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    try {
        const { jobId } = await params;
        const result = await getJobPreview(
            context.pool, context.identity, context.organizationId, { jobId });
        return Response.json({ ok: true, result }, {
            headers: { 'cache-control': 'private, no-store' },
        });
    } catch (error) {
        return staffErrorResponse(error);
    }
}
