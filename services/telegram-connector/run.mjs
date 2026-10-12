#!/usr/bin/env node
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLock, unlockStoppedProcess, readPrivateFile, createVault } from './vault.mjs';
import { createHostClient } from './http.mjs';
import { createConnector } from './connector.mjs';
import { createNativeWorker } from './native-worker.mjs';
import { createSourceWork } from './source-work.mjs';
import { createSourceUpdateWorker } from './source-update-worker.mjs';
import { createHistoryWorker } from './history-worker.mjs';
import { createCvWorker } from './cv-worker.mjs';
import { createCvHostClient } from './cv-http.mjs';
import { createConnectedWork } from './connected-work.mjs';
import { connectorCredential } from './paired-credential.mjs';
import { createSupervisionGuard } from './supervision.mjs';

// Teleproto contains a few direct console calls outside its logger. This standalone
// process deliberately emits only fixed operational codes via process.stderr.
for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir']) console[method] = () => {};
const output = (code) => {
  process.stderr.write(`${new Date().toISOString()} ${code}\n`);
  // Only fixed operational codes travel to the supervisor. Never forward SDK
  // output, error messages, account details, credentials or login challenges.
  if (process.env.TELEGRAM_CONNECTOR_SUPERVISED === '1' && process.connected) {
    process.send({ type: 'telegram-connector-status', code }, () => {});
  }
};
let release; let connector; let watchdog; let supervision; let forceStop; let stopping = false;
const sleepController = new AbortController();
const stop = () => { stopping = true; sleepController.abort(); void connector?.stop(); };
process.on('unhandledRejection', () => { output('CONNECTOR_RUNTIME_FAILED'); process.exitCode = 1; stop(); });
process.on('uncaughtException', () => { output('CONNECTOR_RUNTIME_FAILED'); process.exitCode = 1; stop(); });
try {
  if (Number(process.versions.node.split('.')[0]) !== 22) throw new Error('NODE_22_REQUIRED');
  if (process.env.TELEGRAM_CONNECTOR_SUPERVISED === '1') {
    supervision = createSupervisionGuard({ onLost: () => {
      output('SUPERVISION_LOST'); process.exitCode = 1; stop();
      forceStop = setTimeout(() => process.exit(1), 5000);
    } });
    await supervision.ready();
    output('CONNECTOR_INITIALIZING');
  }
  const configPath = process.env.TELEGRAM_CONNECTOR_CONFIG;
  const file = configPath ? JSON.parse(readPrivateFile(resolve(configPath))) : {};
  const config = {
    ...connectorCredential(file, process.env, configPath),
    apiId: Number(process.env.TELEGRAM_API_ID ?? file.apiId),
    apiHash: process.env.TELEGRAM_API_HASH ?? file.apiHash,
    root: resolve(process.env.TELEGRAM_CONNECTOR_STATE_DIR ?? file.stateDirectory ?? join(dirname(fileURLToPath(import.meta.url)), '.runtime')),
  };
  if (process.argv.includes('--unlock-stopped')) {
    unlockStoppedProcess(config.root); output('STOPPED_PROCESS_LOCK_REMOVED');
  } else {
    if (!Number.isSafeInteger(config.apiId) || config.apiId < 1 || !/^[a-f0-9]{32}$/i.test(config.apiHash ?? '')) throw new Error('INVALID_TELEGRAM_CONFIG');
    const connectionHost = createHostClient(config);
    let heartbeatAcknowledged = false;
    const host = async (action, body) => {
      const result = await connectionHost(action, body);
      if (action === 'heartbeat' && !heartbeatAcknowledged) {
        heartbeatAcknowledged = true;
        output('CONNECTOR_HEARTBEAT_ACKNOWLEDGED');
      }
      return result;
    };
    release = acquireLock(config.root);
    const vault = createVault(config);
    output('CONNECTOR_VAULT_READY');
    const { createTelegramFactory } = await import('./telegram-adapter.mjs');
    output('CONNECTOR_ADAPTER_READY');
    const history = createHistoryWorker({ host: createHostClient({ ...config, service: 'history' }), vault });
    const reconcile = createSourceUpdateWorker({ host: createHostClient({ ...config, service: 'source-updates' }), vault });
    const native = createNativeWorker({ host: createHostClient({ ...config, service: 'native' }), vault });
    const updates = createSourceWork({ native, reconcile });
    const cv = createCvWorker({ ...createCvHostClient(config), vault });
    output('CONNECTOR_WORKERS_READY');
    const createTelegram = await createTelegramFactory(config);
    output('CONNECTOR_SDK_READY');
    connector = createConnector({ host, vault, createTelegram, onConnectedTick: createConnectedWork({ history, cv, updates }) });
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    watchdog = setInterval(() => { void connector.checkLease().catch(() => output('LEASE_CLOSED')); }, 1000);
    let failures = 0;
    output('CONNECTOR_STARTED');
    while (!stopping && !connector.stopped && (!supervision || supervision.check())) {
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
  const allowed = new Set(['PAIRED_CREDENTIAL_CONFLICT', 'NODE_22_REQUIRED', 'CONNECTOR_ALREADY_LOCKED', 'CONNECTOR_STILL_RUNNING', 'INVALID_LOCK', 'CANNOT_VERIFY_LOCK', 'UNSAFE_LOCAL_FILE', 'UNSAFE_LOCAL_DIRECTORY', 'INVALID_SERVER', 'INVALID_WORKER_TOKEN', 'INVALID_WORKER_ID', 'INVALID_TELEGRAM_CONFIG']);
  output(allowed.has(error.message) ? error.message : 'CONNECTOR_START_FAILED');
  process.exitCode = 1;
} finally {
  clearInterval(watchdog);
  await connector?.stop();
  release?.();
  supervision?.close();
  clearTimeout(forceStop);
}
