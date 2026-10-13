import { validGrant } from './scheduling.mjs';
import { performance } from 'node:perf_hooks';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A hosted child must never outlive its supervisor's acknowledged service lease.
// Check both clocks: macOS suspend and a wall-clock adjustment must fail closed.
export function createSupervisionGuard({ channel = process, wall = Date.now,
  monotonic = () => performance.now(), onLost, interval = setInterval, clear = clearInterval,
  initialTimeoutMs = 15000, onWake } = {}) {
  let wakeEpoch = null;
  let grant = null, closed = false, timer, initialTimer;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Attach a rejection observer before the caller starts asynchronous imports.
  ready.catch(() => {});
  const lose = () => {
    if (closed) return;
    closed = true;
    clear(timer); clearTimeout(initialTimer);
    rejectReady(new Error('SUPERVISION_LOST'));
    onLost?.();
  };
  const check = () => {
    if (closed) return false;
    if (!channel.connected) { lose(); return false; }
    if (!grant) return false;
    const elapsedWall = wall() - grant.wall;
    const elapsedMono = monotonic() - grant.monotonic;
    if (elapsedWall < -1000 || elapsedMono < 0 || Math.abs(elapsedWall - elapsedMono) > 5000
      || wall() >= grant.deadline || elapsedMono >= grant.budget) { lose(); return false; }
    return true;
  };
  const receive = message => {
    if (closed) return;
    if (!validGrant(message) || message.type !== 'telegram-hosted-lease' || !UUID.test(message.leaseToken ?? '')
      || !Number.isSafeInteger(message.deadline)) { lose(); return; }
    // An expired grant cannot be resurrected by a delayed IPC renewal.
    if (grant && !check()) return;
    const now = wall(), budget = message.deadline - now;
    if (budget <= 0 || budget > 85000 || (grant && grant.leaseToken !== message.leaseToken)) { lose(); return; }
    grant = { leaseToken: message.leaseToken, deadline: message.deadline, wall: now,
      monotonic: monotonic(), budget };
    clearTimeout(initialTimer);
    resolveReady();
    if (message.wakeEpoch !== undefined) {
      const changed = wakeEpoch !== message.wakeEpoch; wakeEpoch = message.wakeEpoch;
      if (changed || Object.values(message.runnable).some(Boolean)) onWake?.();
    }
  };
  channel.on('message', receive);
  channel.on('disconnect', lose);
  timer = interval(check, 250);
  initialTimer = setTimeout(lose, initialTimeoutMs);
  if (!channel.connected) lose();
  return { ready: () => ready, check, close() {
    closed = true; clear(timer); clearTimeout(initialTimer);
    channel.removeListener('message', receive); channel.removeListener('disconnect', lose);
  } };
}
