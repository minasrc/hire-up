import { staffApiContext, staffGateResponse } from '@/lib/staff-api.server';
import { telegramHostedPrepare, telegramHostedRetire, telegramHostedStatus } from '@/lib/telegram-hosted-operations';
import { telegramHostedConfiguration, telegramHostedFeatureResponse, telegramHostedErrorResponse, telegramHostedJson } from '@/lib/telegram-hosted-http';
import { readTelegramJson, telegramJson, telegramOriginAllowed } from '@/lib/telegram-intake-http';
export const runtime = 'nodejs';
async function handle(request: Request) {
    const disabled = telegramHostedFeatureResponse(); if (disabled) return disabled;
    if (request.method !== 'GET' && !telegramOriginAllowed(request)) return telegramJson({ error: 'Invalid request origin.' }, 403);
    const context = await staffApiContext(); const denied = staffGateResponse(context); if (denied) return denied;
    try {
        const { serviceId } = telegramHostedConfiguration();
        const args = [context.pool, context.identity, context.organizationId, serviceId] as const;
        if (request.method === 'GET') return telegramHostedJson(await telegramHostedStatus(...args));
        const input = await readTelegramJson(request, 1024);
        return telegramHostedJson(input?.action === 'retire' ? await telegramHostedRetire(...args, input) : await telegramHostedPrepare(...args, input));
    } catch (error) { return telegramHostedErrorResponse(error); }
}
export const GET = handle;
export const POST = handle;
