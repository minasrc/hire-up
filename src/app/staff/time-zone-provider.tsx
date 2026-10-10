'use client';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { staffTimeZone } from '@/lib/staff-dates';
interface StaffTimeZoneState {
    accountId: string;
    savedTimeZone: string | null;
    timeZone: string;
    version: string;
}
const Context = createContext<StaffTimeZoneState>({ accountId: '', savedTimeZone: null, timeZone: 'UTC', version: '0' });
export function StaffTimeZoneProvider({ accountId, savedTimeZone, version, children }: {
    accountId: string; savedTimeZone: string | null; version: string; children: ReactNode;
}) {
    const value = useMemo(() => ({ accountId, savedTimeZone, timeZone: staffTimeZone(savedTimeZone), version }), [accountId, savedTimeZone, version]);
    return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useStaffTimeZone = () => useContext(Context);
