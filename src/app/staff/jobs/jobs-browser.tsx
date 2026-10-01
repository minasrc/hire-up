'use client';

import Link from 'next/link';
import { ArrowDown, ArrowUp, ArrowUpDown, Briefcase, Search, X } from 'lucide-react';

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
import { EmptyState, PageHeader, StatusBadge, TagPill } from '@/components/staff-preview/shared';
import { jobStatusLabel } from '@/lib/job-display';
import { cn } from '@/lib/utils';
import { useDirectoryNavigation } from '../use-directory-navigation';
import { flagParam, optionParam, textParam, uuidParam } from '../filter-params';

export interface JobRow {
    id: string;
    clientId: string;
    clientName: string;
    clientIsStealth: boolean;
    title: string;
    publicationState: string;
    applicationState: string;
    publiclyListed?: boolean | null;
    ownerMembershipId: string | null;
    draftRevisionId: string | null;
    createdAt: string;
}

type SortKey = 'title' | 'client' | 'publication';
type SortDirection = 'asc' | 'desc';

export interface JobFiltersState {
    page: number;
    query: string;
    clientId: string;
    state: string;
    intake: string;
    mine: boolean;
    sortBy: SortKey;
    sortDirection: SortDirection;
}

const STATE_OPTIONS = [
    { value: 'all', label: 'All statuses' },
    { value: 'draft', label: 'Draft' },
    { value: 'listed', label: 'Listed' },
    { value: 'unlisted', label: 'Unlisted' },
    { value: 'withdrawn', label: 'Withdrawn' },
    { value: 'archived', label: 'Archived' },
    { value: 'published', label: 'Listed or unlisted' },
];

const INTAKE_VALUES = ['all', 'open', 'closed'];

const statusTone = (label: string) =>
    label === 'Listed'
        ? 'success'
        : label === 'Draft'
          ? 'secondary'
          : 'outline';

function serializeFilters(filters: JobFiltersState) {
    const params = new URLSearchParams();
    if (filters.query.trim()) params.set('q', filters.query);
    if (filters.clientId !== 'all') params.set('client', filters.clientId);
    if (filters.state !== 'all') params.set('state', filters.state);
    if (filters.intake !== 'all') params.set('intake', filters.intake);
    if (filters.mine) params.set('mine', '1');
    if (filters.sortBy !== 'title') params.set('sort', filters.sortBy);
    if (filters.sortDirection !== 'asc') params.set('dir', filters.sortDirection);
    if (filters.page > 1) params.set('page', String(filters.page));
    return params.toString();
}

const STATE_VALUES = STATE_OPTIONS.map((option) => option.value);
const SORT_VALUES: SortKey[] = ['title', 'client', 'publication'];

const parseFilters = (params: { get(name: string): string | null }): JobFiltersState => ({
    page: /^\d+$/.test(params.get('page') ?? '')
        ? Math.min(1000000, Math.max(1, Number(params.get('page')))) : 1,
    query: textParam(params, 'q'),
    clientId: uuidParam(params, 'client'),
    state: optionParam(params, 'state', STATE_VALUES, 'all'),
    intake: optionParam(params, 'intake', INTAKE_VALUES, 'all'),
    mine: flagParam(params, 'mine') || params.get('owner') === 'me',
    sortBy: optionParam(params, 'sort', SORT_VALUES, 'title'),
    sortDirection: params.get('dir') === 'desc' ? 'desc' : 'asc',
});

