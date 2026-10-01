// Private to one mounted preview provider. Never store record data in a module
// singleton, browser storage, or the HTTP cache.
export function createStaffPreviewCache({ ttl = 15_000, limit = 5 } = {}) {
    const entries = new Map();
    const remove = (key) => {
        const entry = entries.get(key);
        if (!entry) return;
        entries.delete(key);
        clearTimeout(entry.timer);
        entry.controller.abort();
    };
    const clear = () => {
        for (const key of entries.keys()) remove(key);
    };
    const peek = (key) => {
        const entry = entries.get(key);
        if (!entry || entry.value === undefined) return undefined;
        if (entry.expires <= Date.now()) {
            remove(key);
            return undefined;
        }
        // Touch an entry only on use, keeping the cache bounded by recency.
        entries.delete(key);
        entries.set(key, entry);
        return entry.value;
    };
    return {
        clear,
        peek,
        load(key, loader) {
            const cached = peek(key);
            if (cached !== undefined) return Promise.resolve(cached);
            const existing = entries.get(key);
            if (existing) return existing.promise;
            while (entries.size >= limit) remove(entries.keys().next().value);
            const entry = { controller: new AbortController() };
            entries.set(key, entry);
            entry.promise = Promise.resolve().then(() => loader(entry.controller.signal))
                .then((value) => {
                    if (entry.controller.signal.aborted || entries.get(key) !== entry) {
                        throw new DOMException('Preview request superseded', 'AbortError');
                    }
                    entry.value = value;
                    entry.expires = Date.now() + ttl;
                    entry.timer = setTimeout(() => remove(key), ttl);
                    return value;
                }).catch((error) => {
                    // A response from an invalidated session/request must not
                    // report auth loss against a newer authorized preview.
                    if (entries.get(key) !== entry || entry.controller.signal.aborted) {
                        throw new DOMException('Preview request superseded', 'AbortError');
                    }
                    if ([401, 428].includes(error?.status)) {
                        clear();
                    } else {
                        remove(key);
                        if (error?.status === 403) {
                            // A record denial can reflect narrower permissions.
                            // Drop cached data but let other pending reads finish
                            // their own authorization checks.
                            for (const [cachedKey, cached] of entries) {
                                if (cached.value !== undefined) remove(cachedKey);
                            }
                        }
                    }
                    throw error;
                });
            return entry.promise;
        },
    };
}
