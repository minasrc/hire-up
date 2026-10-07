import { staffApiContext, staffGateResponse } from '@/lib/staff-api.server';
import { telegramConnectionAction, telegramConnectionStatus } from '@/lib/telegram-connection-operations';
import { readTelegramJson, telegramErrorResponse, telegramFeatureResponse, telegramJson, telegramOriginAllowed } from '@/lib/telegram-intake-http';

export const runtime = 'nodejs';
async function handle(request: Request) {
    const disabled = telegramFeatureResponse(); if (disabled) return disabled;
    if (request.method !== 'GET' && !telegramOriginAllowed(request)) return telegramJson({ error: 'Invalid request origin.' }, 403);
    const context = await staffApiContext();
    const denied = staffGateResponse(context); if (denied) return denied;
    const args = [context.pool, context.identity, context.organizationId] as const;
    try {
        return telegramJson(request.method === 'GET' ? await telegramConnectionStatus(...args)
            : await telegramConnectionAction(...args, await readTelegramJson(request, 16384)));
    } catch (error) { return telegramErrorResponse(error); }
}
export const GET = handle;
export const POST = handle;
