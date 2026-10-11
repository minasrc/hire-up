'use client';

import Link from 'next/link';
import { Search, X } from 'lucide-react';

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
    if (filters.stage !== 'all') params.set('stage', filters.stage);
    if (filters.review) params.set('review', '1');
    if (filters.page > 1) params.set('page', String(filters.page));
    return params.toString();
}

const parseFilters = (params: { get(name: string): string | null }): ApplicationFiltersState => {
    const filters = applicationDirectoryQuery({ q: params.get('q'), job: params.get('job'),
        client: params.get('client'), stage: params.get('stage'), review: params.get('review'), page: params.get('page') });
    return { ...filters, jobId: filters.jobId ?? 'all', clientId: filters.clientId ?? 'all' };
};

export function ApplicationsBrowser({
    applications,
    jobs,
    clientOptions = [],
    stages,
    scopeTotal,
    total,
    page,
    pageSize,
}: {
    applications: ApplicationRow[];
    jobs: { id: string; title: string }[];
    clientOptions?: { id: string; name: string }[];
    stages: { key: string; label: string; kind: string; count: number }[];
    scopeTotal: number;
    total: number;
    page: number;
    pageSize: number;
}) {
    const { filters, update: navigate, pending } = useDirectoryNavigation(
        '/staff/applications', parseFilters, serializeFilters);
    const update = (next: ApplicationFiltersState, debounce = false) =>
        navigate({ ...next, page: 1 }, debounce);
    const clients = clientOptions;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    const filtersSet =
        filters.query.trim() !== ''
        || filters.jobId !== 'all'
        || filters.clientId !== 'all'
        || filters.stage !== 'all'
        || filters.review;

    const clearFilters = () =>
        update({ query: '', jobId: 'all', clientId: 'all', stage: 'all', review: false, page: 1 });

    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <div className="flex flex-col gap-1.5">
                    <p className="text-[11px] font-semibold tracking-[0.08em] text-accent-foreground uppercase">
                        Workspace
                    </p>
                    <h1 className="text-[26px] leading-8 font-medium text-foreground">
                        Applications
                    </h1>
                </div>
            </div>

            <div
                className="grid grid-cols-2 gap-3 sm:grid-cols-4"
                role="group"
                aria-label="Stage filter cards"
            >
                <button
                    type="button"
                    aria-pressed={filters.stage === 'all'}
                    onClick={() => update({ ...filters, stage: 'all' })}
                    className={cn(
                        'flex flex-col gap-0.5 rounded-lg border border-border bg-card px-4 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                        filters.stage === 'all'
                            ? 'border-ring bg-accent'
                            : 'hover:bg-hover',
                    )}
                >
                    <span className="text-sm text-muted-foreground">All applications</span>
                    <span className="text-[26px] leading-8 font-semibold text-foreground">
                        {scopeTotal}
                    </span>
                </button>
                {stages.map((stage) => (
                    <button
                        key={stage.key}
                        type="button"
                        aria-pressed={filters.stage === stage.key}
                        onClick={() =>
                            update({ ...filters, stage: stage.key })
                        }
                        className={cn(
                            'flex flex-col gap-0.5 rounded-lg border border-border bg-card px-4 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                            filters.stage === stage.key
                                ? 'border-ring bg-accent'
                                : 'hover:bg-hover',
                        )}
                    >
                        <span className="text-sm text-muted-foreground">{stage.label}</span>
                        <span className="text-[26px] leading-8 font-semibold text-foreground">
                            {stage.count}
                        </span>
                    </button>
                ))}
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

            {applications.length === 0 ? (
                <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-card px-6 py-12 text-center">
                    <p className="text-sm font-medium text-foreground">No applications found</p>
                    <p className="max-w-sm text-sm text-muted-foreground">
                        {!filtersSet
                            ? 'Applications appear here once candidates are linked to jobs.'
                            : 'Try clearing the filters.'}
                    </p>
                </div>
            ) : (
                <div aria-busy={pending} className="overflow-hidden rounded-lg border border-border bg-card">
                    <Table>
                        <TableHeader>
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
                                        <a
                                            href={`/staff/candidates/${row.candidateId}`}
                                            className="font-medium text-foreground underline-offset-4 hover:underline"
                                        >
                                            {row.candidateName ?? 'Unnamed'}
                                        </a>
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
                                            href={`/staff/clients/${row.clientId}`}
                                            className="underline-offset-4 hover:underline"
                                        >
                                            {row.clientName}
                                        </Link>
                                    </TableCell>
                                    <TableCell>
                                        <Badge variant={KIND_TONE[row.stageKind] ?? 'secondary'}>
                                            {row.stageLabel}
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
    );
}
