'use client';

import { createContext, useContext, useEffect } from 'react';
import type { StaffWorkspaceSummary } from '@/lib/workspace-types';

export const StaffShellSummaryContext = createContext<
    ((summary: StaffWorkspaceSummary | null) => void) | null
>(null);

// The server streams this seed after rendering navigation. It shares the
// overview's request-cached summary, so hydration needs no extra API call.
export function StaffShellSummarySeed({ summary }: { summary: StaffWorkspaceSummary | null }) {
    const seed = useContext(StaffShellSummaryContext);
    useEffect(() => { seed?.(summary); }, [seed, summary]);
    return null;
}
