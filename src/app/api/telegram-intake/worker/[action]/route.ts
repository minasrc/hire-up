import { databaseTlsConnectionOptions } from '@/lib/database-tls.server';
import pg from 'pg';
import { telegramWorkerOperation } from '@/lib/telegram-worker-operations';
import { readTelegramJson, telegramErrorResponse, telegramFeatureResponse, telegramJson } from '@/lib/telegram-intake-http';

export const runtime = 'nodejs';
let pool: pg.Pool | undefined;

export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }) {
    const disabled = telegramFeatureResponse(); if (disabled) return disabled;
    const { action } = await params;
    if (!['claim', 'complete', 'fail'].includes(action)) return telegramJson({ error: 'not found' }, 404);
    if (request.headers.has('origin')) return telegramJson({ error: 'Worker requests only.' }, 403);
    const authorization = request.headers.get('authorization') ?? '';
    if (!/^Bearer [A-Za-z0-9_-]{64}$/.test(authorization)) return telegramJson({ error: 'unauthorized' }, 401);
    const connectionString = process.env.TELEGRAM_WORKER_DATABASE_URL;
    if (!connectionString) return telegramJson({ error: 'Worker service not configured.' }, 503);
    pool ??= new pg.Pool({ ...databaseTlsConnectionOptions(connectionString, process.env.TELEGRAM_WORKER_DATABASE_CA_CERT), max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000 });
    try {
        const input = await readTelegramJson(request);
        const result = await telegramWorkerOperation(pool, authorization.slice(7), action, input);
        return telegramJson(action === 'claim' ? { job: result } : { ok: true, result });
    } catch (error) { return telegramErrorResponse(error); }
}
