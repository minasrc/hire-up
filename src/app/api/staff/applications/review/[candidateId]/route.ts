import { getCandidateWorkspace } from '@/lib/pipeline-operations';
import { staffApiContext, staffErrorResponse, staffGateResponse } from '@/lib/staff-api.server';
export const dynamic = 'force-dynamic';
export async function GET(_request: Request, { params }: { params: Promise<{ candidateId: string }> }) {
    const context = await staffApiContext();
    const denied = staffGateResponse(context);
    if (denied) return denied;
    try {
        const { candidateId } = await params;
        const result = await getCandidateWorkspace(context.pool, context.identity, context.organizationId, { candidateId });
        return Response.json({ result }, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) { return staffErrorResponse(error); }
}
