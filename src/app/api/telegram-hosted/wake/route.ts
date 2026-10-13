import pg from 'pg';
import { databaseTlsConnectionOptions } from '@/lib/database-tls.server';
import { TelegramHostedError } from '@/lib/telegram-hosted-contracts';
import { hostedWakeInput, sessionDatabaseUrl, waitForHostedWake } from '@/lib/telegram-hosted-wake';
import { telegramHostedConfiguration, telegramHostedFeatureResponse, telegramHostedAuthorized, telegramHostedErrorResponse, telegramHostedJson } from '@/lib/telegram-hosted-http';
import { readTelegramJson, telegramJson } from '@/lib/telegram-intake-http';
export const runtime = 'nodejs';
export const maxDuration = 60;
let inflight = 0;
export async function POST(request: Request) {
    const disabled = telegramHostedFeatureResponse(); if (disabled) return disabled;
    let client: pg.Client | undefined, closing: Promise<void> | undefined;
    let admitted = false;
    const close = () => { if (client && !closing) closing = client.end().catch(() => {}); return closing; };
    const controller = new AbortController();
    const abort = () => { controller.abort(); void close(); };
    const onClientError = () => abort();
    request.signal.addEventListener('abort', abort, { once: true });
    const deadline = setTimeout(abort, 45000);
    try {
        const config = telegramHostedConfiguration();
        if (!telegramHostedAuthorized(request, config.secret)) return telegramJson({ error: 'unauthorized' }, 401);
        const input = hostedWakeInput(await readTelegramJson(request, 2048));
        if (inflight >= 2) throw new TelegramHostedError('WAKE_BUSY', 429);
        inflight++; admitted = true;
        if (request.signal.aborted) controller.abort();
        if (controller.signal.aborted) throw new Error('Wake request aborted');
        const connectionString = sessionDatabaseUrl(process.env.TELEGRAM_HOSTED_WAKE_DATABASE_URL ?? config.connectionString);
        client = new pg.Client({ ...databaseTlsConnectionOptions(connectionString, config.caCertificate), connectionTimeoutMillis: 5000, query_timeout: 6000 });
        client.on('error', onClientError);
        await client.connect();
        return telegramHostedJson(await waitForHostedWake(client, config.serviceId, input, { signal: controller.signal }));
    } catch (error) { return telegramHostedErrorResponse(error); }
    finally {
        clearTimeout(deadline); request.signal.removeEventListener('abort', abort);
        await close();
        client?.removeListener('error', onClientError);
        if (admitted) inflight--;
    }
}
