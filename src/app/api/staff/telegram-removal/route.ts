import { staffApiContext, staffGateResponse } from '@/lib/staff-api.server';
import { telegramChatRemovalOperation } from '@/lib/telegram-chat-removal-operations';
import { readTelegramJson, telegramErrorResponse, telegramFeatureResponse, telegramJson, telegramOriginAllowed } from '@/lib/telegram-intake-http';

export const runtime = 'nodejs';

export async function POST(request: Request) {
    const disabled = telegramFeatureResponse();
    if (disabled) return disabled;
    if (!telegramOriginAllowed(request)) return telegramJson({ error: 'Invalid request origin.' }, 403);
    const context = await staffApiContext();
    const denied = staffGateResponse(context);
    if (denied) return denied;
    try {
        return telegramJson(await telegramChatRemovalOperation(
            context.pool, context.identity, context.organizationId,
            await readTelegramJson(request, 2048),
        ));
    } catch (error) {
        return telegramErrorResponse(error);
    }
}
