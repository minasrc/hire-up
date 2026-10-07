import { listPrivacyCases } from '@/lib/recruitment-operations';
import {
    staffApiContext,
    staffErrorResponse,
    staffGateResponse,
} from '@/lib/staff-api.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const JSON_PRIVATE = { 'Cache-Control': 'private, no-store' } as const;

export async function GET() {
    const context = await staffApiContext();
    const denied = staffGateResponse(context);
    if (denied) {
        return denied;
    }
    try {
        const result = await listPrivacyCases(
            context.pool, context.identity, context.organizationId);
        return Response.json({ ok: true, result }, { headers: JSON_PRIVATE });
    } catch (error) {
        return staffErrorResponse(error);
    }
}
