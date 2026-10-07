import pg from 'pg';
import { profileSearchWorkerOperation } from '@/lib/profile-search-operations';
import { PROFILE_WORKER_BODY_LIMIT } from '@/lib/profile-search-contracts';
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
    if (!connectionString) return telegramJson({ error: 'Search worker not configured.' }, 503);
    pool ??= new pg.Pool({ connectionString, max: 2, idleTimeoutMillis: 10000 });
    try { return telegramJson(await profileSearchWorkerOperation(pool, authorization.slice(7), action, await readTelegramJson(request, action === 'complete' ? PROFILE_WORKER_BODY_LIMIT : 16384))); }
    catch (error) { return telegramErrorResponse(error); }
}
