#!/usr/bin/env node
import { createHostedCredentialGuard } from '../worker-pairing/hosted-credential.mjs';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLock, unlockStoppedProcess } from '../telegram-connector/vault.mjs';
import { readToken } from '../telegram-extraction-worker/config.mjs';
import { loadConfig } from './config.mjs';
import { SemanticWorkerError } from './constants.mjs';
import { requestJson } from './transport.mjs';
import { createPendingStore } from './store.mjs';
import { createLocalClient } from './local.mjs';
import { createSemanticWorker } from './worker.mjs';

const SAFE = new Set(['INVALID_CONFIG', 'CREDENTIAL_UNAVAILABLE', 'HTTP_UNAVAILABLE', 'INVALID_RESULT', 'CANCELLED', 'CONNECTOR_ALREADY_LOCKED', 'CONNECTOR_STILL_RUNNING', 'CANNOT_VERIFY_LOCK']);
export const safeErrorCode = error => SAFE.has(error?.code ?? error?.message) ? error.code ?? error.message : 'WORKER_ERROR';
export async function main(args = process.argv.slice(2)) {
  if (process.versions.node.split('.')[0] !== '22') throw new SemanticWorkerError('INVALID_CONFIG');
  if (args[0] === '--help') { process.stdout.write('Usage: node services/semantic-worker/cli.mjs [--config /private/config.json] [--once | --unlock]\n'); return; }
  let configPath, once = false, unlock = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) configPath = args[++i];
    else if (args[i] === '--once') once = true;
    else if (args[i] === '--unlock') unlock = true;
    else throw new SemanticWorkerError('INVALID_CONFIG');
  }
  const config = await loadConfig(configPath);
  if (unlock) { unlockStoppedProcess(config.stateDirectory); return; }
  const release = acquireLock(config.stateDirectory), shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const credential = await createHostedCredentialGuard(config, readToken);
    const workerToken = credential.workerToken;
    const host = async (action, body, { signal } = {}) => {
      await credential.check();
      return requestJson(`${config.serverUrl}/api/profile-search/worker/${action}`, workerToken, body, { signal, timeoutMs: action === 'complete' ? 20000 : 10000 });
    };
    const worker = createSemanticWorker({ host, ...createLocalClient(config), vault: createPendingStore({ root: config.stateDirectory, server: config.serverUrl, workerToken }) });
    let failures = 0;
    do {
      let pause;
      try {
        const { status } = await worker.tick({ signal: shutdown.signal });
        if (status === 'retry') pause = Math.min(30000, 500 * 2 ** Math.min(++failures, 6));
        else { failures = 0; pause = status === 'idle' ? 500 : 0; }
        if (once) process.stdout.write(`${status}\n`);
      } catch (error) {
        if (shutdown.signal.aborted) break;
        process.stderr.write(`${safeErrorCode(error)}\n`);
        if (once || error.code === 'CREDENTIAL_UNAVAILABLE' || [401, 403].includes(error.status)) throw new SemanticWorkerError(safeErrorCode(error));
        pause = Math.min(30000, 1000 * 2 ** Math.min(++failures, 5));
      }
      if (!once && !shutdown.signal.aborted) await delay(pause, undefined, { signal: shutdown.signal }).catch(() => {});
    } while (!once && !shutdown.signal.aborted);
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); release();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`${safeErrorCode(error)}\n`); process.exitCode = 1; });
}
