// A source or mutation response may finish after fetch aborts. Its ticket must
// still belong to the current authorized read before private state is applied.
export function createPrivateSnapshotGuard(authEpoch) {
    let blocked = false;
    const active = new Map();
    return {
        begin(key) {
            if (blocked) return null;
            active.get(key)?.controller.abort();
            const ticket = { key, controller: new AbortController(), epoch: authEpoch() };
            active.set(key, ticket);
            return ticket;
        },
        accepts(ticket) {
            return Boolean(ticket && !blocked && !ticket.controller.signal.aborted
                && active.get(ticket.key) === ticket && ticket.epoch === authEpoch());
        },
        abort(key) { active.get(key)?.controller.abort(); active.delete(key); },
        invalidate() { blocked = true; for (const ticket of active.values()) ticket.controller.abort(); active.clear(); },
        retry() { blocked = false; },
        dispose() { for (const ticket of active.values()) ticket.controller.abort(); active.clear(); },
    };
}
export const privateAccessDenied = status => [401, 403, 428].includes(status);
