import { getStaffNotifications } from '@/lib/workspace-operations';
import {
    staffApiContext,
    staffErrorResponse,
    staffGateResponse,
} from '@/lib/staff-api.server';

export const runtime = 'nodejs';

const PRIVATE_HEADERS = { 'cache-control': 'private, no-store' };

const privateResponse = (response: Response) => {
    const headers = new Headers(response.headers);
    headers.set('cache-control', 'private, no-store');
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
};

export async function GET() {
    let context;
    try {
        context = await staffApiContext();
    } catch {
        return Response.json(
            { error: 'staff context unavailable' },
            { status: 503, headers: PRIVATE_HEADERS },
        );
    }
    const denied = staffGateResponse(context);
    if (denied) {
        return privateResponse(denied);
    }
    try {
        const result = await getStaffNotifications(
            context.pool, context.identity, context.organizationId);
        return Response.json({ ok: true, result }, { headers: PRIVATE_HEADERS });
    } catch (error) {
        try {
            return privateResponse(staffErrorResponse(error));
        } catch {
            console.error(
                'staff notifications failed',
                (error as { code?: string })?.code ?? 'UNKNOWN',
            );
            return Response.json(
                { error: 'workspace notifications unavailable' },
                { status: 503, headers: PRIVATE_HEADERS },
            );
        }
    }
}
