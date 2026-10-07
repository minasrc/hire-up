import { randomUUID } from 'node:crypto';
import { transitionApplicationStage } from '@/lib/pipeline-operations';
import { listApplicationDirectory } from '@/lib/recruitment-operations';
import {
    staffApiContext,
    staffErrorResponse,
    staffGateResponse,
} from '@/lib/staff-api.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const JSON_PRIVATE = { 'Cache-Control': 'private, no-store' } as const;

export async function GET(request: Request) {
    const context = await staffApiContext();
    const denied = staffGateResponse(context);
    if (denied) {
        return denied;
    }
    const params = new URL(request.url).searchParams;
    try {
        const result = await listApplicationDirectory(
            context.pool, context.identity, context.organizationId,
            {
                query: params.get('q') ?? undefined,
                clientId: params.get('client') ?? undefined,
                jobId: params.get('job') ?? undefined,
                owner: params.get('owner') ?? undefined,
                stage: params.get('stage') ?? undefined,
                review: params.get('review') ?? undefined,
                dateRange: params.get('range') ?? undefined,
                from: params.get('from') ?? undefined,
                to: params.get('to') ?? undefined,
                page: params.get('page') ?? undefined,
            },
        );
        return Response.json({ ok: true, result }, { headers: JSON_PRIVATE });
    } catch (error) {
        return staffErrorResponse(error);
    }
}

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
