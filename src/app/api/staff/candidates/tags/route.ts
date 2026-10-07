import { tagCandidates } from '@/lib/recruitment-operations';
import {
    staffApiContext,
    staffErrorResponse,
    staffGateResponse,
} from '@/lib/staff-api.server';

export const runtime = 'nodejs';

const JSON_PRIVATE = { 'Cache-Control': 'private, no-store' } as const;

export async function POST(request: Request) {
    const context = await staffApiContext();
    const denied = staffGateResponse(context);
    if (denied) {
        return denied;
    }
    const body = await request.json().catch(() => ({}));
    try {
        const result = await tagCandidates(
            context.pool, context.identity, context.organizationId,
            {
                candidates: body?.candidates,
                tag: body?.tag,
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
