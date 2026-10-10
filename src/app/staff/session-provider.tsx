"use client";

import { useEffect, type ReactNode } from 'react';
import { SessionProvider } from 'next-auth/react';
import { DocumentPreviewProvider } from '@/components/staff-preview/document-preview-provider';
import { staffAuthRecovery } from '@/lib/staff-auth-recovery';
import { StaffAuthRecoveryLifecycle } from './auth-recovery';
import { StaffTimeZoneProvider } from './time-zone-provider';

// Record previews use the current session to invalidate their in-memory cache.
export function StaffSessionProvider({ children, scope, userId, timeZone, timeZoneVersion }: {
    children: ReactNode; scope: string; userId: string; timeZone: string | null; timeZoneVersion: string;
}) {
    useEffect(() => () => staffAuthRecovery.reset(), [scope]);
    return <SessionProvider><StaffAuthRecoveryLifecycle /><StaffTimeZoneProvider key={scope} accountId={userId} savedTimeZone={timeZone} version={timeZoneVersion}><DocumentPreviewProvider key={scope} scope={scope}>{children}</DocumentPreviewProvider></StaffTimeZoneProvider></SessionProvider>;
}
