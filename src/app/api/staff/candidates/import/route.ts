import {
    commitCandidateImport,
    reviewCandidateImport,
} from '@/lib/recruitment-operations';
import {
    uuidOrNull,
    validateImportRecords,
    validateImportReviewRecords,
} from '@/lib/recruitment-contracts';
import {
    staffApiContext,
    staffErrorResponse,
    staffGateResponse,
} from '@/lib/staff-api.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const JSON_PRIVATE = { 'Cache-Control': 'private, no-store' } as const;

export async function POST(request: Request) {
    const context = await staffApiContext();
    const denied = staffGateResponse(context);
    if (denied) {
        return denied;
    }
    const body = await request.json().catch(() => null);
    const action = typeof body?.action === 'string' ? body.action : '';
    try {
        const jobId = uuidOrNull(body?.jobId, 'jobId');
        if (action === 'review') {
            const records = validateImportReviewRecords(body?.records);
            const result = await reviewCandidateImport(
                context.pool, context.identity, context.organizationId, records);
            return Response.json(
                { ok: true, result },
                { headers: JSON_PRIVATE },
            );
        }
        if (action === 'commit') {
            const records = validateImportRecords(body?.records);
            const result = await commitCandidateImport(
                context.pool, context.identity, context.organizationId,
                { records, jobId });
            return Response.json(
                { ok: true, result },
                { headers: JSON_PRIVATE },
            );
        }
        return Response.json(
            { error: 'unknown action' },
            { status: 400, headers: JSON_PRIVATE },
        );
    } catch (error) {
        return staffErrorResponse(error);
    }
}
