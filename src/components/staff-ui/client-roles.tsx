'use client';

import { useEffect, useRef, useState } from 'react';
import { Search, UsersRound } from 'lucide-react';
import { Input } from './input';
import { Button } from './button';
import { Badge } from './badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';
import { JobPreviewLink } from '@/components/staff-preview/job-preview';
import Link from 'next/link';
import { staffWorkspaceFetch, staffWorkspaceUrl } from '@/lib/staff-workspace-fetch';

export interface ClientRole { id: string; title: string; location: string; status: string; applications: number | null; draft?: boolean }
const PAGE_SIZE = 50;
export function ClientRoles({ roles, clientId, preview = false, total = roles.length, canReadApplications = preview }: { roles: ClientRole[]; clientId: string; preview?: boolean; total?: number; canReadApplications?: boolean }) {
    const [query, setQuery] = useState('');
    const [status, setStatus] = useState('all');
    const [page, setPage] = useState(1);
    const [remote, setRemote] = useState<{ roles: ClientRole[]; total: number; page: number; scope: string } | null>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const scope = JSON.stringify([clientId, query, status]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [retry, setRetry] = useState(0);
    useEffect(() => {
        if (preview) return;
        const controller = new AbortController();
        const timer = setTimeout(async () => {
            setLoading(true); setError('');
            try {
                const params = new URLSearchParams({ q: query, status, page: String(page) });
                const response = await staffWorkspaceFetch(`/api/staff/clients/${clientId}/roles?${params}`, { signal: controller.signal });
                if (!response.ok) throw new Error('Could not load roles. Please try again.');
                const payload = await response.json();
                if (!controller.signal.aborted) {
                    setRemote((previous) => ({
                        total: payload.result.total, page, scope,
                        roles: page === 1 || previous?.scope !== scope ? payload.result.roles : [
                            ...previous.roles,
                            ...payload.result.roles.filter((role: ClientRole) => !previous.roles.some((entry) => entry.id === role.id)),
                        ],
                    }));
                }
            } catch (failure) {
                if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Could not load roles.');
            } finally { if (!controller.signal.aborted) setLoading(false); }
        }, query ? 180 : 0);
        return () => { clearTimeout(timer); controller.abort(); };
    }, [clientId, page, preview, query, retry, scope, status]);
    const filtered = roles.filter((role) => (status === 'all' || role.status.toLowerCase() === status) && `${role.title} ${role.location}`.toLowerCase().includes(query.trim().toLowerCase()));
    const current = remote?.scope === scope ? remote : null;
    const count = preview ? filtered.length : current?.total ?? total;
    const visible = preview ? filtered : current?.roles ?? (query || status !== 'all' ? [] : roles.slice(0, PAGE_SIZE));
    const resetScroll = () => { if (listRef.current) listRef.current.scrollTop = 0; };
    const prefix = preview ? '#' : '/staff';
    return <div className="flex flex-col gap-3" aria-busy={loading}>
        <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative min-w-0 flex-1"><Search className="absolute left-3 top-3 size-3.5 text-muted-foreground" aria-hidden="true" /><Input className="pl-9" aria-label="Search client roles" placeholder="Search roles…" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); resetScroll(); }} /></div>
            <Select value={status} onValueChange={(value) => { setStatus(value); setPage(1); resetScroll(); }}><SelectTrigger className="sm:w-36" aria-label="Role status"><SelectValue /></SelectTrigger><SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {(preview ? ['Open', 'Draft', 'Closed', 'Archived'] : ['Listed', 'Unlisted', 'Draft', 'Archived', 'Withdrawn']).map((label) => <SelectItem key={label} value={label.toLowerCase()}>{label}</SelectItem>)}
            </SelectContent></Select>
        </div>
        {loading && <p role="status" className="text-xs text-muted-foreground">Loading roles…</p>}
        {error ? <div role="alert" className="flex items-center gap-2 text-sm">{error}<Button size="sm" variant="outline" onClick={() => setRetry((value) => value + 1)}>Try again</Button></div> : null}
        {visible.length ? <div ref={listRef} role="region" aria-label="Client roles" tabIndex={0}
            className="max-h-[380px] overflow-y-auto overscroll-contain rounded-lg border border-border bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onScroll={(event) => {
                const node = event.currentTarget;
                if (!preview && !loading && !error && current?.page === page && visible.length < count && node.scrollHeight - node.scrollTop - node.clientHeight < 120) {
                    setLoading(true); setPage(page + 1);
                }
            }}><ul>
            {visible.map((role) => <li key={role.id} data-testid={`client-role-${role.id}`} className="relative flex min-h-[76px] flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-4 transition-colors last:border-0 hover:bg-hover">
                <div className="min-w-0 flex-1 basis-48">
                    {preview ? <JobPreviewLink jobId={role.id} className="rounded-sm text-sm font-medium outline-none after:absolute after:inset-0 hover:underline focus-visible:ring-2 focus-visible:ring-ring">{role.title}</JobPreviewLink> : <Link href={staffWorkspaceUrl(`/staff/jobs/${role.id}`)} className="rounded-sm text-sm font-medium outline-none after:absolute after:inset-0 hover:underline focus-visible:ring-2 focus-visible:ring-ring">{role.title}</Link>}
                    {role.location ? <p className="mt-1 text-xs text-muted-foreground">{role.location}</p> : null}
                </div>
                <div className="flex items-center gap-3"><Badge variant="secondary">{role.status}</Badge>{role.draft ? <Badge variant="outline">Draft changes</Badge> : null}
                    {canReadApplications ? <a href={preview ? `${prefix}/applications?client=${clientId}&job=${role.id}` : staffWorkspaceUrl(`${prefix}/applications?client=${clientId}&job=${role.id}`)} aria-label={`View applications for ${role.title}`} className="relative z-10 inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><UsersRound className="size-3.5" aria-hidden="true" />{role.applications === null ? 'Applications' : `${role.applications} ${role.applications === 1 ? 'application' : 'applications'}`}</a> : null}
                </div>
            </li>)}
        </ul></div> : <p className="py-6 text-center text-sm text-muted-foreground">{query || status !== 'all' ? 'No roles match these filters.' : 'No roles yet.'}</p>}
        <p className="text-xs text-muted-foreground">{visible.length < count && !preview ? `${visible.length} of ${count} roles` : `${count} ${count === 1 ? 'role' : 'roles'}`}</p>
    </div>;
}
