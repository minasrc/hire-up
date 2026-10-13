import { createHash, timingSafeEqual } from 'node:crypto';
import { hostedUuid, TelegramHostedError } from './telegram-hosted-contracts.js';
import { telegramJson } from './telegram-intake-http.js';
export function telegramHostedFeatureResponse(env = process.env) {
    return env.TELEGRAM_HOSTED_ENABLED === '1' && env.TELEGRAM_INTAKE_ENABLED === '1' ? null : telegramJson({ error: 'not found' }, 404);
}
export function telegramHostedConfiguration(env = process.env) {
    try { hostedUuid(env.TELEGRAM_HOSTED_SERVICE_ID); } catch { throw new TelegramHostedError('SERVICE_UNAVAILABLE', 503); }
    if (!/^[A-Za-z0-9_-]{64}$/.test(env.TELEGRAM_HOSTED_SERVICE_SECRET ?? '') || !env.TELEGRAM_HOSTED_DATABASE_URL) throw new TelegramHostedError('SERVICE_UNAVAILABLE', 503);
    return { serviceId: env.TELEGRAM_HOSTED_SERVICE_ID, secret: env.TELEGRAM_HOSTED_SERVICE_SECRET, connectionString: env.TELEGRAM_HOSTED_DATABASE_URL, caCertificate: env.TELEGRAM_HOSTED_DATABASE_CA_CERT };
}
export function telegramHostedAuthorized(request, secret) {
    const authorization = request.headers.get('authorization') ?? '';
    if (request.headers.has('origin') || !/^Bearer [A-Za-z0-9_-]{64}$/.test(authorization) || !/^[A-Za-z0-9_-]{64}$/.test(secret ?? '')) return false;
    const hash = v => createHash('sha256').update(v).digest();
    return timingSafeEqual(hash(authorization.slice(7)), hash(secret));
}
export function telegramHostedErrorResponse(error) {
    const status = error instanceof TelegramHostedError ? error.status : ({ FORBIDDEN: 403, UNAUTHORIZED: 401, '42501': 403, '40001': 409, '23505': 409, P0002: 404, '22023': 400, '53300': 429 })[error?.code] ?? (error?.name === 'ClientJobContractError' ? 400 : 503);
    if (error?.code === '55000') return telegramJson({ error: 'Revoke the old session in Telegram Settings → Devices before resetting this connection.', code: 'TELEGRAM_REVOCATION_REQUIRED' }, 409);
    if (error?.code === '53300') return telegramJson({ error: 'Hosted Telegram connection capacity is reached.', code: 'HOSTED_CAPACITY' }, 429);
    return telegramJson({ error: status === 503 ? 'Hosted Telegram is temporarily unavailable.' : 'Hosted Telegram request rejected.' }, status);
}
export function telegramHostedJson(value) {
    if (Buffer.byteLength(JSON.stringify(value)) > 16384) return telegramHostedErrorResponse(new TelegramHostedError('RESPONSE_TOO_LARGE', 503));
    return telegramJson(value);
}
