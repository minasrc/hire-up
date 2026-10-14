'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowLeft, Pencil } from 'lucide-react';
import { ClientRoles } from '@/components/staff-ui/client-roles';
import { ClientDetailsCard, ClientRecentApplications, type ClientView } from '@/components/staff-ui/client-overview';
import { useDiscardConfirmation } from '@/components/staff-ui/discard-confirmation';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/staff-ui/dialog';
import type { StaffWorkspaceCapabilities } from '@/lib/workspace-types';
import { staffWorkspaceFetch, staffWorkspaceUrl } from '@/lib/staff-workspace-fetch';
import { staffAuthRecovery } from '@/lib/staff-auth-recovery';
import { PageHeader } from '@/components/staff-preview/shared';
import { Button } from '@/components/staff-ui/button';
import { ClientForm, type SavedClient } from '../../workspace-forms';

export function ClientDetail({ initialClient, capabilities }: {
    initialClient: SavedClient;
    capabilities: StaffWorkspaceCapabilities | null;
}) {
    const [client, setClient] = useState(initialClient);
    const [seenInitial, setSeenInitial] = useState(initialClient);
    if (seenInitial !== initialClient) {
        setSeenInitial(initialClient);
        if (initialClient.id !== client.id || BigInt(initialClient.version) >= BigInt(client.version)) {
            setClient(initialClient);
        }
    }
    const onSaved = (saved: SavedClient) => setClient(current =>
        saved.id === current.id && BigInt(saved.version) >= BigInt(current.version) ? saved : current);
    const [editOpen, setEditOpen] = useState(false);
    const [formState, setFormState] = useState({ dirty: false, busy: false });
    const [view, setView] = useState<ClientView | null>(null);
    const [loadError, setLoadError] = useState(false);
    const [message, setMessage] = useState('');
    const { requestDiscard, discardDialog } = useDiscardConfirmation();
    const canWrite = capabilities?.writeClients === true;
    const canReadJobs = capabilities?.jobs === true;
    const canWriteJobs = capabilities?.writeJobs === true;
    const canReadApplications = capabilities?.applications === true;
    useEffect(() => {
        const controller = new AbortController();
        staffWorkspaceFetch(`/api/staff/clients/${client.id}`, { signal: controller.signal, cache: 'no-store' }).then(async response => {
            if ([401, 428].includes(response.status)) staffAuthRecovery.require(response.status);
            if (!response.ok) throw new Error('Client details unavailable');
            const payload = await response.json();
            if (!controller.signal.aborted) { setView(payload.result); setLoadError(false); }
        }).catch(() => { if (!controller.signal.aborted) setLoadError(true); });
        return () => controller.abort();
    }, [client.id, client.version]);
    const closeEditor = () => {
        if (!formState.busy) requestDiscard(formState.dirty, () => { setEditOpen(false); setFormState({ dirty: false, busy: false }); });
    };
    return <section className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <Link href={staffWorkspaceUrl('/staff/clients')} className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" aria-hidden="true" />Back to clients</Link>
        <PageHeader eyebrow="Client" title={client.name} actions={<>
            {client.status === 'active' && canWriteJobs && <Button asChild><Link href={staffWorkspaceUrl(`/staff/jobs/new?client=${client.id}`)}>Add job</Link></Button>}
            {canReadApplications && <Button variant="outline" asChild><Link href={staffWorkspaceUrl(`/staff/applications?client=${client.id}`)}>View applications</Link></Button>}
            {canWrite && <Button variant="outline" onClick={() => { setMessage(''); setEditOpen(true); }}><Pencil className="size-4" aria-hidden="true" />Edit client</Button>}
        </>} />
        {!canWrite && <p className="text-sm text-muted-foreground">{capabilities === null ? 'Editing is temporarily unavailable.' : 'You have read-only access to this client.'}</p>}
        {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
        <div className={canReadJobs ? 'grid items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]' : 'grid gap-6'}>
            {canReadJobs ? <section aria-label="Roles" className="flex min-w-0 flex-col gap-3">
                <div className="flex items-center justify-between"><h2 className="text-base font-semibold">Roles</h2><Button variant="ghost" size="sm" asChild><Link href={staffWorkspaceUrl(`/staff/jobs?client=${client.id}`)}>View jobs</Link></Button></div>
                <ClientRoles key={`${client.id}:${client.version}`} clientId={client.id} roles={[]} canReadApplications={canReadApplications} />
            </section> : null}
            <ClientDetailsCard client={client} metrics={view ? { openRoles: canReadJobs ? view.metrics.openRoles : null, applications: canReadApplications ? view.metrics.applications : null, interviewing: canReadApplications ? view.metrics.interviewing : null } : null} />
        </div>
        {canReadApplications && <ClientRecentApplications clientId={client.id} rows={view?.recentApplications ?? null} total={view?.metrics.applications} failed={loadError || view?.errors.applications} />}
        <Dialog open={editOpen} onOpenChange={open => { if (open) setEditOpen(true); else closeEditor(); }}>
            <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl" onEscapeKeyDown={event => { if (formState.busy) event.preventDefault(); }} onInteractOutside={event => { if (formState.busy) event.preventDefault(); }}>
                <DialogHeader><DialogTitle>Edit client</DialogTitle><DialogDescription>Update {client.name}&apos;s details.</DialogDescription></DialogHeader>
                {canWrite && <ClientForm key={editOpen ? 'editing' : 'closed'} clientId={client.id} initial={client} onStateChange={setFormState} onSaved={saved => {
                    onSaved(saved); setFormState({ dirty: false, busy: false }); setEditOpen(false); setMessage('Client updated.');
                }} />}
                <Button variant="ghost" disabled={formState.busy} onClick={closeEditor}>Cancel</Button>
            </DialogContent>
        </Dialog>
        {discardDialog}
    </section>;
}
