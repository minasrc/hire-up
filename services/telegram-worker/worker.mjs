import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export const MODEL = 'intfloat/multilingual-e5-small';
export const INDEX_VERSION = `${MODEL}@614241f622f53c4eeff9890bdc4f31cfecc418b3:e5-prefix:l2:384:v1`;
export const EMBEDDING_URL = 'http://127.0.0.1:8817/v1/embeddings';
const MAX_BODY = 128 * 1024;
const MAX_RESPONSE = 1024 * 1024;
const HTTP_TIMEOUT = 10_000;
const INFERENCE_TIMEOUT = 45_000;

class WorkerError extends Error {
    constructor(code, status = 0) {
        super(code);
        this.code = code;
        this.status = status;
    }
}

function invalid() { throw new WorkerError('INVALID_JOB'); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

export function validateConfig(raw) {
    if (!object(raw)) throw new WorkerError('INVALID_CONFIG');
    let url;
    try { url = new URL(raw.serverUrl); } catch { throw new WorkerError('INVALID_CONFIG'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
        || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && raw.allowInsecureLocalhost === true))
        || typeof raw.workerTokenFile !== 'string' || !raw.workerTokenFile
        || typeof raw.embeddingTokenFile !== 'string' || !raw.embeddingTokenFile) {
        throw new WorkerError('INVALID_CONFIG');
    }
    return { serverUrl: url.origin, workerTokenFile: raw.workerTokenFile, embeddingTokenFile: raw.embeddingTokenFile,
        allowInsecureLocalhost: raw.allowInsecureLocalhost === true };
}

export async function loadConfig(configPath, env = process.env) {
    try {
        const base = configPath ? dirname(resolve(configPath)) : process.cwd();
        const raw = configPath ? JSON.parse(await readFile(configPath, 'utf8')) : {};
        const tokenPath = value => isAbsolute(value) ? value : resolve(base, value);
        const config = validateConfig({
            ...raw,
            serverUrl: env.TELEGRAM_WORKER_SERVER_URL ?? raw.serverUrl,
            workerTokenFile: env.TELEGRAM_WORKER_TOKEN_FILE ?? raw.workerTokenFile,
            embeddingTokenFile: env.TELEGRAM_WORKER_EMBEDDING_TOKEN_FILE ?? raw.embeddingTokenFile
                ?? fileURLToPath(new URL('../local-embeddings/.runtime/token', import.meta.url)),
            allowInsecureLocalhost: env.TELEGRAM_WORKER_ALLOW_INSECURE_LOCALHOST === undefined
                ? raw.allowInsecureLocalhost : env.TELEGRAM_WORKER_ALLOW_INSECURE_LOCALHOST === '1',
        });
        return { ...config, workerTokenFile: tokenPath(config.workerTokenFile), embeddingTokenFile: tokenPath(config.embeddingTokenFile) };
    } catch { throw new WorkerError('INVALID_CONFIG'); }
}

export async function readToken(path) {
    try {
        const info = await stat(path);
        if (!info.isFile() || info.size > 4098 || (info.mode & 0o077)) throw new Error();
        const token = (await readFile(path, 'utf8')).trim();
        if (token.length < 32 || token.length > 4096 || !/^[A-Za-z0-9._~+/-]+={0,2}$/.test(token)) throw new Error();
        return token;
    } catch { throw new WorkerError('CREDENTIAL_UNAVAILABLE'); }
}

// All calls use a fixed destination, refuse redirects and bound both time and body size.
export async function requestJson(url, token, body, { fetchImpl = fetch, signal, timeoutMs = HTTP_TIMEOUT } = {}) {
    const timedSignal = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timedSignal]) : timedSignal;
    let response;
    try {
        response = await fetchImpl(url, {
            method: 'POST', redirect: 'error', signal: requestSignal,
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (response.redirected || (response.status >= 300 && response.status < 400)) throw new WorkerError('HTTP_UNAVAILABLE', response.status);
        if (!response.ok) throw new WorkerError('HTTP_UNAVAILABLE', response.status);
        const reader = response.body?.getReader();
        if (!reader) throw new WorkerError('INVALID_RESPONSE');
        const chunks = [];
        let bytes = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
                if (bytes > MAX_RESPONSE) throw new WorkerError('INVALID_RESPONSE');
                chunks.push(value);
            }
        } finally { await reader.cancel().catch(() => {}); }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
        await response?.body?.cancel().catch(() => {});
        if (error instanceof WorkerError) throw error;
        throw new WorkerError('HTTP_UNAVAILABLE');
    }
}

function validLease(job, now) {
    return object(job) && typeof job.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(job.id)
        && typeof job.leaseToken === 'string' && /^[A-Za-z0-9._~+/-]{16,512}={0,2}$/.test(job.leaseToken)
        && typeof job.leaseExpiresAt === 'string' && Number.isFinite(Date.parse(job.leaseExpiresAt))
        && Date.parse(job.leaseExpiresAt) > now;
}

