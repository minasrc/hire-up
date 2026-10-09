'use client';

/** @typedef {{ required: boolean, mfa: boolean, source: 'read' | 'save', phase: 'idle' | 'required' | 'updating' | 'retrying', error?: string }} Recovery */
/** @type {Recovery} */
const idle = Object.freeze({ required: false, mfa: false, source: 'read', phase: 'idle' });

// This coordinates browser UI only. It stores no identity, credentials, record
// data or permission decisions. A new server-authorized read proves recovery.
/** @param {(name: string, detail?: { recoverable: boolean }) => void} emit */
export function createStaffAuthRecovery(emit = () => {}) {
    let epoch = 0;
    let timer;
    /** @type {Recovery} */
    let snapshot = idle;
    const listeners = new Set();
    const publish = (next) => { snapshot = next; for (const listener of listeners) listener(); };
    return {
        getSnapshot: () => snapshot,
        getServerSnapshot: () => idle,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        requestEpoch: () => epoch,
        require(status, requestEpoch = epoch, source = 'read') {
            if (![401, 428].includes(status) || requestEpoch !== epoch) return false;
            clearTimeout(timer);
            epoch++;
            publish({ required: true, mfa: status === 428, source, phase: 'required' });
            emit('staff-session-invalidated', { recoverable: true });
            return true;
        },
        beginRetry() {
            if (!snapshot.required || snapshot.phase !== 'required') return null;
            const requestEpoch = ++epoch;
            publish({ ...snapshot, phase: 'updating', error: '' });
            timer = setTimeout(() => {
                if (requestEpoch === epoch && snapshot.required) {
                    epoch++;
                    publish({ ...snapshot, phase: 'required', error: 'Access could not be checked. Please retry.' });
                }
            }, 30_000);
            timer.unref?.();
            return requestEpoch;
        },
        retryReady(requestEpoch) {
            if (requestEpoch !== epoch || snapshot.phase !== 'updating') return;
            publish({ ...snapshot, phase: 'retrying' });
            emit('staff-auth-retry');
        },
        retryFailed(requestEpoch) {
            if (requestEpoch === epoch && snapshot.required) {
                clearTimeout(timer);
                publish({ ...snapshot, phase: 'required', error: 'Access could not be checked. Please retry.' });
            }
        },
        accepted(requestEpoch) {
            if (requestEpoch !== epoch || snapshot.phase !== 'retrying') return;
            clearTimeout(timer);
            // Any outstanding denial from before this proof is now obsolete.
            epoch++;
            publish(idle);
            emit('staff-auth-recovered');
        },
        reset() {
            clearTimeout(timer); epoch++; publish(idle);
        },
    };
}

export const staffAuthRecovery = createStaffAuthRecovery((name, detail) => {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(name, { detail }));
});
