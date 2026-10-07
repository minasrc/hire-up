import pg from 'pg';
import { telegramConnectorOperation } from '@/lib/telegram-connection-operations';
import { readTelegramJson, telegramErrorResponse, telegramFeatureResponse, telegramJson } from '@/lib/telegram-intake-http';

export const runtime = 'nodejs';
let pool: pg.Pool | undefined;
export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }) {
    const disabled = telegramFeatureResponse(); if (disabled) return disabled;
    const { action } = await params;
    if (!['heartbeat', 'claim', 'update'].includes(action)) return telegramJson({ error: 'not found' }, 404);
    if (request.headers.has('origin')) return telegramJson({ error: 'Connector requests only.' }, 403);
    const authorization = request.headers.get('authorization') ?? '';
    if (!/^Bearer [A-Za-z0-9_-]{64}$/.test(authorization)) return telegramJson({ error: 'unauthorized' }, 401);
    const connectionString = process.env.TELEGRAM_WORKER_DATABASE_URL;
    if (!connectionString) return telegramJson({ error: 'Connector not configured.' }, 503);
    pool ??= new pg.Pool({ connectionString, max: 2, idleTimeoutMillis: 10000 });
    try {
        const result = await telegramConnectorOperation(pool, authorization.slice(7), action, await readTelegramJson(request, 16384));
        return telegramJson(action === 'claim' ? { connection: result } : { ok: true });
    } catch (error) { return telegramErrorResponse(error); }
}
