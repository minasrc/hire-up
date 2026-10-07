import {
    staffApiContext,
    staffErrorResponse,
    staffGateResponse,
} from '@/lib/staff-api.server';
import { mergeCandidateDuplicates } from '@/lib/duplicate-review-operations';

export const runtime = 'nodejs';

export async function POST(request: Request) {
    const origin = request.headers.get('origin');
    const host = request.headers.get('host');
    let sameOrigin = false;
    try {
        const parsed = new URL(origin ?? '');
        sameOrigin = Boolean(host) && parsed.host === host
            && (parsed.protocol === 'https:' || parsed.protocol === 'http:');
    } catch {
        // Missing or malformed Origin is not a browser merge request.
    }
    if (!sameOrigin
        || !request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
        return Response.json({ error: 'invalid request origin or content type' }, { status: 403 });
    }
    const context = await staffApiContext();
    const denied = staffGateResponse(context);
    if (denied) return denied;
    const body = await request.json().catch(() => ({}));
    try {
        const result = await mergeCandidateDuplicates(
            context.pool, context.identity, context.organizationId,
            {
                reviewId: body?.reviewId,
                expectedVersion: body?.expectedVersion,
                targetCandidateId: body?.targetCandidateId,
                expectedTargetVersion: body?.expectedTargetVersion,
                expectedSourceVersion: body?.expectedSourceVersion,
                primaryEmail: body?.primaryEmail,
            },
        );
        return Response.json({ ok: true, result }, {
            headers: { 'cache-control': 'private, no-store' },
        });
    } catch (error) {
        return staffErrorResponse(error);
    }
}
