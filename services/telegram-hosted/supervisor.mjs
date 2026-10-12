import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fork } from 'node:child_process';
import { validateRequest } from './store.mjs';
import { unlockStoppedProcess } from '../telegram-connector/vault.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
  monotonic = () => performance.now(), output = () => {}, maxProcesses = 10 }) {
  const instanceId = randomUUID(), children = new Map(), backoff = new Map();
  let lease = null, proof = null, closed = false, refreshing = false, reconciling = false, shutdown;
  const grantMessage = () => ({ type: 'telegram-hosted-lease', leaseToken: proof, deadline: lease.deadline });
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
    if (lease && !valid()) { output('SERVICE_LEASE_LOST'); void stop(); }
  };
  const refresh = async () => {
    if (closed || refreshing) return;
    refreshing = true;
    const started = wall(), startedMono = monotonic();
    try {
      const result = await control('heartbeat', { instanceId, ...(proof ? { leaseToken: proof } : {}) });
      if (closed) return;
      if (!UUID.test(result?.leaseToken ?? '') || !Number.isInteger(result.leaseSeconds)
        || result.leaseSeconds < 1 || result.leaseSeconds > 90
        || !Number.isInteger(result.capacity) || result.capacity < 1 || result.capacity > 10
        || (proof && proof !== result.leaseToken)) throw new Error('INVALID_HOST_RESPONSE');
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
      for (const { child } of children.values()) {
        if (child.connected) child.send(grantMessage(), () => {});
      }
    } catch (error) {
      output(['ACCESS_DENIED', 'LEASE_CONFLICT'].includes(error.message) ? error.message : 'SERVICE_HOST_UNAVAILABLE');
      if (lease && ['ACCESS_DENIED', 'LEASE_CONFLICT', 'INVALID_HOST_RESPONSE'].includes(error.message)) await stop();
    } finally { refreshing = false; }
  };
  const reconcile = async () => {
    if (reconciling || !valid()) return;
    reconciling = true;
    const token = proof;
    try {
      const response = await control('list', { instanceId, leaseToken: token });
      if (!valid() || token !== proof) return;
      if (!response || !Array.isArray(response.requests) || response.requests.length > 10
        || response.nextAfter !== null) throw new Error('INVALID_HOST_RESPONSE');
      const ids = new Set();
      for (const item of response.requests) {
        validateRequest(item);
        if (ids.has(item.requestId)) throw new Error('INVALID_HOST_RESPONSE');
        ids.add(item.requestId);
      }
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
          const child = await spawn(connectorEntrypoint, record, grantMessage());
          if (!valid() || token !== proof) { await terminate(child); return; }
          if (childStopped(child)) throw new Error('CONNECTOR_START_FAILED');
          children.set(item.requestId, { child, record });
          output('CONNECTOR_STARTED');
          child.once('exit', () => {
            if (children.get(item.requestId)?.child !== child) return;
            children.delete(item.requestId);
            const failures = Math.min((backoff.get(item.requestId)?.failures ?? 0) + 1, 6);
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
