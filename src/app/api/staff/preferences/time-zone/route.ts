import { saveStaffTimeZone } from '@/lib/staff-preferences';
import { staffApiContext, staffGateResponse, staffErrorResponse } from '@/lib/staff-api.server';
import { staffRequestOriginAllowed } from '@/lib/staff-request-origin';
export const runtime = 'nodejs';
const privateResponse = (response: Response) => {
    response.headers.set('cache-control', 'private, no-store');
    return response;
};
export async function POST(request: Request) {
    if (!staffRequestOriginAllowed(request)) return privateResponse(Response.json({ error: 'forbidden' }, { status: 403 }));
    let context;
    try { context = await staffApiContext(); }
    catch { return privateResponse(Response.json({ error: 'preference service unavailable' }, { status: 503 })); }
    const denied = staffGateResponse(context);
    if (denied) return privateResponse(denied);
    const expectedAccount = request.headers.get('x-staff-account-id');
    if (expectedAccount !== null && expectedAccount !== context.principal?.user_id) {
        return privateResponse(Response.json({ error: 'account changed', code: 'ACCOUNT_CHANGED' }, { status: 409 }));
    }
    const body = await request.json().catch(() => null);
    try {
        const result = await saveStaffTimeZone(context.pool, context.identity, context.organizationId, body);
        if (!result) throw new Error('Preference result unavailable');
        return privateResponse(Response.json({ ok: true, result }));
    } catch (error) {
        try { return privateResponse(staffErrorResponse(error)); }
        catch {
            console.error('staff preference save failed', (error as { code?: string })?.code ?? 'UNKNOWN');
            return privateResponse(Response.json({ error: 'preference service unavailable' }, { status: 503 }));
        }
    }
}
