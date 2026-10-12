import pg from 'pg';
import { databaseTlsConnectionOptions } from '@/lib/database-tls.server';
import { telegramHostedControl } from '@/lib/telegram-hosted-operations';
import { telegramHostedConfiguration, telegramHostedFeatureResponse, telegramHostedAuthorized, telegramHostedErrorResponse, telegramHostedJson } from '@/lib/telegram-hosted-http';
import { readTelegramJson, telegramJson } from '@/lib/telegram-intake-http';
export const runtime = 'nodejs';
let pool: pg.Pool | undefined;
export async function POST(request: Request) {
    const disabled = telegramHostedFeatureResponse(); if (disabled) return disabled;
    try {
        const config = telegramHostedConfiguration();
        if (!telegramHostedAuthorized(request, config.secret)) return telegramJson({ error: 'unauthorized' }, 401);
        pool ??= new pg.Pool({ ...databaseTlsConnectionOptions(config.connectionString, config.caCertificate), max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000 });
        return telegramHostedJson(await telegramHostedControl(pool, config.serviceId, await readTelegramJson(request, 2048)));
    } catch (error) { return telegramHostedErrorResponse(error); }
}
