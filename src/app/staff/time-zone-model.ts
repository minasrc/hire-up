import { normalizeStaffTimeZone } from '../../lib/staff-dates.js';
export interface TimeZonePreference { timeZone: string | null; version: string }
export interface TimeZonePrompt { key: string; timeZone: string }
export interface TimeZoneSnapshot {
    preference: TimeZonePreference; saving: boolean; error: string;
    errorKind: 'conflict' | 'access' | 'request' | null; prompt: TimeZonePrompt | null;
}
interface Options {
    accountId: string; initial: TimeZonePreference;
    detect: () => string; now: () => number;
    storage: () => Pick<Storage, 'getItem' | 'setItem'>;
    request: (body: { timeZone: string; expectedVersion: string }, signal: AbortSignal) => Promise<{ ok: boolean; status: number; result: unknown; code?: string }>;
    refresh: () => void;
    auth: { requestEpoch: () => number; getSnapshot: () => { required: boolean }; require: (status: number, epoch: number, source: 'save') => unknown };
}
function preference(value: unknown): TimeZonePreference | null {
    if (!value || typeof value !== 'object') return null;
    const data = value as Record<string, unknown>;
    const zone = data.timeZone === null ? null : normalizeStaffTimeZone(data.timeZone);
    if (data.timeZone !== null && !zone) return null;
    if (typeof data.version !== 'string' || !/^(0|[1-9]\d{0,18})$/.test(data.version)
        || BigInt(data.version) > BigInt('9223372036854775807')) return null;
    return { timeZone: zone, version: data.version };
}
export function timeZoneDismissalKey(accountId: string, saved: string | null, detected: string) {
    const zone = normalizeStaffTimeZone(detected);
    const current = saved === null ? null : normalizeStaffTimeZone(saved);
    if (!accountId || !zone || (saved !== null && (!current || current === zone))) return null;
    return `staff-time-zone-dismissed-v1:${JSON.stringify([accountId, current, zone])}`;
}
export function createStaffTimeZoneModel(options: Options) {
    const initial = preference(options.initial);
    if (!initial) throw new Error('Invalid initial time-zone preference');
    let snapshot: TimeZoneSnapshot = { preference: initial, saving: false, error: '', errorKind: null, prompt: null };
    const serverSnapshot = snapshot;
    const listeners = new Set<() => void>();
    const dismissed = new Set<string>();
    let active = true, generation = 0, lastCheck = -Infinity;
    let detected: string | null = null;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pendingRefresh = false;
    const update = (patch: Partial<TimeZoneSnapshot>) => {
        snapshot = { ...snapshot, ...patch };
        if (active) listeners.forEach(listener => listener());
    };
    const reconcile = () => {
        const key = detected ? timeZoneDismissalKey(options.accountId, snapshot.preference.timeZone, detected) : null;
        let hidden = !!key && dismissed.has(key);
        if (key && !hidden) {
            try { hidden = options.storage().getItem(key) === '1'; } catch {}
        }
        const next = key && !hidden && detected ? { key, timeZone: detected } : null;
        if (next?.key !== snapshot.prompt?.key) update({ prompt: next });
    };
    const dismiss = () => {
        const key = detected ? timeZoneDismissalKey(options.accountId, snapshot.preference.timeZone, detected) : null;
        if (key) {
            if (dismissed.size >= 64) dismissed.delete(dismissed.values().next().value as string);
            dismissed.add(key);
            try { options.storage().setItem(key, '1'); } catch {}
        }
        update({ prompt: null, error: '', errorKind: null });
    };
    const refresh = () => {
        if (options.auth.getSnapshot().required) { pendingRefresh = true; return; }
        pendingRefresh = false;
        try { options.refresh(); }
        catch { update({ error: 'Time zone saved. Reload the page to update the workspace.', errorKind: 'request' }); }
    };
    return {
        getSnapshot: () => snapshot,
        getServerSnapshot: () => serverSnapshot,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        activate() { active = true; if (snapshot.saving) update({ saving: false }); },
        deactivate() { active = false; generation++; controller?.abort(); clearTimeout(timer); pendingRefresh = false; },
        receive(value: TimeZonePreference) {
            const next = preference(value);
            if (!next || BigInt(next.version) < BigInt(snapshot.preference.version)) return;
            if (next.version === snapshot.preference.version && next.timeZone === snapshot.preference.timeZone) return;
            update({ preference: next });
            reconcile();
        },
        detect() {
            if (!active) return;
            const checkedAt = options.now();
            const elapsed = checkedAt - lastCheck;
            if (elapsed >= 0 && elapsed < 60_000) return;
            lastCheck = checkedAt;
            try { detected = normalizeStaffTimeZone(options.detect()); } catch { detected = null; }
            reconcile();
        },
        dismiss,
        refreshAfterRecovery() { if (active && pendingRefresh && !options.auth.getSnapshot().required) refresh(); },
        async save(zone: string, source: 'device' | 'manual' = 'device') {
            if (!active || snapshot.saving) return false;
            const normalized = normalizeStaffTimeZone(zone);
            if (!normalized) { update({ error: 'Choose a supported IANA time zone.', errorKind: 'request' }); return false; }
            if (options.auth.getSnapshot().required) {
                update({ error: 'Restore your access, then retry saving the time zone.', errorKind: 'access' });
                return false;
            }
            if (snapshot.preference.timeZone !== null && snapshot.preference.timeZone === normalized) {
                if (source === 'manual') dismiss();
                return true;
            }
            const request = ++generation;
            const epoch = options.auth.requestEpoch();
            const current = () => active && request === generation;
            controller = new AbortController();
            const signal = controller.signal;
            timer = setTimeout(() => controller?.abort(), 20_000);
            update({ saving: true, error: '', errorKind: null });
            try {
                const response = await options.request({ timeZone: normalized, expectedVersion: snapshot.preference.version }, signal);
                if (!current()) return false;
                if (!response.ok) {
                    if ([401, 428].includes(response.status)) options.auth.require(response.status, epoch, 'save');
                    const conflict = response.status === 409;
                    const access = [401, 428].includes(response.status);
                    update({ error: conflict ? response.code === 'ACCOUNT_CHANGED'
                        ? 'Your signed-in account changed. Reload the workspace before saving.'
                        : 'Your time zone changed in another tab. Reload settings before saving again.'
                        : access ? 'Restore your access, then retry saving the time zone.'
                        : response.status === 403 ? 'You do not have permission to save this preference.'
                        : 'Could not save the time zone. Your current zone has not changed. Please retry.',
                        errorKind: conflict ? 'conflict' : access ? 'access' : 'request' });
                    return false;
                }
                const next = preference(response.result);
                if (!next || next.timeZone !== normalized) {
                    update({ error: 'The saved time zone could not be confirmed. Please retry.', errorKind: 'request' });
                    return false;
                }
                if (BigInt(next.version) >= BigInt(snapshot.preference.version)) update({ preference: next });
                if (source === 'manual') dismiss(); else reconcile();
                refresh();
                return true;
            } catch {
                if (current()) update({ error: 'Could not save the time zone. Your current zone has not changed. Please retry.', errorKind: 'request' });
                return false;
            } finally {
                if (current()) { clearTimeout(timer); controller = null; update({ saving: false }); }
            }
        },
    };
}
