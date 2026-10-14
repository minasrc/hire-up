// Fixed processing capacity shared across owner-scoped queues. No tenant token
// is ever reused for another owner, and private pending results stay separated.
export function createProcessingPool({ createWorkers, limits = { extraction: 2, cv: 1, semantic: 2 }, now = Date.now, output = () => {} }) {
  if (Object.keys(limits).length !== 3 || ['extraction', 'cv', 'semantic'].some(kind => !Number.isInteger(limits[kind]) || limits[kind] < 1 || limits[kind] > 8)) throw new Error('INVALID_LOCAL_CONFIG');
  const scopes = new Map(), running = new Set(), cursors = new Map();
  let stopped = false;
  const retire = scope => { scope.abort.abort(); scopes.delete(scope.id); };
  return {
    async reconcile(records) {
      if (stopped) return;
      const allowed = new Map(records.map(record => [record.requestId, record]));
      for (const scope of scopes.values()) {
        const record = allowed.get(scope.id);
        if (!record || record.workerId !== scope.workerId || record.tokenSha256 !== scope.tokenSha256) retire(scope);
      }
      // Finish aborted operations before reusing a private pending-state path.
      await Promise.all([...running].filter(task => !scopes.has(task.scope.id)).map(task => task.promise));
      for (const record of records) {
        if (stopped || scopes.has(record.requestId)) continue;
        try {
          const workers = await createWorkers(record);
          if (stopped) return;
          scopes.set(record.requestId, { id: record.requestId, workerId: record.workerId, tokenSha256: record.tokenSha256,
            workers, abort: new AbortController(), next: {}, failures: {}, busy: new Set() });
        } catch { output('PROCESSING_SCOPE_UNAVAILABLE'); }
      }
    },
    tick() {
      if (stopped) return;
      for (const [kind, capacity] of Object.entries(limits)) {
        const ordered = [...scopes.values()];
        if (!ordered.length) continue;
        let available = capacity - [...running].filter(task => task.kind === kind).length;
        const start = (cursors.get(kind) ?? 0) % ordered.length;
        for (let offset = 0; offset < ordered.length && available > 0; offset++) {
          const index = (start + offset) % ordered.length, scope = ordered[index];
          if (scope.busy.has(kind) || (scope.next[kind] ?? 0) > now()) continue;
          scope.busy.add(kind); available--; cursors.set(kind, index + 1);
          const task = { scope, kind };
          running.add(task);
          task.promise = Promise.resolve().then(() => scope.workers[kind].tick({ signal: scope.abort.signal })).then(result => {
            const status = typeof result === 'string' ? result : result?.status;
            scope.failures[kind] = status === 'retry' ? (scope.failures[kind] ?? 0) + 1 : 0;
            scope.next[kind] = now() + (status === 'idle' ? (kind === 'semantic' ? 1000 : 5000)
              : status === 'retry' ? Math.min(30000, 1000 * 2 ** Math.min(scope.failures[kind], 5)) : 50);
          }).catch(() => {
            scope.failures[kind] = (scope.failures[kind] ?? 0) + 1;
            scope.next[kind] = now() + Math.min(30000, 1000 * 2 ** Math.min(scope.failures[kind], 5));
            if (!scope.abort.signal.aborted) output('PROCESSING_JOB_DEFERRED');
          }).finally(() => { scope.busy.delete(kind); running.delete(task); });
        }
      }
    },
    async remove(id) {
      const scope = scopes.get(id); if (scope) retire(scope);
      await Promise.all([...running].filter(task => task.scope.id === id).map(task => task.promise));
    },
    async suspend() {
      for (const scope of scopes.values()) retire(scope);
      await Promise.all([...running].map(task => task.promise));
    },
    async stop() { stopped = true; await this.suspend(); },
    snapshot: () => ({ scopes: scopes.size, running: running.size }),
  };
}
