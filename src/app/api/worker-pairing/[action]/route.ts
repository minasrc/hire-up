import pg from 'pg';
import { telegramFeatureResponse } from '@/lib/telegram-intake-http';
import { workerPairingOperation } from '@/lib/worker-pairing-operations';
import { workerPairingJson, workerPairingError, readWorkerPairingJson } from '@/lib/worker-pairing-http';
import { WorkerPairingError } from '@/lib/worker-pairing-contracts';
export const runtime = 'nodejs';
let pool: pg.Pool | undefined;
export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }) {
    const disabled = telegramFeatureResponse(); if (disabled) return disabled;
    const { action } = await params;
    if (!['claim', 'poll'].includes(action)) return workerPairingError(new WorkerPairingError('PAIRING_UNAVAILABLE', 404));
    if (request.headers.has('origin') || request.headers.get('sec-fetch-site') === 'cross-site') return workerPairingError(new WorkerPairingError('INVALID_ORIGIN', 403));
    const connectionString = process.env.TELEGRAM_WORKER_DATABASE_URL;
    if (!connectionString) return workerPairingError(new WorkerPairingError('PAIRING_UNAVAILABLE', 503));
    pool ??= new pg.Pool({ connectionString, max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 2000 });
    const authorization = request.headers.get('authorization') ?? '';
    const prefix = action === 'claim' ? 'PairingInvite ' : 'PairingPoll ';
    const proof = authorization.startsWith(prefix) ? authorization.slice(prefix.length) : '';
    try {
        let body;
        try { body = await readWorkerPairingJson(request); } catch { body = null; }
        return workerPairingJson(await workerPairingOperation(pool, action, proof, body));
    } catch (error) { return workerPairingError(error); }
}
