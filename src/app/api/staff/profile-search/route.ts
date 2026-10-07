import { staffApiContext, staffGateResponse } from '@/lib/staff-api.server';
import { profileSearchAction, profileSearchStatus } from '@/lib/profile-search-operations';
import { readTelegramJson, telegramErrorResponse, telegramFeatureResponse, telegramJson, telegramOriginAllowed } from '@/lib/telegram-intake-http';
export const runtime = 'nodejs';
async function handle(request: Request) {
    const disabled = telegramFeatureResponse(); if (disabled) return disabled;
    if (request.method !== 'GET' && !telegramOriginAllowed(request)) return telegramJson({ error: 'Invalid request origin.' }, 403);
    const context = await staffApiContext(); const denied = staffGateResponse(context); if (denied) return denied;
    const args = [context.pool, context.identity, context.organizationId] as const;
    try {
        if (request.method === 'GET') {
            const q = new URL(request.url).searchParams;
            if (q.has('includeCv') && !['true', 'false'].includes(q.get('includeCv')!)) return telegramJson({ error: 'Invalid CV filter.' }, 400);
            if (q.has('readyOnly') && !['true', 'false'].includes(q.get('readyOnly')!)) return telegramJson({ error: 'Invalid readiness filter.' }, 400);
            return telegramJson(await profileSearchStatus(...args, { scope: q.get('scope') ?? 'approved', readyOnly: q.get('readyOnly') === 'true', includeCv: q.get('includeCv') === 'true', queryId: q.get('queryId') || null, after: q.get('after') || null }));
        }
        const input = await readTelegramJson(request, 16384);
        return telegramJson(await profileSearchAction(...args, input), input.action === 'search' ? 202 : 200);
    } catch (error) { return telegramErrorResponse(error); }
}
export const GET = handle;
export const POST = handle;
