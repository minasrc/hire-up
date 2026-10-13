import { setTimeout as delay } from 'node:timers/promises';
import { HostedHttpError, serviceOrigin } from './http.mjs';
import { hostedWakeInput } from '../../src/lib/telegram-hosted-wake.js';

export function createWakeClient({ server, serviceToken, fetchImpl = fetch }) {
  const origin = serviceOrigin(server);
  if (!/^[A-Za-z0-9_-]{64}$/.test(serviceToken ?? '')) throw new Error('INVALID_SERVICE_TOKEN');
  return async (input, signal) => {
    hostedWakeInput(input);
    const response = await fetchImpl(`${origin}/api/telegram-hosted/wake`, {
      method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${serviceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(input), signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
    });
    if (!response.ok) { await response.body?.cancel(); throw new HostedHttpError(response.status); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('INVALID_WAKE_RESPONSE');
    const chunks = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > 1024) throw new Error('INVALID_WAKE_RESPONSE');
        chunks.push(value);
      }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 3
        || !['protocolVersion', 'cursor', 'changed'].every(key => Object.hasOwn(result, key))
        || result.protocolVersion !== 1 || typeof result.cursor !== 'string' || !/^[a-f0-9]{64}$/.test(result.cursor) || typeof result.changed !== 'boolean') throw new Error();
      return result;
    } catch { await reader.cancel().catch(() => {}); throw new Error('INVALID_WAKE_RESPONSE'); }
    finally { reader.releaseLock(); }
  };
}

// One shared outgoing channel for the service, never one connection per owner.
// Hints cause a normal fenced refresh; they cannot acknowledge or extend a lease.
export async function listenForServiceWake({ listen, scope, refresh, stop, signal, output = () => {},
  wait = (ms, signal) => delay(ms, undefined, { signal }) }) {
  let failures = 0, available = false, deferred = false;
  while (!signal.aborted) {
    const input = scope();
    if (!input) { await wait(250, signal).catch(() => {}); continue; }
    try {
      const result = await listen(input, signal);
      const current = scope();
      if (signal.aborted || !current) break;
      if (!available) { output('SERVICE_WAKE_READY'); available = true; }
      deferred = false; failures = 0;
      // A response from an earlier supervisor instance can never wake its successor.
      if (current.instanceId !== input.instanceId || current.leaseToken !== input.leaseToken) continue;
      if (result.changed) await refresh();
      // Bound reconnect churn even under malformed/noisy upstream notifications.
      await wait(500, signal);
    } catch (error) {
      if (signal.aborted) break;
      if ([401, 403, 409].includes(error.status)) { output('SERVICE_WAKE_ACCESS_DENIED'); await stop(); break; }
      if (!deferred) output('SERVICE_WAKE_DEFERRED');
      deferred = true; available = false;
      failures = Math.min(failures + 1, 5);
      await wait(Math.min(30000, 1000 * 2 ** failures), signal).catch(() => {});
    }
  }
}
