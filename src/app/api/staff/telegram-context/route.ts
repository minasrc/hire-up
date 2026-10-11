import { staffApiContext, staffGateResponse } from '@/lib/staff-api.server';
import { telegramContextSearch, telegramContextView } from '@/lib/telegram-context-operations';
import { readTelegramJson, telegramErrorResponse, telegramFeatureResponse, telegramJson, telegramOriginAllowed } from '@/lib/telegram-intake-http';
export const runtime = 'nodejs';
async function handle(request: Request) {
    const disabled = telegramFeatureResponse(); if (disabled) return disabled;
    if (request.method !== 'GET' && !telegramOriginAllowed(request)) return telegramJson({ error: 'Invalid request origin.' }, 403);
    try {
        const context = await staffApiContext(); const denied = staffGateResponse(context); if (denied) { denied.headers.set('cache-control', 'private, no-store'); return denied; }
        const args = [context.pool, context.identity, context.organizationId] as const;
        const params = new URL(request.url).searchParams;
        if (request.method === 'GET' && [...params.keys()].some(k => !['chatId', 'anchor', 'before', 'after'].includes(k))) return telegramJson({ error: 'Invalid conversation request.' }, 400);
        if (request.method === 'GET' && [...params.keys()].some(k => params.getAll(k).length > 1)) return telegramJson({ error: 'Invalid conversation request.' }, 400);
        return telegramJson(request.method === 'GET'
            ? await telegramContextView(...args, Object.fromEntries(params))
            : await telegramContextSearch(...args, await readTelegramJson(request, 8192)));
    } catch (error) { return telegramErrorResponse(error); }
}
export const GET = handle;
export const POST = handle;
