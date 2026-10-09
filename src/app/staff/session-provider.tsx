"use client";

import { useEffect, type ReactNode } from 'react';
import { SessionProvider } from 'next-auth/react';
import { DocumentPreviewProvider } from '@/components/staff-preview/document-preview-provider';
import { staffAuthRecovery } from '@/lib/staff-auth-recovery';
import { StaffAuthRecoveryLifecycle } from './auth-recovery';

// Record previews use the current session to invalidate their in-memory cache.
export function StaffSessionProvider({ children, scope }: { children: ReactNode; scope: string }) {
    useEffect(() => () => staffAuthRecovery.reset(), [scope]);
    return <SessionProvider><StaffAuthRecoveryLifecycle /><DocumentPreviewProvider key={scope} scope={scope}>{children}</DocumentPreviewProvider></SessionProvider>;
}
