import { ParserError } from './errors.mjs';
export { requestJson } from '../telegram-extraction-worker/transport.mjs';

export function createContentReader({ serverUrl, workerToken, fetchImpl = fetch, checkToken = async () => {} }) {
    return async (proof, { signal } = {}) => {
        await checkToken();
        const deadline = AbortSignal.timeout(15000); const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
        let response; let reader;
        try {
            response = await fetchImpl(`${serverUrl}/api/cv-analysis/worker/content`, { method: 'POST', redirect: 'error', signal: combined, headers: { Authorization: `Bearer ${workerToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(proof) });
            if (!response.ok || response.redirected) { const error = new ParserError('STORAGE_UNAVAILABLE'); error.status = response.status; throw error; }
            const declared = response.headers.get('content-length');
            if (declared != null && (!/^\d+$/u.test(declared) || Number(declared) > 4194304)) throw new ParserError('INVALID_DOCUMENT');
            reader = response.body?.getReader(); if (!reader) throw new ParserError('STORAGE_UNAVAILABLE');
            const chunks = []; let length = 0;
            while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > 4194304) throw new ParserError('INVALID_DOCUMENT'); chunks.push(value); }
            if (!length || declared != null && length !== Number(declared)) throw new ParserError('INVALID_DOCUMENT');
            return Buffer.concat(chunks);
        } catch (error) {
            if (signal?.aborted) throw new ParserError('STOPPED');
            if (error instanceof ParserError) throw error;
            throw new ParserError('STORAGE_UNAVAILABLE');
        } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); if (!reader) await response?.body?.cancel().catch(() => {}); }
    };
}
