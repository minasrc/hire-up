import { staffApiContext, staffGateResponse } from '@/lib/staff-api.server';
import { telegramSourceUpdateStatus } from '@/lib/telegram-source-update-operations';
import { telegramErrorResponse, telegramFeatureResponse, telegramJson } from '@/lib/telegram-intake-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
    const disabled = telegramFeatureResponse(); if (disabled) return disabled;
    const context = await staffApiContext();
    const denied = staffGateResponse(context);
    if (denied) { denied.headers.set('cache-control', 'private, no-store'); return denied; }
    try {
        return telegramJson(await telegramSourceUpdateStatus(context.pool, context.identity, context.organizationId));
    } catch (error) { return telegramErrorResponse(error); }
}
