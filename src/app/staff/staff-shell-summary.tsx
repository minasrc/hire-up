'use client';

import { createContext, useContext, useEffect } from 'react';
import type { StaffWorkspaceNotifications } from '@/lib/workspace-types';

export const StaffShellSummaryContext = createContext<
    ((summary: StaffWorkspaceNotifications | null) => void) | null
>(null);

// The server streams this seed after rendering navigation. It carries
// request-cached notification counts, so hydration needs no extra API call.
export function StaffShellSummarySeed({ summary }: { summary: StaffWorkspaceNotifications | null }) {
    const seed = useContext(StaffShellSummaryContext);
    useEffect(() => { seed?.(summary); }, [seed, summary]);
    return null;
}
