import { staffApiContext, staffErrorResponse, staffGateResponse } from '@/lib/staff-api.server';
import { staffRequestOriginAllowed } from '@/lib/staff-request-origin';
import { mfaJson } from '@/lib/staff-mfa-http.server';
import { resetStaffMfa } from '@/lib/staff-mfa-recovery.server';

export const runtime = 'nodejs';
export async function POST(request: Request) {
    if (!staffRequestOriginAllowed(request)) {
        return mfaJson({ error: 'forbidden' }, 403);
    }
    try {
        const context = await staffApiContext();
        const denied = staffGateResponse(context);
        if (denied) return denied;
        const body = await request.json().catch(() => null);
        const result = await resetStaffMfa(context.pool, context.identity, context.organizationId, body);
        return mfaJson({ ok: true, result });
    } catch (error) {
        const failure = error as { code?: string; retryAfter?: number };
        if (failure.code === 'MFA_INVALID') return mfaJson({ error: 'Enter a fresh code from your authenticator.' }, 401);
        if (failure.code === 'MFA_LIMIT') return mfaJson({ error: 'Too many attempts. Try again later.' }, 429,
            { 'retry-after': String(failure.retryAfter) });
        try { return staffErrorResponse(error); }
        catch { return mfaJson({ error: 'Recovery is temporarily unavailable. Please try again.' }, 503); }
    }
}
