import { ExtractionWorkerError } from './config.mjs';

export async function requestJson(url, token, body, { fetchImpl = fetch, signal, timeoutMs = 10000, maxRequestBytes = 262144, maxResponseBytes = 262144 } = {}) {
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized) > maxRequestBytes) throw new ExtractionWorkerError('INVALID_PAYLOAD');
  const deadline = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let response;
  try {
    response = await fetchImpl(url, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: serialized, signal: requestSignal });
    if (!response.ok || response.redirected) throw new ExtractionWorkerError('HTTP_UNAVAILABLE', response.status);
    const reader = response.body?.getReader();
    if (!reader) throw new ExtractionWorkerError('INVALID_RESPONSE');
    const buffers = []; let size = 0;
    try {
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > maxResponseBytes) throw new ExtractionWorkerError('INVALID_RESPONSE'); buffers.push(value); }
      return JSON.parse(Buffer.concat(buffers).toString('utf8'));
    } catch (error) { if (error instanceof ExtractionWorkerError) throw error; throw new ExtractionWorkerError('INVALID_RESPONSE'); }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  } catch (error) {
    await response?.body?.cancel().catch(() => {});
    if (signal?.aborted) throw new ExtractionWorkerError('STOPPED');
    if (deadline.aborted) throw new ExtractionWorkerError('HTTP_UNAVAILABLE');
    if (error instanceof ExtractionWorkerError) throw error;
    throw new ExtractionWorkerError('HTTP_UNAVAILABLE');
  }
}
