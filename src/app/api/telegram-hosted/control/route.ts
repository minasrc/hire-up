import pg from 'pg';
import { after } from 'next/server';
import { createCandidateUploadStorage } from '@/lib/candidate-upload-storage';
import { cvStorageFetch } from '@/lib/telegram-cv-storage';
import { cleanupHostedTelegramStorage } from '@/lib/telegram-hosted-maintenance';
import { databaseTlsConnectionOptions } from '@/lib/database-tls.server';
import { telegramHostedControl } from '@/lib/telegram-hosted-operations';
import { telegramHostedConfiguration, telegramHostedFeatureResponse, telegramHostedAuthorized, telegramHostedErrorResponse, telegramHostedJson } from '@/lib/telegram-hosted-http';
import { readTelegramJson, telegramJson } from '@/lib/telegram-intake-http';
export const runtime = 'nodejs';
export const maxDuration = 60;
let pool: pg.Pool | undefined;
export async function POST(request: Request) {
    const disabled = telegramHostedFeatureResponse(); if (disabled) return disabled;
    try {
        const config = telegramHostedConfiguration();
        if (!telegramHostedAuthorized(request, config.secret)) return telegramJson({ error: 'unauthorized' }, 401);
        pool ??= new pg.Pool({ ...databaseTlsConnectionOptions(config.connectionString, config.caCertificate), max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000 });
        const input = await readTelegramJson(request, 2048);
        const result = await telegramHostedControl(pool, config.serviceId, input);
        if (input.action === 'maintenance') {
            const storage = createCandidateUploadStorage({ fetch: cvStorageFetch });
            const cleanupPool = pool;
            if (storage) after(() => cleanupHostedTelegramStorage(cleanupPool, config.serviceId, input, storage).then(() => {}, () => {}));
        }
        return telegramHostedJson(result);
    } catch (error) { return telegramHostedErrorResponse(error); }
}
