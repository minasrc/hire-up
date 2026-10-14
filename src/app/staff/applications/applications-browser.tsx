'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApplicationPipeline } from '@/components/staff-ui/application-pipeline';
import { ApplicationReviewContext, ApplicationReviewLink } from '@/components/staff-ui/application-review';
import { StaffApplicationReview, loadApplicationWorkspace } from './application-review';
import { loadAdjacentReviewPage } from '@/lib/review-pagination';
import { staffWorkspaceFetch, staffWorkspaceUrl, refreshStaffWorkspace } from '@/lib/staff-workspace-fetch';
import { staffMutation } from '@/lib/staff-mutation';


import Link from 'next/link';
import { Search, X, ChevronRight, Columns3, Table2 } from 'lucide-react';

import { InitialsAvatar, PageHeader } from '@/components/staff-preview/shared';
import { Badge } from '@/components/staff-ui/badge';
import { Button } from '@/components/staff-ui/button';
import { Input } from '@/components/staff-ui/input';
import { Label } from '@/components/staff-ui/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/staff-ui/select';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/staff-ui/table';
import { cn } from '@/lib/utils';
import { applicationDirectoryQuery } from '@/lib/staff-directory-query';
import { useDirectoryNavigation } from '../use-directory-navigation';
import { StaffDate } from '../staff-date';

export interface ApplicationRow {
    applicationId: string;
    candidateId: string;
    candidateName: string | null;
    jobId: string;
    jobTitle: string;
    clientId: string;
    clientName: string;
    stageId: string;
    stageKey: string;
    stageLabel: string;
    stageKind: string;
    stageIsInitial?: boolean;
    publicReference: string;
    receivedAt: string;
    version?: string;
}

export interface ApplicationFiltersState {
    page: number;
    query: string;
    jobId: string;
    clientId: string;
    stage: string;
    review: boolean;
}

const KIND_TONE: Record<string, 'accent' | 'warning' | 'success' | 'restriction' | 'secondary'> = {
    active: 'accent',
    hired: 'success',
    rejected: 'restriction',
    withdrawn: 'secondary',
};

const formatDate = (iso: string) => <StaffDate value={iso} />;

function serializeFilters(filters: ApplicationFiltersState) {
    const params = new URLSearchParams();
    if (filters.query.trim()) params.set('q', filters.query);
    if (filters.jobId !== 'all') params.set('job', filters.jobId);
    if (filters.clientId !== 'all') params.set('client', filters.clientId);
    params.set('stage', filters.stage === 'all' ? 'active' : filters.stage);
    if (filters.review) params.set('review', '1');
    if (filters.page > 1) params.set('page', String(filters.page));
    return params.toString();
}

const parseFilters = (params: { get(name: string): string | null }): ApplicationFiltersState => {
    const filters = applicationDirectoryQuery({ q: params.get('q'), job: params.get('job'),
        client: params.get('client'), stage: params.get('stage'), review: params.get('review'), page: params.get('page') });
    return { ...filters, stage: filters.stage === 'active' ? 'all' : filters.stage, jobId: filters.jobId ?? 'all', clientId: filters.clientId ?? 'all' };
};

