import { randomUUID } from 'node:crypto';
import { listApplicationDirectory, transitionApplicationStage } from '@/lib/pipeline-operations';
import {
    staffApiContext,
    staffErrorResponse,
    staffGateResponse,
} from '@/lib/staff-api.server';

export const runtime = 'nodejs';

export async function POST(request: Request) {
    const context = await staffApiContext();
    const denied = staffGateResponse(context);
    if (denied) {
        return denied;
    }
    const body = await request.json().catch(() => ({}));
    const action = typeof body?.action === 'string' ? body.action : 'transitionStage';
    try {
        if (action === 'transitionStage') {
            const result = await transitionApplicationStage(
                context.pool, context.identity, context.organizationId,
                {
                    applicationId: body?.applicationId,
                    toStageId: body?.toStageId,
                    expectedVersion: body?.expectedVersion,
                    reason: body?.reason,
                    operationId: randomUUID(),
                },
            );
            return Response.json({ ok: true, result });
        }
        return Response.json({ error: 'unknown action' }, { status: 400 });
    } catch (error) {
        return staffErrorResponse(error);
    }
}

export async function GET(request: Request) {
    const context = await staffApiContext();
    const denied = staffGateResponse(context);
    if (denied) return denied;
    try {
        const result = await listApplicationDirectory(context.pool, context.identity, context.organizationId,
            Object.fromEntries(new URL(request.url).searchParams));
        return Response.json({ result }, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) { return staffErrorResponse(error); }
}
