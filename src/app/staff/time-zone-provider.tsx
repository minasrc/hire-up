'use client';
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { staffTimeZone } from '@/lib/staff-dates';
import { staffAuthRecovery } from '@/lib/staff-auth-recovery';
import { createStaffTimeZoneModel, type TimeZonePreference, type TimeZonePrompt, type TimeZoneSnapshot } from './time-zone-model';
interface StaffTimeZoneControls { prompt: TimeZonePrompt | null; saving: boolean; error: string; errorKind: 'conflict' | 'access' | 'request' | null; saveTimeZone: (zone: string, source?: 'device' | 'manual') => Promise<boolean>; keepCurrentZone: () => void; reload: () => void }
interface ProviderProps { accountId: string; savedTimeZone: string | null; version: string; children: ReactNode }
interface DateStore { accountId: string; subscribe: (listener: () => void) => () => void; getSnapshot: () => TimeZonePreference; getServerSnapshot: () => TimeZonePreference }
const defaultPreference: TimeZonePreference = { timeZone: null, version: '0' };
const DateContext = createContext<DateStore>({ accountId: '', subscribe: () => () => {}, getSnapshot: () => defaultPreference, getServerSnapshot: () => defaultPreference });
interface ControlsStore {
    subscribe: (listener: () => void) => () => void;
    getSnapshot: () => TimeZoneSnapshot;
    getServerSnapshot: () => TimeZoneSnapshot;
    saveTimeZone: StaffTimeZoneControls['saveTimeZone'];
    keepCurrentZone: () => void;
    reload: () => void;
}
const defaultControls: TimeZoneSnapshot = { preference: defaultPreference, prompt: null, saving: false, error: '', errorKind: null };
const ControlsContext = createContext<ControlsStore>({ subscribe: () => () => {}, getSnapshot: () => defaultControls,
    getServerSnapshot: () => defaultControls, saveTimeZone: async () => false, keepCurrentZone: () => {}, reload: () => {} });
function AccountTimeZoneProvider({ accountId, savedTimeZone, version, children }: ProviderProps) {
    const router = useRouter();
    const [model] = useState(() => createStaffTimeZoneModel({
        accountId, initial: { timeZone: savedTimeZone, version },
        detect: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
        now: () => Date.now(), storage: () => window.localStorage,
        auth: staffAuthRecovery,
        request: async (body, signal) => {
            const response = await fetch('/api/staff/preferences/time-zone', { method: 'POST', headers: { 'content-type': 'application/json', 'x-staff-account-id': accountId }, body: JSON.stringify(body), signal });
            const payload = await response.json().catch(() => null);
            return { ok: response.ok && payload?.ok === true, status: response.status, result: payload?.result,
                code: typeof payload?.code === 'string' ? payload.code : undefined };
        }, refresh: () => router.refresh(),
    }));
    useEffect(() => { model.receive({ timeZone: savedTimeZone, version }); }, [model, savedTimeZone, version]);
    useEffect(() => {
        model.activate();
        const visible = () => { if (document.visibilityState === 'visible') model.detect(); };
        const recovered = () => model.refreshAfterRecovery();
        visible(); document.addEventListener('visibilitychange', visible); window.addEventListener('staff-auth-recovered', recovered);
        return () => { document.removeEventListener('visibilitychange', visible); window.removeEventListener('staff-auth-recovered', recovered); model.deactivate(); };
    }, [model]);
    const dates = useMemo(() => ({ accountId, subscribe: model.subscribe,
        getSnapshot: () => model.getSnapshot().preference,
        getServerSnapshot: () => model.getServerSnapshot().preference }), [accountId, model]);
    const controls = useMemo(() => ({ subscribe: model.subscribe, getSnapshot: model.getSnapshot,
        getServerSnapshot: model.getServerSnapshot, saveTimeZone: model.save,
        keepCurrentZone: model.dismiss, reload: () => router.refresh() }), [model, router]);
    return <DateContext.Provider value={dates}><ControlsContext.Provider value={controls}>{children}</ControlsContext.Provider></DateContext.Provider>;
}
export function StaffTimeZoneProvider(props: ProviderProps) { return <AccountTimeZoneProvider key={props.accountId} {...props} />; }
export function useStaffTimeZone() {
    const store = useContext(DateContext);
    const preference = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
    return useMemo(() => ({ accountId: store.accountId, savedTimeZone: preference.timeZone,
        timeZone: staffTimeZone(preference.timeZone), version: preference.version }), [store.accountId, preference]);
}
export function useStaffTimeZoneControls(): StaffTimeZoneControls {
    const store = useContext(ControlsContext);
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
    return useMemo(() => ({ prompt: snapshot.prompt, saving: snapshot.saving, error: snapshot.error,
        errorKind: snapshot.errorKind, saveTimeZone: store.saveTimeZone,
        keepCurrentZone: store.keepCurrentZone, reload: store.reload }),
        [store, snapshot.prompt, snapshot.saving, snapshot.error, snapshot.errorKind]);
}