export function ApplicationsBrowser({
    applications,
    jobs,
    clientOptions = [],
    stages,
    total,
    page,
    pageSize,
}: {
    applications: ApplicationRow[];
    jobs: { id: string; title: string }[];
    clientOptions?: { id: string; name: string }[];
    stages: { key: string; label: string; kind: string; count: number; isInitial?: boolean }[];
    scopeTotal: number;
    total: number;
    page: number;
    pageSize: number;
}) {
    const { filters, update: navigate, pending } = useDirectoryNavigation(
        '/staff/applications', parseFilters, serializeFilters);
    const update = (next: ApplicationFiltersState, debounce = false) =>
        navigate({ ...next, page: 1 }, debounce);
    const router = useRouter();
    const [view, setView] = useState('table');
    const [reviewId, setReviewId] = useState<string | null>(null);
    const [queue, setQueue] = useState<ApplicationRow[]>([]);
    const [trigger, setTrigger] = useState<HTMLElement | null>(null);
    const [queueTotal, setQueueTotal] = useState(total);
    const [offset, setOffset] = useState(0);
    const [queueLoading, setQueueLoading] = useState(false);
    const [queueError, setQueueError] = useState('');
    const queueFilters = useRef(filters);
    const frontier = useRef(page);
    const generation = useRef(0);
    const groups = [
        { key: 'all', label: 'Active applications', kind: 'active', count: stages.filter((stage) => stage.kind === 'active').reduce((sum, stage) => sum + stage.count, 0) },
        { key: 'to_review', label: 'To review', kind: 'active', count: stages.filter((stage) => (stage.isInitial || ['new', 'review', 'reviewing'].includes(stage.key))).reduce((sum, stage) => sum + stage.count, 0) },
        ...['interview', 'offer'].map((key) => stages.find((stage) => stage.key === key) ?? { key, label: key === 'interview' ? 'Interview' : 'Offer', kind: 'active', count: 0 }),
        ...stages.filter((stage) => stage.kind === 'active' && !stage.isInitial && !['new', 'review', 'reviewing', 'interview', 'offer'].includes(stage.key)),
        { key: 'closed', label: 'Closed applications', kind: 'closed', count: stages.filter((stage) => ['hired', 'rejected', 'withdrawn'].includes(stage.kind)).reduce((sum, stage) => sum + stage.count, 0) },
    ];
    const pipelineStages = filters.stage === 'closed' ? ['hired', 'rejected', 'withdrawn'].map((key) => stages.find((stage) => stage.kind === key) ?? { key, label: key[0].toUpperCase() + key.slice(1), kind: key, count: 0 }) : groups.filter((stage) => stage.key !== 'all' && stage.kind === 'active' && (filters.stage === 'all' || stage.key === filters.stage));
    const stageKey = (row: ApplicationRow) => (row.stageIsInitial || ['new', 'review', 'reviewing'].includes(row.stageKey)) ? 'to_review' : row.stageKey;
    const move = async (row: ApplicationRow, target: string, reason: string) => {
        const workspace = await loadApplicationWorkspace(row.candidateId);
        const application = workspace.applications.find((entry) => entry.applicationId === row.applicationId);
        if (!application || !workspace.capabilities.changeStage || workspace.candidate.lifecycle !== 'active') throw new Error('You cannot move this application.');
        if (application.stageId !== row.stageId || (row.version && application.version !== row.version)) { refreshStaffWorkspace(router); throw new Error('This application was updated. Please review its latest stage.'); }
        const destination = workspace.stages.find((stage) => stage.pipelineId === application.pipelineId && (target === 'to_review' ? stage.position === Math.min(...workspace.stages.filter((entry) => entry.pipelineId === application.pipelineId).map((entry) => entry.position)) : stage.key === target));
        if (!destination) throw new Error('This stage is unavailable for this application.');
        await staffMutation('/api/staff/applications', { action: 'transitionStage', applicationId: application.applicationId, toStageId: destination.stageId, expectedVersion: application.version, reason });
        refreshStaffWorkspace(router);
    };
    const position = queue.findIndex((row) => row.applicationId === reviewId);
    const reviewRow = applications.find((row) => row.applicationId === reviewId) ?? queue[position];
    const navigateReview = async (direction: -1 | 1) => {
        const within = queue[position + direction];
        if (within) { setReviewId(within.applicationId); return; }
        if (queueLoading) return;
        const epoch = ++generation.current;
        setQueueLoading(true); setQueueError('');
        try {
            const adjacent = await loadAdjacentReviewPage({ queue, direction, frontier: frontier.current, offset, pageSize,
                isCurrent: () => epoch === generation.current,
                loadPage: async (nextPage) => {
                    const response = await staffWorkspaceFetch(`/api/staff/applications?${serializeFilters({ ...queueFilters.current, page: nextPage })}`);
                    if (!response.ok) throw new Error('Could not load more applications. Please try again.');
                    const payload = await response.json();
                    return { applications: payload.result.rows as ApplicationRow[], total: payload.result.total, pageSize: payload.result.pageSize };
                },
            });
            if (epoch !== generation.current) return;
            if (adjacent) {
                if (direction === 1) { frontier.current = adjacent.page; setQueue((previous) => [...previous, ...adjacent.rows]); setReviewId(adjacent.rows[0].applicationId); }
                else { setOffset((value) => Math.max(0, value - adjacent.rows.length)); setQueue((previous) => [...adjacent.rows, ...previous]); setReviewId(adjacent.rows[adjacent.rows.length - 1].applicationId); }
            } else if (direction === 1) setQueueTotal(offset + queue.length); else setOffset(0);
        } catch (failure) { if (epoch === generation.current) setQueueError(failure instanceof Error ? failure.message : 'Could not load more applications.'); }
        finally { if (epoch === generation.current) setQueueLoading(false); }
    };
    useEffect(() => {
        const clear = () => { generation.current += 1; setReviewId(null); setQueue([]); setTrigger(null); setQueueLoading(false); };
        window.addEventListener('staff-workspace-changed', clear);
        window.addEventListener('staff-session-invalidated', clear);
        return () => { generation.current += 1; window.removeEventListener('staff-workspace-changed', clear); window.removeEventListener('staff-session-invalidated', clear); };
    }, []);
    const clients = clientOptions;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    const filtersSet =
        filters.query.trim() !== ''
        || filters.jobId !== 'all'
        || filters.clientId !== 'all'
        || filters.stage !== 'all'
        || filters.review;

    const clearFilters = () =>
        update({ query: '', jobId: 'all', clientId: 'all', stage: filters.stage === 'closed' ? 'closed' : 'all', review: false, page: 1 });

    return (
        <ApplicationReviewContext.Provider value={(id, source) => { setTrigger(source); setQueue(applications); setQueueTotal(total); setOffset((page - 1) * pageSize); queueFilters.current = filters; frontier.current = page; generation.current += 1; setQueueLoading(false); setQueueError(''); setReviewId(id); }}>
        <div className="flex flex-col gap-6">
            <PageHeader eyebrow="Workspace" title="Applications" />

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5" role="group" aria-label="Stage filter cards">
                {groups.map((stage) => <button key={stage.key} type="button" aria-pressed={filters.stage === stage.key} onClick={() => update({ ...filters, stage: stage.key })} className={cn('flex flex-col gap-1 rounded-lg border border-border bg-card px-4 py-3 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring', filters.stage === stage.key && 'border-ring bg-accent')}><span className="text-muted-foreground">{stage.label}</span><span className="text-2xl font-semibold">{stage.count}</span></button>)}
            </div>

            <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 md:flex-row md:flex-wrap md:items-end">
                <div className="flex flex-1 flex-col gap-1.5 md:min-w-56">
                    <Label htmlFor="application-search">Search</Label>
                    <div className="relative">
                        <Search
                            className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                            aria-hidden="true"
                        />
                        <Input
                            id="application-search"
                            className="pl-9"
                            placeholder="Search candidate, job or client…"
                            maxLength={200}
                            value={filters.query}
                            onChange={(event) =>
                                update({ ...filters, query: event.target.value }, true)
                            }
                        />
                    </div>
                </div>
                <div className="flex flex-col gap-1.5 md:w-56">
                    <Label htmlFor="job-filter">Job</Label>
                    <Select
                        value={filters.jobId}
                        onValueChange={(value) => update({ ...filters, jobId: value })}
                    >
                        <SelectTrigger id="job-filter" aria-label="Filter by job">
                            <SelectValue placeholder="All jobs">
                                {filters.jobId === 'all' ? 'All jobs'
                                    : jobs.find((job) => job.id === filters.jobId)?.title
                                        ?? applications.find((row) => row.jobId === filters.jobId)?.jobTitle
                                        ?? 'Unavailable job'}
                            </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All jobs</SelectItem>
                            {jobs.map((job) => (
                                <SelectItem key={job.id} value={job.id}>
                                    {job.title}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <div className="flex flex-col gap-1.5 md:w-56">
                    <Label htmlFor="client-filter">Client</Label>
                    <Select
                        value={filters.clientId}
                        onValueChange={(value) => update({ ...filters, clientId: value })}
                    >
                        <SelectTrigger id="client-filter" aria-label="Filter by client">
                            <SelectValue placeholder="All clients">
                                {filters.clientId === 'all' ? 'All clients'
                                    : clients.find((client) => client.id === filters.clientId)?.name ?? 'Unavailable client'}
                            </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All clients</SelectItem>
                            {clients.map((client) => (
                                <SelectItem key={client.id} value={client.id}>
                                    {client.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    aria-pressed={filters.review}
                    onClick={() =>
                        update({ ...filters, review: !filters.review })
                    }
                >
                    Awaiting review
                </Button>
                {filtersSet ? (
                    <Button variant="ghost" size="sm" onClick={clearFilters}>
                        <X aria-hidden="true" />
                        Clear filters
                    </Button>
                ) : null}
            </div>

            <span role="status" className="text-xs text-muted-foreground">
                {total} application{total === 1 ? '' : 's'}{pending ? ' · Updating…' : ''}
            </span>

            <div className="flex justify-end gap-2" aria-label="Results view"><Button size="sm" aria-pressed={view === 'table'} variant={view === 'table' ? 'secondary' : 'outline'} onClick={() => setView('table')}><Table2 aria-hidden="true" />Table</Button><Button size="sm" aria-pressed={view === 'pipeline'} variant={view === 'pipeline' ? 'secondary' : 'outline'} onClick={() => setView('pipeline')}><Columns3 aria-hidden="true" />Pipeline</Button></div>
            {applications.length === 0 ? (
                <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-card px-6 py-12 text-center">
                    <p className="text-sm font-medium text-foreground">No applications found</p>
                    <p className="max-w-sm text-sm text-muted-foreground">
                        {!filtersSet
                            ? 'Applications appear here once candidates are linked to jobs.'
                            : 'Try clearing the filters.'}
                    </p>
                </div>
            ) : view === 'pipeline' ? <ApplicationPipeline rows={applications} partial={total > applications.length} stages={pipelineStages} stageKey={stageKey} rowKey={(row) => row.applicationId} rowName={(row) => row.candidateName ?? 'Application'} onMove={move} onShowAllStages={() => update({ ...filters, stage: filters.stage === 'closed' ? 'closed' : 'all' })}
                renderCard={(row, drag) => <li key={row.applicationId} {...drag} className="relative flex flex-col gap-2.5 rounded-lg border border-border bg-card p-3 text-sm hover:bg-hover data-[drag-enabled=true]:cursor-grab">
                    <div className="flex min-w-0 items-center gap-2.5"><InitialsAvatar name={row.candidateName ?? 'Unnamed candidate'} size="sm" /><ApplicationReviewLink data-pipeline-review draggable={false} applicationId={row.applicationId} href={staffWorkspaceUrl(`/staff/candidates/${row.candidateId}`)} className="min-w-0 font-medium after:absolute after:inset-0 hover:underline">{row.candidateName ?? 'Unnamed candidate'}</ApplicationReviewLink></div>
                    <Link draggable={false} className="relative z-10 w-fit" href={staffWorkspaceUrl(`/staff/jobs/${row.jobId}`)}>{row.jobTitle}</Link>
                    <Link draggable={false} className="relative z-10 w-fit text-xs text-muted-foreground" data-preview-trigger href={staffWorkspaceUrl(`/staff/clients/${row.clientId}`)}>{row.clientName}</Link>
                    <ChevronRight className="ml-auto size-3.5 text-muted-foreground" aria-hidden="true" />
                </li>} /> : (
                <div aria-busy={pending} className="overflow-hidden rounded-lg border border-border bg-card">
                    <Table containerClassName="max-h-[min(65vh,640px)] overflow-y-auto overscroll-contain" aria-label="Applications">
                        <TableHeader className="sticky top-0 z-10 bg-card">
                            <TableRow>
                                <TableHead>Candidate</TableHead>
                                <TableHead>Job</TableHead>
                                <TableHead>Client</TableHead>
                                <TableHead>Stage</TableHead>
                                <TableHead>Received</TableHead>
                                <TableHead>Reference</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {applications.map((row) => (
                                <TableRow key={row.applicationId}>
                                    <TableCell>
                                        <div className="flex items-center gap-3"><InitialsAvatar name={row.candidateName ?? 'Unnamed candidate'} size="sm" /><ApplicationReviewLink applicationId={row.applicationId}
                                            href={staffWorkspaceUrl(`/staff/candidates/${row.candidateId}`)}
                                            className="font-medium text-foreground underline-offset-4 hover:underline"
                                        >
                                            {row.candidateName ?? 'Unnamed'}
                                        </ApplicationReviewLink></div>
                                    </TableCell>
                                    <TableCell className="text-muted-foreground">
                                        <a
                                            href={`/staff/jobs/${row.jobId}`}
                                            className="underline-offset-4 hover:underline"
                                        >
                                            {row.jobTitle}
                                        </a>
                                    </TableCell>
                                    <TableCell className="text-muted-foreground">
                                        <Link
                                            data-preview-trigger href={`/staff/clients/${row.clientId}`}
                                            className="underline-offset-4 hover:underline"
                                        >
                                            {row.clientName}
                                        </Link>
                                    </TableCell>
                                    <TableCell>
                                        <Badge variant={KIND_TONE[row.stageKind] ?? 'secondary'}>
                                            {stageKey(row) === 'to_review' ? 'To review' : row.stageLabel}
                                        </Badge>
                                    </TableCell>
                                    <TableCell className="text-muted-foreground">
                                        {formatDate(row.receivedAt)}
                                    </TableCell>
                                    <TableCell className="font-mono text-xs text-muted-foreground">
                                        {row.publicReference}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </div>
            )}
            <nav aria-label="Directory pages" className="flex items-center justify-between gap-3">
                <Button variant="outline" size="sm" disabled={pending || page <= 1}
                    onClick={() => navigate({ ...filters, page: page - 1 })}>Previous</Button>
                <span className="text-xs text-muted-foreground">
                    Page {page} of {totalPages}
                    {total > 0 ? ` · ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}` : ''}
                </span>
                <Button variant="outline" size="sm" disabled={pending || page >= totalPages}
                    onClick={() => navigate({ ...filters, page: page + 1 })}>Next</Button>
            </nav>
        </div>
        {reviewRow && reviewId && <StaffApplicationReview row={reviewRow} returnFocus={trigger} position={offset + position} total={queueTotal} navigationLoading={queueLoading} navigationError={queueError} onClose={() => { generation.current += 1; setReviewId(null); }} onPrevious={() => void navigateReview(-1)} onNext={() => void navigateReview(1)} onChanged={() => refreshStaffWorkspace(router)} />}
        </ApplicationReviewContext.Provider>
    );
}
