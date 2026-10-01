import 'server-only';
import { cache } from 'react';
import type { StaffWorkspaceCapabilities, StaffWorkspaceSummary } from './workspace-types';
import { getStaffCapabilities, getStaffWorkspace } from './workspace-operations';
import { staffGate } from './staff-gate.server';

// Opt-in timings contain fixed operation labels and elapsed milliseconds only.
async function timedRead<T>(operation: 'summary' | 'capabilities', read: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
        return await read();
    } finally {
        if (process.env.STAFF_PERFORMANCE_LOGS === '1') {
            console.info(JSON.stringify({
                event: 'staff-read', operation,
                durationMs: Math.round(performance.now() - started),
            }));
        }
    }
}

export const loadStaffWorkspace = cache(async () => {
    const gate = await staffGate();
    if (gate.stage !== 'verified') {
        return { gate, summary: null as StaffWorkspaceSummary | null };
    }
    try {
        const summary = await timedRead('summary', () => getStaffWorkspace(
            gate.pool, gate.identity, gate.organizationId));
        return { gate, summary: summary as StaffWorkspaceSummary | null };
    } catch (error) {
        console.error(
            'staff workspace summary failed',
            (error as { code?: string })?.code ?? 'UNKNOWN',
        );
        return { gate, summary: null };
    }
});

// Request-scoped only: role changes are checked again on the next request.
export const loadStaffCapabilities = cache(async () => {
    const gate = await staffGate();
    if (gate.stage !== 'verified') {
        return { gate, capabilities: null as StaffWorkspaceCapabilities | null };
    }
    try {
        const capabilities = await timedRead('capabilities', () => getStaffCapabilities(
            gate.pool, gate.identity, gate.organizationId));
        return { gate, capabilities: capabilities as StaffWorkspaceCapabilities | null };
    } catch (error) {
        console.error('staff capabilities failed', (error as { code?: string })?.code ?? 'UNKNOWN');
        return { gate, capabilities: null };
    }
});
