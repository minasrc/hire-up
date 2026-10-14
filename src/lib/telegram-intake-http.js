import { ClientJobContractError } from './client-job-contracts.js';

export const telegramJson = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'private, no-store' } });
export function telegramFeatureResponse() {
    return process.env.TELEGRAM_INTAKE_ENABLED === '1' ? null : telegramJson({ error: 'not found' }, 404);
}
export function telegramOriginAllowed(request, configuredUrl = process.env.NEXTAUTH_URL) {
    if (request.headers.get('sec-fetch-site') === 'cross-site') return false;
    const origin = request.headers.get('origin');
    if (!origin) return true; // Authenticated non-browser clients do not send Origin.
    // Next can see an internal host behind a proxy. Use the configured public
    // auth origin, never an untrusted forwarded-host header, when available.
    try { return new URL(origin).origin === new URL(configuredUrl || request.url).origin; } catch { return false; }
}
export async function readTelegramJson(request, maxBytes = 65536) {
    const reader = request.body?.getReader();
    if (!reader) throw new ClientJobContractError({ input: 'JSON body required.' });
    let length = 0; const chunks = [];
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            length += value.length;
            if (length > maxBytes) { await reader.cancel(); throw new ClientJobContractError({ input: 'Request is too large.' }); }
            chunks.push(Buffer.from(value));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('object required');
        return body;
    } catch (error) {
        if (error instanceof ClientJobContractError) throw error;
        throw new ClientJobContractError({ input: 'Invalid JSON body.' });
    } finally { reader.releaseLock(); }
}
export function telegramErrorResponse(error) {
    if (error instanceof ClientJobContractError) return telegramJson({ error: 'Check the highlighted fields.', fields: error.fieldErrors }, error.code === 'DRAFT_INCOMPLETE' ? 422 : 400);
    const status = { FORBIDDEN: 403, UNAUTHORIZED: 401, '42501': 403, P0002: 404, '40001': 409, '23505': 409, '22023': 400, '23514': 422 }[error?.code];
    if (status) return telegramJson({ error: status === 409 ? 'The draft changed. Refresh before retrying.' : 'Operation rejected.', code: error.code }, status);
    // Only a bounded error code is logged; never text, tokens or SQL parameters.
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : 'UNKNOWN';
    console.error('telegram operation failed', { code });
    return telegramJson({ error: 'Temporarily unavailable. Please retry.' }, 503);
}
