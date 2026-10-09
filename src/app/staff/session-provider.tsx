"use client";

import type { ReactNode } from 'react';
import { SessionProvider } from 'next-auth/react';
import { DocumentPreviewProvider } from '@/components/staff-preview/document-preview-provider';

// Record previews use the current session to invalidate their in-memory cache.
export function StaffSessionProvider({ children, scope }: { children: ReactNode; scope: string }) {
    return <SessionProvider><DocumentPreviewProvider scope={scope}>{children}</DocumentPreviewProvider></SessionProvider>;
}
