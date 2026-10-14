'use client';

import Link from 'next/link';
import { Badge } from './badge';
import { Button } from './button';
import { Card, CardContent, CardHeader, CardTitle } from './card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table';
import { ProfileLinks } from './profile-links';
import { InitialsAvatar } from '@/components/staff-preview/shared';
import { staffWorkspaceUrl } from '@/lib/staff-workspace-fetch';
import { StaffDate } from '@/app/staff/staff-date';
import type { SavedClient } from '@/app/staff/workspace-forms';
import type { readClientView } from '@/lib/client-view.server';

export type ClientView = Awaited<ReturnType<typeof readClientView>>;
type Metrics = ClientView['metrics'];
export function ClientMetrics({ metrics }: { metrics?: Metrics | null }) {
    if (!metrics) return null;
    const entries = [['Open roles', metrics.openRoles], ['Applications', metrics.applications], ['Interviewing', metrics.interviewing]] as const;
    return <dl className="flex flex-wrap gap-2">
        {entries.filter(([, count]) => count !== null).map(([label, count]) => <div key={label} className="min-w-0 flex-1 basis-[90px] rounded-lg bg-secondary/50 px-2 py-3 text-center">
            <dt className="break-words text-xs leading-5 text-muted-foreground">{label}</dt><dd className="mt-1 text-base font-semibold">{count}</dd>
        </div>)}
    </dl>;
}
export function ClientDetailsCard({ client, metrics, compact = false }: { client: SavedClient; metrics?: Metrics | null; compact?: boolean }) {
    const details = <div className="flex flex-col gap-5">
        <div><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Contact</p>
            <p className="mt-1 text-sm font-medium">{client.contactName || 'No contact added'}</p>
            {client.contactEmail ? <a className="mt-1 block break-all text-sm text-muted-foreground hover:underline" href={`mailto:${client.contactEmail}`}>{client.contactEmail}</a> : null}
        </div>
        <ProfileLinks website={client.website} links={client.socialLinks} />
        {client.telegramUsername && <div><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Telegram</p><a href={`https://t.me/${client.telegramUsername}`} target="_blank" rel="noopener noreferrer" className="mt-1 block text-sm hover:underline">@{client.telegramUsername}</a></div>}
        <div className={compact ? 'hidden' : 'flex flex-wrap gap-2'}><Badge variant={client.status === 'active' ? 'success' : 'secondary'}>{client.status === 'active' ? 'Active client' : `${client.status[0].toUpperCase()}${client.status.slice(1)} client`}</Badge>{client.isStealth && <Badge variant="warning">Stealth</Badge>}</div>
        {!compact && <ClientMetrics metrics={metrics} />}
    </div>;
    return compact ? <section aria-label="Client details"><h3 className="mb-4 text-sm font-semibold">Client details</h3>{details}</section> :
        <Card className="h-fit"><CardHeader><CardTitle className="text-base">Client details</CardTitle></CardHeader><CardContent>{details}</CardContent></Card>;
}
export function ClientRecentApplications({ clientId, rows, total, compact = false, failed = false }: {
    clientId: string; rows: ClientView['recentApplications']; total?: number | null; compact?: boolean; failed?: boolean;
}) {
    return <section aria-label="Recent applications" className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3"><h2 className="text-base font-semibold">Recent applications</h2>
            {!compact && <Button asChild size="sm" variant="ghost"><Link href={staffWorkspaceUrl(`/staff/applications?client=${clientId}`)}>View all{typeof total === 'number' ? ` (${total})` : ''}</Link></Button>}
        </div>
        {failed ? <p role="status" className="text-sm text-muted-foreground">Applications could not be loaded. Open applications to try again.</p> : rows === null ? <p role="status" className="text-sm text-muted-foreground">Loading applications…</p> : rows.length ? <div className="overflow-hidden rounded-lg border border-border bg-card"><Table>
            <TableHeader><TableRow><TableHead>Candidate</TableHead><TableHead>Job</TableHead><TableHead>Stage</TableHead>{!compact && <TableHead>Received</TableHead>}</TableRow></TableHeader>
            <TableBody>{rows.map((row: { applicationId: string; candidateId: string; candidateName: string | null; jobId: string; jobTitle: string; stageKind: string; stageKey: string; stageLabel: string; receivedAt: string }) => <TableRow key={row.applicationId}>
                <TableCell><Link href={staffWorkspaceUrl(`/staff/candidates/${row.candidateId}`)} className="font-medium hover:underline">{row.candidateName || 'Unnamed candidate'}</Link></TableCell>
                <TableCell><Link href={staffWorkspaceUrl(`/staff/jobs/${row.jobId}`)} className="hover:underline">{row.jobTitle}</Link></TableCell>
                <TableCell><Badge variant={row.stageKind === 'hired' ? 'success' : row.stageKey === 'interview' ? 'warning' : 'secondary'}>{['new', 'review', 'reviewing'].includes(row.stageKey) ? 'To review' : row.stageLabel}</Badge></TableCell>
                {!compact && <TableCell className="text-muted-foreground"><StaffDate value={row.receivedAt} /></TableCell>}
            </TableRow>)}</TableBody>
        </Table></div> : <p className="py-4 text-sm text-muted-foreground">No applications yet.</p>}
    </section>;
}
export function ClientPreviewContent({ view }: { view: ClientView }) {
    const roles = view.roles?.roles ?? [];
    return <div className="flex flex-col gap-6">
        <div className="flex flex-wrap gap-2">
            {view.client.status === 'active' && view.capabilities.writeJobs && <Button size="sm" variant="outline" asChild><Link href={staffWorkspaceUrl(`/staff/jobs/new?client=${view.client.id}`)}>Add job</Link></Button>}
            {view.capabilities.applications && <Button size="sm" variant="outline" asChild><Link href={staffWorkspaceUrl(`/staff/applications?client=${view.client.id}`)}>View applications</Link></Button>}
        </div>
        <div className="flex flex-wrap gap-2"><Badge variant={view.client.status === 'active' ? 'success' : 'secondary'}>{view.client.status === 'active' ? 'Active client' : `${view.client.status[0].toUpperCase()}${view.client.status.slice(1)} client`}</Badge>{view.client.isStealth && <Badge variant="warning">Stealth</Badge>}</div>
        <ClientMetrics metrics={view.metrics} />
        <ClientDetailsCard client={view.client} compact />
        {view.capabilities.jobs && <section className="flex flex-col gap-3"><h3 className="text-sm font-semibold">Roles</h3>
            {view.errors.roles ? <p role="status">Roles could not be loaded.</p> : roles.length ? <div className="overflow-hidden rounded-lg border border-border"><Table containerClassName="max-h-[380px] overflow-y-auto">
                <TableHeader className="sticky top-0 bg-card"><TableRow><TableHead>Role</TableHead><TableHead>Status</TableHead><TableHead>Location</TableHead></TableRow></TableHeader>
                <TableBody>{roles.map(role => <TableRow key={role.id}><TableCell><Link href={staffWorkspaceUrl(`/staff/jobs/${role.id}`)} className="font-medium hover:underline">{role.title}</Link></TableCell><TableCell><Badge variant="secondary">{role.status}</Badge></TableCell><TableCell className="text-muted-foreground">{role.location || '—'}</TableCell></TableRow>)}</TableBody>
            </Table></div> : <p className="text-sm text-muted-foreground">No roles yet.</p>}
        </section>}
        {view.capabilities.applications && <ClientRecentApplications clientId={view.client.id} rows={view.recentApplications} compact failed={view.errors.applications} />}
    </div>;
}
export function ClientPreviewHeading({ name }: { name: string }) {
    return <div className="flex items-center gap-3"><InitialsAvatar name={name} size="lg" /><span>{name}</span></div>;
}
