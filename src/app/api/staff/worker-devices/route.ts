import { staffApiContext, staffGateResponse } from '@/lib/staff-api.server';
import { telegramFeatureResponse, telegramOriginAllowed } from '@/lib/telegram-intake-http';
import { workerDeviceStatus, workerDeviceAction } from '@/lib/worker-pairing-operations';
import { workerPairingJson, workerPairingError, readWorkerPairingJson } from '@/lib/worker-pairing-http';
import { WorkerPairingError } from '@/lib/worker-pairing-contracts';
export const runtime = 'nodejs';
async function handle(request: Request) {
    const disabled = telegramFeatureResponse(); if (disabled) return disabled;
    if (request.method !== 'GET' && !telegramOriginAllowed(request)) return workerPairingError(new WorkerPairingError('INVALID_ORIGIN', 403));
    const context = await staffApiContext(); const denied = staffGateResponse(context); if (denied) return denied;
    const args = [context.pool, context.identity, context.organizationId] as const;
    try {
        if (request.method === 'GET') {
            const q = new URL(request.url).searchParams;
            if (Array.from(q.keys()).some(k => !['pairingId', 'after'].includes(k)) || Array.from(q.keys()).some(k => q.getAll(k).length !== 1)) throw new WorkerPairingError('INVALID_INPUT');
            return workerPairingJson(await workerDeviceStatus(...args, Object.fromEntries(q)));
        }
        return workerPairingJson(await workerDeviceAction(...args, await readWorkerPairingJson(request)));
    } catch (error) { return workerPairingError(error); }
}
export const GET = handle;
export const POST = handle;
