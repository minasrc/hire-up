import { staffApiContext, staffGateResponse } from '@/lib/staff-api.server';
import { telegramSourceUpdateStatus } from '@/lib/telegram-source-update-operations';
import { telegramErrorResponse, telegramFeatureResponse, telegramJson } from '@/lib/telegram-intake-http';
import { assertUuid } from '@/lib/candidate-profile-contracts';
import { ClientJobContractError } from '@/lib/client-job-contracts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    const disabled = telegramFeatureResponse(); if (disabled) return disabled;
    try {
        const context = await staffApiContext();
        const denied = staffGateResponse(context);
        if (denied) { denied.headers.set('cache-control', 'private, no-store'); return denied; }
        const params = new URL(request.url).searchParams;
        const ids = params.getAll('chatId');
        if (Array.from(params.keys()).some(key => key !== 'chatId') || ids.length < 1 || ids.length > 50) throw new ClientJobContractError({ chatId: 'Request between one and fifty chat identifiers.' });
        const chatIds = ids.map(id => assertUuid(id, 'chatId'));
        if (new Set(chatIds).size !== chatIds.length) throw new ClientJobContractError({ chatId: 'Chat identifiers must be unique.' });
        return telegramJson(await telegramSourceUpdateStatus(context.pool, context.identity, context.organizationId, chatIds));
    } catch (error) { return telegramErrorResponse(error); }
}
