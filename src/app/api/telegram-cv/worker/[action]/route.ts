import { databaseTlsConnectionOptions } from '@/lib/database-tls.server';
import pg from 'pg';
import { telegramCvWorkerOperation, uploadTelegramCv } from '@/lib/telegram-cv-operations';
import { decodeCvUploadProof, TELEGRAM_CV_MAX_BYTES, TELEGRAM_CV_PROOF_HEADER } from '@/lib/telegram-cv-contracts';
import { cvStorageFetch } from '@/lib/telegram-cv-storage';
import { createCandidateUploadStorage } from '@/lib/candidate-upload-storage';
import { ClientJobContractError } from '@/lib/client-job-contracts';
import { readTelegramJson, telegramErrorResponse, telegramFeatureResponse, telegramJson } from '@/lib/telegram-intake-http';
export const runtime = 'nodejs';
let pool: pg.Pool | undefined;
async function readBytes(request: Request) {
    const reader = request.body?.getReader(); if (!reader) throw new ClientJobContractError({ cv: 'CV bytes required.' });
    const chunks: Uint8Array[] = []; let length = 0;
    try {
        while (true) {
            const { done, value } = await reader.read(); if (done) break;
            length += value.byteLength;
            if (length > TELEGRAM_CV_MAX_BYTES) { await reader.cancel(); throw new ClientJobContractError({ cv: 'The CV must be 4 MB or smaller.' }); }
            chunks.push(value);
        }
        return Buffer.concat(chunks);
    } finally { reader.releaseLock(); }
}
export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }) {
    const disabled = telegramFeatureResponse(); if (disabled) return disabled;
    const { action } = await params;
    if (!['claim', 'defer', 'upload'].includes(action)) return telegramJson({ error: 'not found' }, 404);
    if (request.headers.has('origin')) return telegramJson({ error: 'Worker requests only.' }, 403);
    const authorization = request.headers.get('authorization') ?? '';
    if (!/^Bearer [A-Za-z0-9_-]{64}$/.test(authorization)) return telegramJson({ error: 'unauthorized' }, 401);
    const connectionString = process.env.TELEGRAM_WORKER_DATABASE_URL;
    if (!connectionString) return telegramJson({ error: 'CV worker not configured.' }, 503);
    pool ??= new pg.Pool({ ...databaseTlsConnectionOptions(connectionString, process.env.TELEGRAM_WORKER_DATABASE_CA_CERT), max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000 });
    try {
        if (action !== 'upload') return telegramJson(await telegramCvWorkerOperation(pool, authorization.slice(7), action, await readTelegramJson(request, 16384)));
        if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/octet-stream') return telegramJson({ error: 'Binary CV body required.' }, 400);
        const proof = decodeCvUploadProof(request.headers.get(TELEGRAM_CV_PROOF_HEADER));
        const storage = createCandidateUploadStorage({ fetch: cvStorageFetch }); if (!storage) return telegramJson({ error: 'CV storage is not configured.' }, 503);
        return telegramJson(await uploadTelegramCv(pool, authorization.slice(7), proof, () => readBytes(request), storage));
    } catch (error) { return telegramErrorResponse(error); }
}