export function JobsBrowser({
    jobs,
    clients,
    canCreate,
    total,
    page,
    pageSize,
}: {
    jobs: JobRow[];
    clients: { id: string; name: string }[];
    canCreate: boolean;
    total: number;
    page: number;
    pageSize: number;
}) {
    const { filters, update: navigate, pending } = useDirectoryNavigation(
        '/staff/jobs', parseFilters, serializeFilters,
    );
    const update = (next: JobFiltersState, debounce = false) => {
        navigate({ ...next, page: 1 }, debounce);
    };
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const filtersActive =
        filters.query.trim() !== ''
        || filters.clientId !== 'all'
        || filters.state !== 'all'
        || filters.intake !== 'all'
        || filters.mine;

    const clearFilters = () =>
        update({ ...filters, query: '', clientId: 'all', state: 'all', intake: 'all', mine: false });

    const toggleSort = (key: SortKey) => {
        update({
            ...filters,
            sortBy: key,
            sortDirection:
                filters.sortBy === key && filters.sortDirection === 'asc'
                    ? 'desc'
                    : 'asc',
        });
    };

    const sortableHead = (key: SortKey, label: string, className?: string) => {
        const active = filters.sortBy === key;
        const Icon = active
            ? filters.sortDirection === 'asc'
                ? ArrowUp
                : ArrowDown
            : ArrowUpDown;
        return (
            <TableHead
                className={className}
                aria-sort={
                    active
                        ? filters.sortDirection === 'asc'
                            ? 'ascending'
                            : 'descending'
                        : 'none'
                }
            >
                <button
                    type="button"
                    onClick={() => toggleSort(key)}
                    className={cn(
                        'inline-flex items-center gap-1 rounded-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
                        active && 'text-foreground',
                    )}
                >
                    {label}
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
            </TableHead>
        );
    };

    return (
        <div className="flex flex-col gap-6" aria-busy={pending}>
            <PageHeader
                eyebrow="Workspace"
                title="Jobs"
                description="Drafts and published roles across your clients."
                actions={
                    canCreate ? (
                        <Button asChild>
                            <Link href="/staff/jobs/new">Add job</Link>
                        </Button>
                    ) : undefined
                }
            />

            <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 md:flex-row md:flex-wrap md:items-end">
                <div className="flex flex-1 flex-col gap-1.5 md:min-w-56">
                    <Label htmlFor="job-search">Search</Label>
                    <div className="relative">
                        <Search
                            className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                            aria-hidden="true"
                        />
                        <Input
                            id="job-search"
                            className="pl-9"
                            placeholder="Search title or client…"
                            maxLength={200}
                            value={filters.query}
                            onChange={(event) =>
                                update({ ...filters, query: event.target.value }, true)
                            }
                        />
                    </div>
                </div>
                <div className="flex flex-col gap-1.5 md:w-56">
                    <Label htmlFor="job-client-filter">Client</Label>
                    <Select
                        value={filters.clientId}
                        onValueChange={(value) =>
                            update({ ...filters, clientId: value })
                        }
                    >
                        <SelectTrigger id="job-client-filter" aria-label="Filter jobs by client">
                            <SelectValue />
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
                <div className="flex flex-col gap-1.5 md:w-44">
                    <Label htmlFor="job-state-filter">Status</Label>
                    <Select
                        value={filters.state}
                        onValueChange={(value) => update({ ...filters, state: value })}
                    >
                        <SelectTrigger id="job-state-filter" aria-label="Filter by status">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {STATE_OPTIONS.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                    {option.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    aria-pressed={filters.mine}
                    onClick={() => update({ ...filters, mine: !filters.mine })}
                >
                    Owned by me
                </Button>
                {filters.intake !== 'all' ? (
                    <span className="inline-flex items-center gap-1.5 self-end rounded-md border border-border bg-secondary px-2.5 py-1.5 text-xs font-medium text-secondary-foreground">
                        {filters.intake === 'open' ? 'Open roles' : 'Applications closed'}
                        <button
                            type="button"
                            aria-label="Clear intake filter"
                            className="rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                            onClick={() => update({ ...filters, intake: 'all' })}
                        >
                            <X className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                    </span>
                ) : null}
                {filtersActive ? (
                    <Button variant="ghost" size="sm" onClick={clearFilters}>
                        <X aria-hidden="true" />
                        Clear filters
                    </Button>
                ) : null}
            </div>

            <p role="status" className="text-xs text-muted-foreground">
                {total} job{total === 1 ? '' : 's'}
                {pending ? ' · Updating…' : ''}
            </p>

            {jobs.length === 0 ? (
                <EmptyState
                    icon={Briefcase}
                    title="No jobs match these filters"
                    description="Try a different search, or pick another client."
                    action={
                        filtersActive ? (
                            <Button variant="outline" onClick={clearFilters}>
                                Clear filters
                            </Button>
                        ) : undefined
                    }
                />
            ) : (
                <div className="overflow-hidden rounded-lg border border-border bg-card">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                {sortableHead('title', 'Title')}
                                {sortableHead('client', 'Client')}
                                {sortableHead('publication', 'Status')}
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {jobs.map((job) => {
                                const status = jobStatusLabel(job);
                                const closedIntake =
                                    job.publicationState === 'published'
                                    && job.publiclyListed === true
                                    && job.applicationState === 'closed';
                                return (
                                <TableRow
                                    key={job.id}
                                    className={cn(
                                        job.publicationState === 'draft' && 'bg-muted',
                                    )}
                                >
                                    <TableCell>
                                        <div className="flex flex-col">
                                            <Link
                                                href={`/staff/jobs/${job.id}`}
                                                className="w-fit rounded-sm font-medium text-foreground outline-none hover:text-accent-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                                            >
                                                {job.title}
                                            </Link>
                                        </div>
                                    </TableCell>
                                    <TableCell>
                                        <Link
                                            href={`/staff/clients/${job.clientId}`}
                                            className="rounded-sm text-muted-foreground outline-none hover:text-accent-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                                        >
                                            {job.clientName}
                                        </Link>
                                    </TableCell>
                                    <TableCell>
                                        <span className="flex flex-wrap items-center gap-1.5">
                                            <StatusBadge tone={statusTone(status)}>
                                                {status}
                                            </StatusBadge>
                                            {job.publicationState !== 'draft'
                                                && job.draftRevisionId ? (
                                                    <TagPill>Unpublished draft</TagPill>
                                                ) : null}
                                            {closedIntake ? (
                                                <TagPill>Applications closed</TagPill>
                                            ) : null}
                                        </span>
                                    </TableCell>
                                </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                </div>
            )}
            <nav aria-label="Directory pages" className="flex items-center justify-between gap-3">
                <Button variant="outline" size="sm" disabled={pending || page <= 1}
                    onClick={() => navigate({ ...filters, page: page - 1 })}>
                    Previous
                </Button>
                <span className="text-xs text-muted-foreground">
                    Page {page} of {totalPages}
                    {total > 0 ? ` · ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}` : ''}
                </span>
                <Button variant="outline" size="sm" disabled={pending || page >= totalPages}
                    onClick={() => navigate({ ...filters, page: page + 1 })}>
                    Next
                </Button>
            </nav>
        </div>
    );
}
