#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLock, unlockStoppedProcess } from '../telegram-connector/vault.mjs';
import { loadConfig, readToken, ExtractionWorkerError } from './config.mjs';
import { requestJson } from './transport.mjs';
import { createProvider } from './provider.mjs';
import { createPendingStore } from './store.mjs';
import { createExtractionWorker } from './worker.mjs';

const SAFE_ERRORS = new Set(['PROVIDER_NOT_CONFIGURED', 'INVALID_CONFIG', 'CREDENTIAL_UNAVAILABLE', 'HTTP_UNAVAILABLE', 'INVALID_RESPONSE', 'INVALID_PAYLOAD', 'INVALID_JOB', 'INVALID_LOCAL_STATE', 'STOPPED', 'CONNECTOR_ALREADY_LOCKED', 'CONNECTOR_STILL_RUNNING', 'CANNOT_VERIFY_LOCK']);
export function safeErrorCode(error) { return SAFE_ERRORS.has(error?.code ?? error?.message) ? error.code ?? error.message : 'WORKER_ERROR'; }
export async function main(args = process.argv.slice(2)) {
  if (process.versions.node.split('.')[0] !== '22') throw new ExtractionWorkerError('INVALID_CONFIG');
  if (args[0] === '--help') {
    process.stdout.write('Usage: node services/telegram-extraction-worker/cli.mjs [--config /private/config.json] [--once | --unlock]\n');
    return;
  }
  let configPath; let once = false; let unlock = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) configPath = args[++i];
    else if (args[i] === '--once') once = true;
    else if (args[i] === '--unlock') unlock = true;
    else throw new ExtractionWorkerError('INVALID_CONFIG');
  }
  const config = await loadConfig(configPath);
  if (unlock) { unlockStoppedProcess(config.stateDirectory); return; }
  const release = acquireLock(config.stateDirectory);
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const workerToken = await readToken(config.workerTokenFile);
    const host = async (action, body, { signal } = {}) => {
      // Revocation/rotation on disk stops this process before it submits data.
      if (await readToken(config.workerTokenFile) !== workerToken) throw new ExtractionWorkerError('CREDENTIAL_UNAVAILABLE');
      return requestJson(`${config.serverUrl}/api/telegram-extraction/worker/${action}`, workerToken, body, { signal, maxRequestBytes: 131072, maxResponseBytes: 262144 });
    };
    const worker = createExtractionWorker({ host, provider: createProvider(config), pendingStore: createPendingStore({ root: config.stateDirectory, server: config.serverUrl, workerToken }) });
    let failures = 0;
    do {
      let pause = 1000;
      try {
        const status = await worker.tick({ signal: shutdown.signal });
        failures = 0;
        pause = status === 'idle' ? 5000 : 50;
        if (once) process.stdout.write(`${status}\n`);
      } catch (error) {
        if (shutdown.signal.aborted) break;
        process.stderr.write(`${safeErrorCode(error)}\n`);
        if (once || ['CREDENTIAL_UNAVAILABLE', 'INVALID_JOB', 'INVALID_LOCAL_STATE'].includes(error.code) || [401, 403].includes(error.status)) throw new ExtractionWorkerError(safeErrorCode(error));
        pause = Math.min(30000, 1000 * 2 ** Math.min(++failures, 5)) + Math.floor(Math.random() * 250);
      }
      if (!once && !shutdown.signal.aborted) await delay(pause, undefined, { signal: shutdown.signal }).catch(() => {});
    } while (!once && !shutdown.signal.aborted);
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    release();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`${safeErrorCode(error)}\n`); process.exitCode = 1; });
}
