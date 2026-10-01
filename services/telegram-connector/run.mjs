#!/usr/bin/env node
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLock, unlockStoppedProcess, readPrivateFile, createVault } from './vault.mjs';
import { createHostClient } from './http.mjs';
import { createConnector } from './connector.mjs';

// Teleproto contains a few direct console calls outside its logger. This standalone
// process deliberately emits only fixed operational codes via process.stderr.
for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir']) console[method] = () => {};
const output = (code) => process.stderr.write(`${new Date().toISOString()} ${code}\n`);
let release; let connector; let watchdog; let stopping = false;
const sleepController = new AbortController();
const stop = () => { stopping = true; sleepController.abort(); void connector?.stop(); };
process.on('unhandledRejection', () => { output('CONNECTOR_RUNTIME_FAILED'); process.exitCode = 1; stop(); });
process.on('uncaughtException', () => { output('CONNECTOR_RUNTIME_FAILED'); process.exitCode = 1; stop(); });
try {
  if (Number(process.versions.node.split('.')[0]) !== 22) throw new Error('NODE_22_REQUIRED');
  const configPath = process.env.TELEGRAM_CONNECTOR_CONFIG;
  const file = configPath ? JSON.parse(readPrivateFile(resolve(configPath))) : {};
  const config = {
    server: process.env.TELEGRAM_CONNECTOR_SERVER ?? file.server,
    workerId: process.env.TELEGRAM_CONNECTOR_WORKER_ID ?? file.workerId,
    token: process.env.TELEGRAM_CONNECTOR_TOKEN ?? file.token,
    apiId: Number(process.env.TELEGRAM_API_ID ?? file.apiId),
    apiHash: process.env.TELEGRAM_API_HASH ?? file.apiHash,
    root: resolve(process.env.TELEGRAM_CONNECTOR_STATE_DIR ?? file.stateDirectory ?? join(dirname(fileURLToPath(import.meta.url)), '.runtime')),
  };
  if (process.argv.includes('--unlock-stopped')) {
    unlockStoppedProcess(config.root); output('STOPPED_PROCESS_LOCK_REMOVED');
  } else {
    if (!Number.isSafeInteger(config.apiId) || config.apiId < 1 || !/^[a-f0-9]{32}$/i.test(config.apiHash ?? '')) throw new Error('INVALID_TELEGRAM_CONFIG');
    const host = createHostClient(config);
    release = acquireLock(config.root);
    const vault = createVault(config);
    const { createTelegramFactory } = await import('./telegram-adapter.mjs');
    connector = createConnector({ host, vault, createTelegram: await createTelegramFactory(config) });
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    watchdog = setInterval(() => { void connector.checkLease().catch(() => output('LEASE_CLOSED')); }, 1000);
    let failures = 0;
    output('CONNECTOR_STARTED');
    while (!stopping && !connector.stopped) {
      try { await connector.tick(); failures = 0; }
      catch (error) {
        output(error.message === 'ACCESS_DENIED' ? 'ACCESS_DENIED' : 'HOST_UNAVAILABLE');
        if (error.message === 'ACCESS_DENIED') process.exitCode = 1;
        failures = Math.min(failures + 1, 5);
      }
      if (!stopping && !connector.stopped) await delay(failures ? Math.min(30000, 1000 * 2 ** failures) + Math.floor(Math.random() * 500) : 1000, undefined, { signal: sleepController.signal }).catch(() => {});
    }
  }
} catch (error) {
  const allowed = new Set(['NODE_22_REQUIRED', 'CONNECTOR_ALREADY_LOCKED', 'CONNECTOR_STILL_RUNNING', 'INVALID_LOCK', 'CANNOT_VERIFY_LOCK', 'UNSAFE_LOCAL_FILE', 'UNSAFE_LOCAL_DIRECTORY', 'INVALID_SERVER', 'INVALID_WORKER_TOKEN', 'INVALID_WORKER_ID', 'INVALID_TELEGRAM_CONFIG']);
  output(allowed.has(error.message) ? error.message : 'CONNECTOR_START_FAILED');
  process.exitCode = 1;
} finally {
  clearInterval(watchdog);
  await connector?.stop();
  release?.();
}