export function embeddingRequest(job) {
    const payload = job?.payload;
    if (job?.kind !== 'embedding' || !object(payload) || payload.indexVersion !== INDEX_VERSION
        || !['query', 'passage'].includes(payload.inputType) || !Array.isArray(payload.texts)
        || payload.texts.length < 1 || payload.texts.length > 32
        || payload.texts.some(text => typeof text !== 'string' || !text.trim() || [...text].length > 16000)) invalid();
    const request = { model: MODEL, input: payload.texts, input_type: payload.inputType, encoding_format: 'float' };
    if (Buffer.byteLength(JSON.stringify(request)) > MAX_BODY) invalid();
    return request;
}

export function embeddingResult(response, count) {
    if (!object(response) || response.model !== MODEL || response.index_version !== INDEX_VERSION
        || !Array.isArray(response.data) || response.data.length !== count) invalid();
    const embeddings = new Array(count);
    for (const row of response.data) {
        if (!object(row) || !Number.isInteger(row.index) || row.index < 0 || row.index >= count || embeddings[row.index]
            || !Array.isArray(row.embedding) || row.embedding.length !== 384
            || row.embedding.some(value => typeof value !== 'number' || !Number.isFinite(value))) invalid();
        const norm = Math.sqrt(row.embedding.reduce((sum, value) => sum + value * value, 0));
        if (Math.abs(norm - 1) > 0.001) invalid();
        embeddings[row.index] = row.embedding;
    }
    return { indexVersion: INDEX_VERSION, embeddings };
}

export function backoff(attempt, random = Math.random) {
    return Math.round(Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)) * (0.75 + random() * 0.25));
}

export function createWorker(config, {
    fetchImpl = fetch, readTokenImpl = readToken, wait = sleep, now = Date.now, random = Math.random,
    log = status => console.log(status), signal,
} = {}) {
    const checked = validateConfig({ ...config, allowInsecureLocalhost: config.allowInsecureLocalhost });
    const request = (url, token, body, timeoutMs) => requestJson(url, token, body, { fetchImpl, signal, timeoutMs });
    const api = (action, token, body) => request(`${checked.serverUrl}/api/telegram-intake/worker/${action}`, token, body, HTTP_TIMEOUT);
    const pause = ms => wait(ms, undefined, { signal });

    async function acknowledge(action, token, job, detail) {
        // An ACK may have committed before the response was lost. Retry the same
        // fenced operation; never submit failure after uncertain completion.
        for (let attempt = 0; attempt < 3 && !signal?.aborted; attempt++) {
            if (Date.parse(job.leaseExpiresAt) <= now()) return 'LEASE_EXPIRED';
            try {
                const result = await api(action, token, { jobId: job.id, leaseToken: job.leaseToken, ...detail });
                if (result?.ok !== true) throw new WorkerError('INVALID_RESPONSE');
                return action === 'complete' ? 'COMPLETED' : 'FAILED';
            } catch (error) {
                if (error.status === 409) return 'LEASE_EXPIRED';
                if (error.status === 401 || error.status === 403) return 'ACK_UNAVAILABLE';
                if (attempt < 2) await pause(backoff(attempt, random));
            }
        }
        return 'ACK_UNAVAILABLE';
    }

    async function runOnce() {
        try {
            const token = await readTokenImpl(checked.workerTokenFile);
            const claimed = await api('claim', token, {});
            if (!object(claimed) || !Object.hasOwn(claimed, 'job')) return 'INVALID_CLAIM';
            if (claimed.job === null) return 'IDLE';
            const job = claimed.job;
            if (!validLease(job, now())) return 'INVALID_CLAIM';
            let requestBody;
            try { requestBody = embeddingRequest(job); }
            catch { return await acknowledge('fail', token, job, { code: 'INVALID_JOB' }); }
            // Reserve time for inference and one completion request inside the lease.
            if (Date.parse(job.leaseExpiresAt) - now() < INFERENCE_TIMEOUT + HTTP_TIMEOUT) return 'LEASE_EXPIRED';
            let result;
            try {
                const embeddingToken = await readTokenImpl(checked.embeddingTokenFile);
                const response = await request(EMBEDDING_URL, embeddingToken, requestBody, INFERENCE_TIMEOUT);
                result = embeddingResult(response, requestBody.input.length);
            } catch (error) {
                if (signal?.aborted) return 'STOPPED';
                const code = [413, 422].includes(error.status) ? 'INVALID_JOB' : 'EMBEDDING_UNAVAILABLE';
                return await acknowledge('fail', token, job, { code });
            }
            return await acknowledge('complete', token, job, { result });
        } catch { return signal?.aborted ? 'STOPPED' : 'WORKER_UNAVAILABLE'; }
    }

    async function run({ once = false } = {}) {
        let failures = 0;
        do {
            const status = await runOnce();
            log(status);
            if (once || signal?.aborted) return status;
            failures = ['COMPLETED', 'IDLE'].includes(status) ? 0 : Math.min(failures + 1, 5);
            try { await pause(backoff(failures, random)); } catch { return 'STOPPED'; }
        } while (!signal?.aborted);
        return 'STOPPED';
    }
    return { runOnce, run };
}
