#!/usr/bin/env node
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readPrivateJson, createServiceStore } from './store.mjs';
import { createControlClient } from './http.mjs';
import { createSupervisor } from './supervisor.mjs';
import { acquireLock, unlockStoppedProcess } from '../telegram-connector/vault.mjs';
import { createWakeClient, listenForServiceWake } from './wake.mjs';

const output = code => process.stderr.write(`${new Date().toISOString()} ${code}\n`);
let release, supervisor, watchdog, renewal, wakeListener, stopping = false;
const abort = new AbortController();
const stop = () => { stopping = true; abort.abort(); void supervisor?.stop(); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
process.on('unhandledRejection', () => { output('SERVICE_RUNTIME_FAILED'); process.exitCode = 1; stop(); });
process.on('uncaughtException', () => { output('SERVICE_RUNTIME_FAILED'); process.exitCode = 1; stop(); });
try {
  if (process.versions.node.split('.')[0] !== '22') throw new Error('NODE_22_REQUIRED');
  if (!process.env.TELEGRAM_HOSTED_CONFIG || !isAbsolute(process.env.TELEGRAM_HOSTED_CONFIG)) throw new Error('INVALID_LOCAL_CONFIG');
  const config = readPrivateJson(process.env.TELEGRAM_HOSTED_CONFIG);
  if (!isAbsolute(config.stateDirectory ?? '') || !isAbsolute(config.apiCredentialsFile ?? '')) throw new Error('INVALID_LOCAL_CONFIG');
  const api = readPrivateJson(config.apiCredentialsFile);
  if (!Number.isSafeInteger(api.apiId) || api.apiId < 1 || !/^[a-f0-9]{32}$/i.test(api.apiHash ?? '')) throw new Error('INVALID_TELEGRAM_CONFIG');
  const control = createControlClient(config);
  const store = createServiceStore(config);
  if (process.argv.includes('--unlock-stopped')) {
    unlockStoppedProcess(store.root); output('STOPPED_SERVICE_LOCK_REMOVED');
  } else {
    if (existsSync(join(store.root, 'connector.lock'))) unlockStoppedProcess(store.root);
    release = acquireLock(store.root);
    supervisor = createSupervisor({ control, store, api,
      efficientPolling: true, connectorEntrypoint: resolve(fileURLToPath(new URL('../telegram-connector/run.mjs', import.meta.url))), output });
    let syncing = null, syncAgain = false;
    const sync = () => {
      syncAgain = true;
      if (syncing) return syncing;
      syncing = (async () => {
        do { syncAgain = false; await supervisor.refresh(); await supervisor.reconcile(); }
        while (syncAgain && !stopping && !supervisor.stopped);
      })().finally(() => { syncing = null; });
      return syncing;
    };
    watchdog = setInterval(() => supervisor.watch(), 250);
    renewal = setInterval(() => { void sync().then(() => supervisor.maintain()).then(() => supervisor.cleanupRetired()); }, 10000);
    // Scheduled renewal remains the fallback when the notification channel fails.
    output('SERVICE_STARTED');
    await sync();
    wakeListener = listenForServiceWake({ listen: createWakeClient(config), scope: () => supervisor.wakeScope(),
      refresh: sync, stop, signal: abort.signal, output });
    await supervisor.maintain();
    await supervisor.cleanupRetired();
    while (!stopping && !supervisor.stopped) await delay(1000, undefined, { signal: abort.signal }).catch(() => {});
  }
} catch (error) {
  const safe = new Set(['NODE_22_REQUIRED', 'INVALID_LOCAL_CONFIG', 'INVALID_TELEGRAM_CONFIG',
    'INVALID_SERVER', 'INVALID_SERVICE_TOKEN', 'INVALID_SERVICE_ID', 'LOCAL_SCOPE_CONFLICT',
    'UNSAFE_LOCAL_FILE', 'UNSAFE_LOCAL_DIRECTORY', 'CONNECTOR_ALREADY_LOCKED', 'CONNECTOR_STILL_RUNNING', 'INVALID_LOCK', 'CANNOT_VERIFY_LOCK']);
  output(safe.has(error.message) ? error.message : 'SERVICE_START_FAILED'); process.exitCode = 1;
} finally {
  clearInterval(watchdog); clearInterval(renewal); abort.abort();
  await wakeListener;
  await supervisor?.stop(); release?.();
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
}
