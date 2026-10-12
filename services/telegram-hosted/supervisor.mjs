import { validRunnable, validWake } from '../telegram-connector/scheduling.mjs';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fork } from 'node:child_process';
import { validateRequest } from './store.mjs';
import { unlockStoppedProcess } from '../telegram-connector/vault.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CONNECTOR_STATUS_CODES = Object.freeze(['CONNECTOR_INITIALIZING', 'CONNECTOR_VAULT_READY', 'CONNECTOR_ADAPTER_READY', 'CONNECTOR_WORKERS_READY', 'CONNECTOR_SDK_READY', 'CONNECTOR_HEARTBEAT_ACKNOWLEDGED', 'CONNECTOR_STARTED', 'CONNECTOR_START_FAILED',
  'CONNECTOR_RUNTIME_FAILED', 'SUPERVISION_LOST', 'ACCESS_DENIED', 'HOST_UNAVAILABLE', 'LEASE_CLOSED',
  'PAIRED_CREDENTIAL_CONFLICT', 'NODE_22_REQUIRED', 'CONNECTOR_ALREADY_LOCKED', 'CONNECTOR_STILL_RUNNING',
  'INVALID_LOCK', 'CANNOT_VERIFY_LOCK', 'UNSAFE_LOCAL_FILE', 'UNSAFE_LOCAL_DIRECTORY', 'INVALID_SERVER',
  'INVALID_WORKER_TOKEN', 'INVALID_WORKER_ID', 'INVALID_TELEGRAM_CONFIG']);
