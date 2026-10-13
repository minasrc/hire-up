'use client';

import { useState } from 'react';
import { Button } from '@/components/staff-ui/button';

export type WorkspaceChoice = { organizationId: string; name: string; roleName: string; state: 'active' | 'invited' };

export function WorkspaceChooser({ initialWorkspaces }: { initialWorkspaces: WorkspaceChoice[] }) {
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    async function choose(organizationId: string) {
        setBusy(organizationId); setError(null);
        try {
            const response = await fetch('/api/staff/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ action: 'select', organizationId }) });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error ?? 'Unable to choose this workspace.');
            try { localStorage.setItem('staff-workspace-selection-changed', crypto.randomUUID()); } catch { /* Storage may be disabled. API fencing still applies. */ }
            window.location.assign('/staff');
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Unable to choose this workspace.');
            setBusy(null);
        }
    }
    return <div className="space-y-4">
        {error && <p role="alert" className="text-destructive">{error}</p>}
        {initialWorkspaces.length === 0 ? <div className="rounded-lg border p-5 space-y-2">
            <h2 className="font-semibold">No invitations or memberships</h2>
            <p className="text-muted-foreground">Ask the workspace administrator to invite this exact Google email address, then refresh this page.</p>
            <Button variant="outline" onClick={() => window.location.reload()}>Refresh invitations</Button>
        </div> : <ul className="space-y-3">
            {initialWorkspaces.map(workspace => <li key={workspace.organizationId} className="flex flex-wrap items-center justify-between gap-4 rounded-lg border p-5">
                <div><h2 className="font-semibold">{workspace.name}</h2><p className="text-muted-foreground">{workspace.roleName}{workspace.state === 'invited' ? ' · Invitation waiting' : ''}</p></div>
                <Button disabled={busy !== null} onClick={() => choose(workspace.organizationId)}>
                    {busy === workspace.organizationId ? 'Opening…' : workspace.state === 'invited' ? 'Accept invitation' : 'Open workspace'}
                </Button>
            </li>)}
        </ul>}
        <p className="text-sm text-muted-foreground">You may be asked to set up or verify two-step authentication for the selected workspace.</p>
    </div>;
}
