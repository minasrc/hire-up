import pg from 'pg';
import { cvAnalysisWorkerOperation, readCvAnalysisContent } from '@/lib/cv-analysis-operations';
import { CV_ANALYSIS_PARSE_BODY_LIMIT } from '@/lib/cv-analysis-contracts';
import { createCandidateUploadStorage } from '@/lib/candidate-upload-storage';
import { readTelegramJson, telegramErrorResponse, telegramFeatureResponse, telegramJson } from '@/lib/telegram-intake-http';
export const runtime = 'nodejs';
let pool: pg.Pool | undefined;
export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }) {
    const disabled = telegramFeatureResponse(); if (disabled) return disabled;
    const { action } = await params;
    if (!['claim', 'content', 'complete', 'fail'].includes(action)) return telegramJson({ error: 'not found' }, 404);
    if (request.headers.has('origin')) return telegramJson({ error: 'Worker requests only.' }, 403);
    const authorization = request.headers.get('authorization') ?? '';
    if (!/^Bearer [A-Za-z0-9_-]{64}$/.test(authorization)) return telegramJson({ error: 'unauthorized' }, 401);
    const connectionString = process.env.TELEGRAM_WORKER_DATABASE_URL;
    if (!connectionString) return telegramJson({ error: 'CV analysis worker not configured.' }, 503);
    pool ??= new pg.Pool({ connectionString, max: 2, idleTimeoutMillis: 10000 });
    try {
        const input = await readTelegramJson(request, action === 'complete' ? CV_ANALYSIS_PARSE_BODY_LIMIT : 16384);
        if (action === 'content') {
            const storage = createCandidateUploadStorage(); if (!storage) return telegramJson({ error: 'Storage unavailable.' }, 503);
            const bytes = await readCvAnalysisContent(pool, authorization.slice(7), input, storage);
            return new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength), 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
        }
        return telegramJson(await cvAnalysisWorkerOperation(pool, authorization.slice(7), action, input));
    } catch (error) { return telegramErrorResponse(error); }
}
