import { ConnectorHttpError } from './http.mjs';
import { CV_MAX_BYTES } from './cv-adapter.mjs';

export function createCvHostClient({ server, token, fetchImpl = fetch, timeoutMs = 15000 }) {
  const url = new URL(server);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) throw new Error('INVALID_SERVER');
  if (!/^[A-Za-z0-9_-]{64}$/.test(token)) throw new Error('INVALID_WORKER_TOKEN');
  async function request(action, body, headers, signal) {
    const response = await fetchImpl(`${url.origin}/api/telegram-cv/worker/${action}`, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${token}`, ...headers }, body, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
    if (!response.ok || response.redirected) { await response.body?.cancel(); throw new ConnectorHttpError(response.status); }
    const reader = response.body?.getReader(); if (!reader) throw new Error('INVALID_CV_RESPONSE');
    const chunks = []; let size = 0;
    try {
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 32768) throw new Error('INVALID_CV_RESPONSE'); chunks.push(value); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  return {
    host(action, proof, { signal } = {}) {
      if (!['claim', 'defer'].includes(action)) throw new Error('INVALID_ACTION');
      const body = JSON.stringify(proof); if (Buffer.byteLength(body) > 8192) throw new Error('REQUEST_TOO_LARGE');
      return request(action, body, { 'Content-Type': 'application/json' }, signal);
    },
    upload(proof, bytes, { signal } = {}) {
      const header = Buffer.from(JSON.stringify(proof)).toString('base64url');
      if (header.length > 4096 || !Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > CV_MAX_BYTES || proof.sizeBytes !== bytes.length) throw new Error('INVALID_CV_UPLOAD');
      return request('upload', bytes, { 'Content-Type': 'application/octet-stream', 'X-Telegram-CV-Proof': header }, signal);
    },
  };
}
