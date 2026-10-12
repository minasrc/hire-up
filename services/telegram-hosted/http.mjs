export class HostedHttpError extends Error {
  constructor(status) {
    super(status === 401 || status === 403 ? 'ACCESS_DENIED'
      : status === 409 ? 'LEASE_CONFLICT' : 'HOST_UNAVAILABLE');
    this.status = status;
  }
}
export function serviceOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('INVALID_SERVER'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || (url.protocol !== 'https:' && !(url.protocol === 'http:'
      && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) throw new Error('INVALID_SERVER');
  return url.origin;
}
export function createControlClient({ server, serviceToken, fetchImpl = fetch, timeoutMs = 10000 }) {
  const origin = serviceOrigin(server);
  if (!/^[A-Za-z0-9_-]{64}$/.test(serviceToken ?? '')) throw new Error('INVALID_SERVICE_TOKEN');
  return async (action, input = {}) => {
    if (!['heartbeat', 'sync', 'list', 'register'].includes(action)) throw new Error('INVALID_ACTION');
    const body = JSON.stringify({ ...input, action });
    if (Buffer.byteLength(body) > 8192) throw new Error('REQUEST_TOO_LARGE');
    const response = await fetchImpl(`${origin}/api/telegram-hosted/control`, {
      method: 'POST', redirect: 'error', headers: {
        authorization: `Bearer ${serviceToken}`, 'content-type': 'application/json',
      }, body, signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) { await response.body?.cancel(); throw new HostedHttpError(response.status); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('INVALID_HOST_RESPONSE');
    const chunks = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > 65536) throw new Error('RESPONSE_TOO_LARGE');
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { await reader.cancel(); throw new Error('INVALID_HOST_RESPONSE'); }
    finally { reader.releaseLock(); }
  };
}
