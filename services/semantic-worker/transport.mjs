import { SemanticWorkerError } from './constants.mjs';

export async function requestJson(url, token, body, { fetchImpl = fetch, signal, timeoutMs = 10000, maxRequestBytes = 262144, maxResponseBytes = 1048576 } = {}) {
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized) > maxRequestBytes) throw new SemanticWorkerError('INVALID_RESULT');
  const deadline = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let response;
  try {
    response = await fetchImpl(url, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: serialized, signal: requestSignal });
    const reader = response.body?.getReader();
    if (!reader) throw new SemanticWorkerError(response.ok ? 'INVALID_RESULT' : 'HTTP_UNAVAILABLE', response.status);
    const buffers = []; let size = 0; let data;
    try {
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > maxResponseBytes) throw new SemanticWorkerError(response.ok ? 'INVALID_RESULT' : 'HTTP_UNAVAILABLE', response.status); buffers.push(value); }
      data = JSON.parse(Buffer.concat(buffers).toString('utf8'));
    } catch (error) { if (error instanceof SemanticWorkerError) throw error; throw new SemanticWorkerError(response.ok ? 'INVALID_RESULT' : 'HTTP_UNAVAILABLE', response.ok ? 0 : response.status); }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (!response.ok || response.redirected) {
      const code = response.status === 422 && ['INPUT_TOO_LONG', 'SOURCE_TOO_LARGE'].includes(data?.detail?.code) ? data.detail.code : 'HTTP_UNAVAILABLE';
      throw new SemanticWorkerError(code, response.status);
    }
    return data;
  } catch (error) {
    await response?.body?.cancel().catch(() => {});
    if (signal?.aborted) throw new SemanticWorkerError('CANCELLED');
    if (deadline.aborted) throw new SemanticWorkerError('HTTP_UNAVAILABLE');
    if (error instanceof SemanticWorkerError) throw error;
    throw new SemanticWorkerError('HTTP_UNAVAILABLE');
  }
}
