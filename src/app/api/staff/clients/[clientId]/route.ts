import { readClientView } from '@/lib/client-view.server';
import { randomUUID } from 'node:crypto';
import { saveClientWithDetails } from '@/lib/client-job-operations';
import {
    staffApiContext,
    staffErrorResponse,
    staffGateResponse,
} from '@/lib/staff-api.server';

export const runtime = 'nodejs';

const privateResponse = (response: Response) => {
    response.headers.set('cache-control', 'private, no-store');
    return response;
};

export async function POST(
    request: Request,
    { params }: { params: Promise<{ clientId: string }> },
) {
    const context = await staffApiContext();
    const denied = staffGateResponse(context);
    if (denied) {
        return privateResponse(denied);
    }
    const { clientId } = await params;
    const body = await request.json().catch(() => ({}));
    try {
        const result = await saveClientWithDetails(
            context.pool, context.identity, context.organizationId,
            {
                clientId,
                expectedVersion: body?.expectedVersion ?? null,
                fields: body?.fields,
                operationId: randomUUID(),
            },
        );
        return privateResponse(Response.json({ ok: true, result }));
    } catch (error) {
        return privateResponse(staffErrorResponse(error));
    }
}

export async function GET(_request: Request, { params }: { params: Promise<{ clientId: string }> }) {
    const context = await staffApiContext();
    const denied = staffGateResponse(context);
    if (denied) return privateResponse(denied);
    try {
        const { clientId } = await params;
        const result = await readClientView({ pool: context.pool, identity: context.identity, organizationId: context.organizationId }, clientId);
        return privateResponse(Response.json({ result }));
    } catch (error) { return privateResponse(staffErrorResponse(error)); }
}
