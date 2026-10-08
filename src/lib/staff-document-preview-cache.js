// One authenticated workspace owns this cache. It retains resources, never
// permission decisions: every acquire validates with the server, even on a hit.
export function createDocumentPreviewCache({ limit = 3, maxBytes = 12 * 1024 * 1024, ttl = 60_000 } = {}) {
    const entries = new Map();
    const listeners = new Set();
    const failures = new Map();
    let epoch = 0;
    const aborted = () => new DOMException('Document preview invalidated', 'AbortError');
    const retire = (resource) => {
        if (!resource) return;
        resource.retired = true;
        if (!resource.refs && !resource.disposed) {
            resource.disposed = true;
            try { Promise.resolve(resource.dispose?.()).catch(() => {}); } catch { /* Continue releasing other resources. */ }
        }
    };
    const remove = (key) => {
        const entry = entries.get(key);
        if (!entry) return;
        entries.delete(key);
        clearTimeout(entry.timer);
        entry.controller?.abort();
        retire(entry.resource);
    };
    const notify = () => { epoch++; for (const listener of listeners) listener(); };
    const clear = () => {
        for (const key of entries.keys()) remove(key);
        failures.clear();
        notify();
    };
    const trim = () => {
        const size = () => [...entries.values()].reduce((sum, entry) => sum + (entry.resource?.sizeBytes ?? 0), 0);
        while (entries.size > limit || size() > maxBytes) remove(entries.keys().next().value);
    };
    return {
        clear,
        revalidate() {
            // Hide visible data until access is checked again, retaining completed
            // preparations. Cancel unfinished requests that could have stale access.
            for (const [key, entry] of entries) if (entry.pending) remove(key);
            failures.clear();
            notify();
        },
        getEpoch: () => epoch,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        has(key) { return !!entries.get(key)?.resource; },
        async acquire(key, loader) {
            const denied = failures.get('*') ?? failures.get(key);
            if (denied) throw denied;
            let entry = entries.get(key);
            if (!entry) {
                entry = {};
                entries.set(key, entry);
            }
            // Touch on use; a concurrent subscriber shares the same validation.
            entries.delete(key); entries.set(key, entry);
            clearTimeout(entry.timer);
            // Bound unfinished work too: rapid switches must not start an
            // unlimited number of downloads and PDF workers.
            trim();
            if (!entry.pending) {
                const controller = new AbortController();
                entry.controller = controller;
                const previous = entry.resource;
                entry.pending = Promise.resolve().then(() => loader(previous, controller.signal)).then((result) => {
                    if (controller.signal.aborted || entries.get(key) !== entry) {
                        if (result !== previous) retire(result);
                        throw aborted();
                    }
                    if (!result || !Number.isFinite(result.sizeBytes) || result.sizeBytes < 0 || result.sizeBytes > maxBytes) {
                        if (result !== previous) retire(result);
                        throw new Error('Document preview exceeds the memory limit.');
                    }
                    if (result !== previous) {
                        retire(previous);
                        entry.resource = { ...result, refs: 0, retired: false, disposed: false };
                    }
                    return entry.resource;
                }).catch((error) => {
                    if (controller.signal.aborted || entries.get(key) !== entry) throw aborted();
                    if ([401, 403, 428].includes(error?.status)) {
                        for (const activeKey of entries.keys()) remove(activeKey);
                        // Retain only the denial, preventing invalidation from
                        // causing an automatic retry loop, including across
                        // multiple viewers. Focus/change clears these denials.
                        failures.set(error.status === 403 ? key : '*', error);
                        notify();
                    } else remove(key);
                    throw error;
                }).finally(() => { entry.pending = null; });
            }
            const resource = await entry.pending;
            if (entries.get(key) !== entry || resource.retired) throw aborted();
            resource.refs++;
            clearTimeout(entry.timer);
            entry.timer = setTimeout(() => remove(key), ttl);
            trim();
            let released = false;
            return {
                value: resource.value,
                release() {
                    if (released) return;
                    released = true;
                    resource.refs--;
                    if (resource.retired) retire(resource);
                },
            };
        },
    };
}