export function connectorStatusCode(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)
    || Object.keys(message).length !== 2 || !Object.hasOwn(message, 'type') || !Object.hasOwn(message, 'code')
    || message.type !== 'telegram-connector-status' || typeof message.code !== 'string'
    || !CONNECTOR_STATUS_CODES.includes(message.code)) return null;
  return message.code;
}
export function launchConnector(entrypoint, record, grant) {
  // A crashed child can leave its PID lock. Never unlock a live process.
  if (existsSync(join(record.stateDirectory, 'connector.lock'))) unlockStoppedProcess(record.stateDirectory);
  const child = fork(entrypoint, [], {
    execPath: process.execPath, execArgv: [],
    env: { PATH: process.env.PATH, HOME: process.env.HOME,
      TELEGRAM_CONNECTOR_CONFIG: record.configPath, TELEGRAM_CONNECTOR_SUPERVISED: '1' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  return new Promise((resolve, reject) => {
    child.on('error', () => reject(new Error('CONNECTOR_START_FAILED')));
    child.once('spawn', () => {
      if (!child.connected) { child.kill('SIGTERM'); reject(new Error('CONNECTOR_START_FAILED')); return; }
      child.send(grant, error => {
        if (error) { child.kill('SIGTERM'); reject(new Error('CONNECTOR_START_FAILED')); }
        else resolve(child);
      });
    });
  });
}
const childStopped = child => child.exitCode !== null || child.signalCode !== null;
export function terminateChild(child) {
  return new Promise(resolve => {
    if (childStopped(child) || !child.pid) { resolve(); return; }
    let killTimer;
    child.once('exit', () => { clearTimeout(killTimer); resolve(); });
    child.kill('SIGTERM');
    // Do not release ownership until exit is observed, including forced exit.
    killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
  });
}

export function createSupervisor({ control, store, api, connectorEntrypoint,
  spawn = launchConnector, terminate = terminateChild, wall = Date.now,
  monotonic = () => performance.now(), output = () => {}, maxProcesses = 10, efficientPolling = false }) {
  const instanceId = randomUUID(), children = new Map(), backoff = new Map();
  let pendingSnapshot = null;
  const hints = new Map();
  let lease = null, proof = null, closed = false, refreshing = false, reconciling = false, shutdown;
  const grantMessage = id => ({ type: 'telegram-hosted-lease', leaseToken: proof, deadline: lease.deadline, ...(hints.get(id) ?? {}) });
  const validateSnapshot = response => {
    if (!response || !Array.isArray(response.requests) || response.requests.length > 10 || response.nextAfter !== null) throw new Error('INVALID_HOST_RESPONSE');
    const ids = new Set();
    for (const item of response.requests) {
      validateRequest(item);
      if (efficientPolling && (Object.keys(item).length !== 10 || Object.keys(item).some(key => !['requestId','organizationId','ownerUserId','workerId','tokenSha256','state','canRun','wakeEpoch','demand','runnable'].includes(key)))) throw new Error('INVALID_HOST_RESPONSE');
      if (ids.has(item.requestId) || (efficientPolling && (!validWake(item.wakeEpoch) || !validRunnable(item.runnable) || item.demand !== 'run'))) throw new Error('INVALID_HOST_RESPONSE');
      ids.add(item.requestId);
    }
  };
  const valid = () => {
    if (closed || !lease) return false;
    const elapsedWall = wall() - lease.wall, elapsedMono = monotonic() - lease.monotonic;
    return elapsedWall >= -1000 && elapsedMono >= 0 && Math.abs(elapsedWall - elapsedMono) <= 5000
      && wall() < lease.deadline && elapsedMono < lease.budget;
  };
  const stop = () => {
    if (shutdown) return shutdown;
    closed = true;
    shutdown = Promise.all([...children.values()].map(async ({ child }) => {
      await terminate(child);
    })).then(() => { children.clear(); output('SERVICE_STOPPED'); });
    return shutdown;
  };
  const watch = () => {
    if (!closed && lease && !valid()) { output('SERVICE_LEASE_LOST'); void stop(); }
  };
  const refresh = async () => {
    if (closed || refreshing) return;
    refreshing = true;
    const started = wall(), startedMono = monotonic();
    try {
      const result = await control(efficientPolling ? 'sync' : 'heartbeat', { instanceId, ...(proof ? { leaseToken: proof } : {}) });
      if (closed) return;
      if (!UUID.test(result?.leaseToken ?? '') || !Number.isInteger(result.leaseSeconds)
        || result.leaseSeconds < 1 || result.leaseSeconds > 90
        || !Number.isInteger(result.capacity) || result.capacity < 1 || result.capacity > 10
        || (proof && proof !== result.leaseToken)) throw new Error('INVALID_HOST_RESPONSE');
      if (efficientPolling) {
        if (Object.keys(result).length !== 6 || Object.keys(result).some(key => !['leaseToken','leaseSeconds','capacity','protocolVersion','requests','nextAfter'].includes(key)) || result.protocolVersion !== 1) throw new Error('INVALID_HOST_RESPONSE');
        validateSnapshot(result);
      }
      proof = result.leaseToken;
      // Use request start, not response time. A lost acknowledgement never
      // extends the last locally acknowledged lease or grants children access.
      const budget = result.leaseSeconds * 1000 - 15000;
      if (budget <= 0 && !lease) return;
      const next = { deadline: started + budget, wall: started, monotonic: startedMono, budget };
      // A late renewal cannot resurrect an expired local generation.
      if (lease && !valid()) { await stop(); return; }
      lease = next;
      if (!valid()) { await stop(); return; }
      if (efficientPolling) {
        pendingSnapshot = result;
        hints.clear();
        for (const item of result.requests) hints.set(item.requestId, { wakeEpoch: item.wakeEpoch, runnable: item.runnable });
      }
      for (const [id, { child }] of children) {
        const fail = async () => {
          output('CONNECTOR_IPC_FAILED');
          await terminate(child);
          for (const [id, entry] of children) if (entry.child === child) children.delete(id);
        };
        if (!child.connected) { void fail(); continue; }
        try { child.send(grantMessage(id), error => { if (error) void fail(); }); }
        catch { void fail(); }
      }
    } catch (error) {
      output(['ACCESS_DENIED', 'LEASE_CONFLICT'].includes(error.message) ? error.message : 'SERVICE_HOST_UNAVAILABLE');
      if (['ACCESS_DENIED', 'INVALID_HOST_RESPONSE'].includes(error.message)
        || (proof && error.message === 'LEASE_CONFLICT')) await stop();
    } finally { refreshing = false; }
  };
  const reconcile = async () => {
    if (reconciling || !valid()) return;
    reconciling = true;
    const token = proof;
    try {
      const response = efficientPolling ? pendingSnapshot : await control('list', { instanceId, leaseToken: token });
      if (!response) return;
      if (efficientPolling) pendingSnapshot = null;
      if (!valid() || token !== proof) return;
      validateSnapshot(response);
      // Validate the complete response before changing any running children.
      const allowed = new Set(response.requests.filter(item => item.canRun).map(item => item.requestId));
      for (const [id, entry] of children) {
        if (!allowed.has(id)) { await terminate(entry.child); children.delete(id); output('CONNECTOR_STOPPED'); }
      }
      for (const item of response.requests) {
        if (!valid()) return;
        if (!item.canRun || item.state === 'stopped' || children.has(item.requestId)) continue;
        if (children.size >= maxProcesses || (backoff.get(item.requestId)?.next ?? 0) > wall()) continue;
        try {
          const record = store.prepare(item, api);
          const registered = await control('register', { instanceId, leaseToken: token,
            requestId: item.requestId, workerId: record.workerId, tokenSha256: record.tokenSha256 });
          if (!valid() || token !== proof) return;
          if (registered?.workerId !== record.workerId || registered.state !== 'registered') throw new Error('REGISTRATION_CONFLICT');
          const child = await spawn(connectorEntrypoint, record, grantMessage(item.requestId));
          if (!valid() || token !== proof) { await terminate(child); return; }
          if (childStopped(child)) throw new Error('CONNECTOR_START_FAILED');
          children.set(item.requestId, { child, record, startedAt: wall() });
          output('CONNECTOR_SPAWNED');
          child.on('message', message => {
            const code = connectorStatusCode(message);
            if (code && children.get(item.requestId)?.child === child) output(code);
          });
          child.once('exit', () => {
            if (children.get(item.requestId)?.child !== child) return;
            const entry = children.get(item.requestId);
            children.delete(item.requestId);
            const healthy = entry && wall() - entry.startedAt >= 60000;
            const failures = healthy ? 1 : Math.min((backoff.get(item.requestId)?.failures ?? 0) + 1, 6);
            backoff.set(item.requestId, { failures, next: wall() + Math.min(60000, 1000 * 2 ** failures) });
            output('CONNECTOR_EXITED');
          });
        } catch (error) {
          const failures = Math.min((backoff.get(item.requestId)?.failures ?? 0) + 1, 6);
          backoff.set(item.requestId, { failures, next: wall() + Math.min(60000, 1000 * 2 ** failures) });
          const safe = new Set(['LOCAL_CREDENTIAL_MISSING', 'LOCAL_SCOPE_CONFLICT', 'LOCAL_CONFIG_CONFLICT',
            'UNSAFE_LOCAL_FILE', 'UNSAFE_LOCAL_DIRECTORY', 'CONNECTOR_STILL_RUNNING', 'CANNOT_VERIFY_LOCK', 'REGISTRATION_CONFLICT']);
          output(safe.has(error.message) ? error.message : 'CONNECTOR_PREPARATION_FAILED');
        }
      }
    } catch (error) {
      output('SERVICE_RECONCILIATION_FAILED');
      if (['ACCESS_DENIED', 'LEASE_CONFLICT', 'INVALID_HOST_RESPONSE'].includes(error.message)) await stop();
    } finally { reconciling = false; }
  };
  return { refresh, reconcile, watch, stop,
    get stopped() { return closed; },
    snapshot: () => ({ leaseAcknowledged: valid(), runningConnectors: children.size, instanceId }),
  };
}
