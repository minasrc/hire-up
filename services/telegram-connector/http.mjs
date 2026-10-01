export class ConnectorHttpError extends Error {
  constructor(status) { super(status === 401 || status === 403 ? 'ACCESS_DENIED' : status === 409 ? 'STALE_TASK' : 'HOST_UNAVAILABLE'); this.status = status; }
}
export function createHostClient({ server, token, fetchImpl = fetch, timeoutMs = 10000 }) {
  const url = new URL(server);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) throw new Error('INVALID_SERVER');
  if (!/^[A-Za-z0-9_-]{64}$/.test(token)) throw new Error('INVALID_WORKER_TOKEN');
  return async (action, body = {}) => {
    if (!['heartbeat', 'claim', 'update'].includes(action)) throw new Error('INVALID_ACTION');
    const serialized = JSON.stringify(body);
    if (Buffer.byteLength(serialized) > 16384) throw new Error('REQUEST_TOO_LARGE');
    const response = await fetchImpl(`${url.origin}/api/telegram-connection/worker/${action}`, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: serialized, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) { await response.body?.cancel(); throw new ConnectorHttpError(response.status); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('INVALID_HOST_RESPONSE');
    const chunks = []; let size = 0;
    try {
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 16384) throw new Error('RESPONSE_TOO_LARGE'); chunks.push(value); }
    } catch (error) { await reader.cancel(); throw error; } finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
}
