import {
    staffApiContext,
    staffErrorResponse,
    staffGateResponse,
} from '@/lib/staff-api.server';
import {
    getCandidateDuplicateComparison,
    reviewCandidateDuplicate,
} from '@/lib/duplicate-review-operations';

export const runtime = 'nodejs';

export async function GET(request: Request) {
    const context = await staffApiContext();
    const denied = staffGateResponse(context);
    if (denied) return denied;
    try {
        const result = await getCandidateDuplicateComparison(
            context.pool, context.identity, context.organizationId,
            { reviewId: new URL(request.url).searchParams.get('reviewId') },
        );
        return Response.json({ result }, {
            headers: { 'cache-control': 'private, no-store' },
        });
    } catch (error) {
        if ((error as { code?: string })?.code === 'P0002') {
            return Response.json({ error: 'not found' }, { status: 404 });
        }
        return staffErrorResponse(error);
    }
}

export async function POST(request: Request) {
    const context = await staffApiContext();
    const denied = staffGateResponse(context);
    if (denied) return denied;
    const body = await request.json().catch(() => ({}));
    try {
        const result = await reviewCandidateDuplicate(
            context.pool, context.identity, context.organizationId,
            {
                reviewId: body?.reviewId,
                expectedVersion: body?.expectedVersion,
                decision: body?.decision,
            },
        );
        return Response.json({ ok: true, result }, {
            headers: { 'cache-control': 'private, no-store' },
        });
    } catch (error) {
        return staffErrorResponse(error);
    }
}
