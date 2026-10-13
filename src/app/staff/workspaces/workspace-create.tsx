'use client';

import { useRef, useState } from 'react';
import { Button } from '@/components/staff-ui/button';
import { Input } from '@/components/staff-ui/input';
import { Label } from '@/components/staff-ui/label';
import { staffWorkspaceFetch } from '@/lib/staff-workspace-fetch';

type CreatedWorkspace = { organizationId: string; name: string; adminEmail: string; invitationPath: string };

export function WorkspaceCreate({ initialCreated }: { initialCreated: CreatedWorkspace[] }) {
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [created, setCreated] = useState(initialCreated);
    const [receipt, setReceipt] = useState<CreatedWorkspace | null>(null);
    const operation = useRef<{ key: string; id: string } | null>(null);
    async function create() {
        setBusy(true); setError(null); setReceipt(null);
        const input = { name: name.trim(), adminEmail: email.trim().toLowerCase() };
        const key = JSON.stringify(input);
        if (operation.current?.key !== key) operation.current = { key, id: crypto.randomUUID() };
        try {
            const response = await staffWorkspaceFetch('/api/staff/workspaces/create', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ...input, operationId: operation.current.id }),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.fields ? Object.values(result.fields).join(' ') : result.error ?? 'Unable to create this workspace.');
            setReceipt(result);
            setCreated(previous => [result, ...previous.filter(workspace => workspace.organizationId !== result.organizationId)]);
        } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to confirm creation. Retry with the same name and email, or refresh to check the created workspace list.'); }
        finally { setBusy(false); }
    }
    return <section className="space-y-4 border-t pt-6">
        <div className="space-y-2">
            <h2 className="text-lg font-semibold">Create an independent workspace</h2>
            <p className="text-muted-foreground">Invite its first administrator. They sign in with Google, verify two-step authentication, and connect Telegram in the browser. Each person chooses which conversations to import.</p>
            <p className="text-sm text-muted-foreground">Creating the workspace does not give you access to its records. Ask its administrator for an invitation if you also need membership.</p>
        </div>
        <form className="space-y-4" onSubmit={event => { event.preventDefault(); void create(); }}>
            <div className="space-y-2"><Label htmlFor="new-workspace-name">Workspace name</Label><Input id="new-workspace-name" maxLength={80} required value={name} disabled={busy} onChange={event => { setName(event.target.value); setReceipt(null); }} /></div>
            <div className="space-y-2"><Label htmlFor="new-workspace-admin">Administrator’s Google email</Label><Input id="new-workspace-admin" type="email" maxLength={320} required value={email} disabled={busy} onChange={event => { setEmail(event.target.value); setReceipt(null); }} /></div>
            {error && <p role="alert" className="text-destructive">{error}</p>}
            <Button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create workspace and invitation'}</Button>
        </form>
        {receipt && <div role="status" className="space-y-2 rounded-lg border p-4">
            <h3 className="font-semibold">{receipt.name} is ready for its administrator</h3>
            <p>Invitation reserved for {receipt.adminEmail}. Share this link with them; signing in with that exact email is required.</p>
            <a className="break-all underline" href={receipt.invitationPath}>{typeof window !== 'undefined' ? `${window.location.origin}${receipt.invitationPath}` : receipt.invitationPath}</a>
            <Button variant="outline" onClick={() => { void navigator.clipboard.writeText(`${window.location.origin}${receipt.invitationPath}`).catch(() => setError('Copy failed. Select and copy the invitation link above.')); }}>Copy invitation link</Button>
        </div>}
        {created.length > 0 && <div className="space-y-3">
            <h3 className="font-semibold">Workspaces you created</h3>
            <ul className="space-y-2">{created.map(workspace => <li key={workspace.organizationId} className="rounded-lg border p-3">
                <p className="font-medium">{workspace.name}</p><p className="text-sm text-muted-foreground">Administrator: {workspace.adminEmail}</p>
                <a className="text-sm underline" href={workspace.invitationPath}>Administrator sign-in link</a>
            </li>)}</ul>
        </div>}
    </section>;
}
