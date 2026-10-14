import { getClient } from '@/lib/client-job-operations';
import { getStaffCapabilities } from '@/lib/workspace-operations';
import { readClientRoles } from '@/lib/client-view.server';
import { staffApiContext, staffErrorResponse, staffGateResponse } from '@/lib/staff-api.server';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
    const context = await staffApiContext();
    const denied = staffGateResponse(context);
    if (denied) return denied;
    try {
        const { clientId } = await params;
        await getClient(context.pool, context.identity, context.organizationId, { clientId });
        const capabilities = await getStaffCapabilities(context.pool, context.identity, context.organizationId);
        const search = new URL(request.url).searchParams;
        const result = await readClientRoles({ pool: context.pool, identity: context.identity, organizationId: context.organizationId }, clientId, Object.fromEntries(search), capabilities.applications);
        return Response.json({ result }, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) { return staffErrorResponse(error); }
}
