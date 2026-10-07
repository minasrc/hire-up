'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    CircleAlert,
    LayoutGrid,
    Search,
    Table2,
    X,
} from 'lucide-react';

import { Badge } from '@/components/staff-ui/badge';
import { Button } from '@/components/staff-ui/button';
import { Checkbox } from '@/components/staff-ui/checkbox';
import { Input } from '@/components/staff-ui/input';
import { Label } from '@/components/staff-ui/label';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/staff-ui/table';
import {
    EmptyState,
    InitialsAvatar,
    PageHeader,
    StatusBadge,
} from '@/components/staff-preview/shared';
import { cn } from '@/lib/utils';
import { isStrictDate } from '@/lib/recruitment-contracts';
import type {
    ApplicationCard,
    ApplicationDirectoryResult,
    RecruitmentContext,
} from '@/lib/recruitment-types';
import { RecordPreviewLink } from '../record-previews';

type DateRangeKey = 'all' | '7d' | '30d' | 'custom';

export interface ApplicationDirectoryFilters {
    query: string;
    clientId: string;
    jobId: string;
    owner: string;
    stage: string;
    review: boolean;
    dateRange: DateRangeKey;
    from: string;
    to: string;
    page: number;
    view: 'table' | 'cards';
    groupByClient: boolean;
}

const KIND_TONE: Record<string, 'accent' | 'warning' | 'success' | 'secondary'> = {
    active: 'accent',
    hired: 'success',
    rejected: 'secondary',
    withdrawn: 'secondary',
};

const selectClass =
    'rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring';

const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
    });

export function applicationSourceLabel(source: string | null | undefined): string {
    switch (source) {
        case 'public_application':
            return 'Application';
        case 'import':
            return 'CSV import';
        case 'manual':
            return 'Manual entry';
        case 'referral':
            return 'Referral';
        default:
            return 'Not provided';
    }
}

function dateRangeInvalid(filters: ApplicationDirectoryFilters): boolean {
    if (filters.dateRange !== 'custom') return false;
    if (filters.from && !isStrictDate(filters.from)) return true;
    if (filters.to && !isStrictDate(filters.to)) return true;
    return Boolean(filters.from && filters.to && filters.from > filters.to);
}

function CardView({ rows }: { rows: ApplicationCard[] }) {
    return (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map((row) => (
                <li
                    key={row.applicationId}
                    className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
                >
                    <div className="flex items-center gap-3">
                        <InitialsAvatar name={row.candidateName ?? '?'} />
                        <div className="flex min-w-0 flex-col">
                            <RecordPreviewLink
                                kind="candidate"
                                id={row.candidateId}
                                className="truncate rounded-sm font-medium text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                            >
                                {row.candidateName ?? 'Unnamed'}
                            </RecordPreviewLink>
                            <span className="truncate text-xs text-muted-foreground">
                                {row.candidateLocation ?? 'Location not provided'}
                            </span>
                        </div>
                    </div>
                    <div className="flex flex-col gap-1 text-sm">
                        <RecordPreviewLink
                            kind="job"
                            id={row.jobId}
                            className="w-fit truncate rounded-sm text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            {row.jobTitle}
                        </RecordPreviewLink>
                        <RecordPreviewLink
                            kind="client"
                            id={row.clientId}
                            className="w-fit truncate rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            {row.clientName}
                        </RecordPreviewLink>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <StatusBadge tone={KIND_TONE[row.stageKind] ?? 'secondary'}>
                            {row.stageLabel}
                        </StatusBadge>
                        <span className="text-xs text-muted-foreground">
                            {formatDate(row.receivedAt)}
                        </span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                        {[
                            row.ownerName,
                            row.source ? applicationSourceLabel(row.source) : null,
                        ]
                            .filter(Boolean)
                            .join(' · ') || 'No owner recorded'}
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground">
                        {row.publicReference}
                    </span>
                </li>
            ))}
        </ul>
    );
}

function TableView({ rows }: { rows: ApplicationCard[] }) {
    return (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>Candidate</TableHead>
                        <TableHead className="hidden md:table-cell">Job</TableHead>
                        <TableHead className="hidden lg:table-cell">Client</TableHead>
                        <TableHead>Stage</TableHead>
                        <TableHead className="hidden sm:table-cell">Owner</TableHead>
                        <TableHead className="hidden sm:table-cell">Source</TableHead>
                        <TableHead className="hidden sm:table-cell">Received</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {rows.map((row) => (
                        <TableRow key={row.applicationId}>
                            <TableCell>
                                <div className="flex min-w-0 flex-col">
                                    <RecordPreviewLink
                                        kind="candidate"
                                        id={row.candidateId}
                                        className="truncate rounded-sm font-medium text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                                    >
                                        {row.candidateName ?? 'Unnamed'}
                                    </RecordPreviewLink>
                                    <span className="font-mono text-[11px] text-muted-foreground">
                                        {row.publicReference}
                                    </span>
                                </div>
                            </TableCell>
                            <TableCell className="hidden md:table-cell">
                                <RecordPreviewLink
                                    kind="job"
                                    id={row.jobId}
                                    className="rounded-sm text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                    {row.jobTitle}
                                </RecordPreviewLink>
                            </TableCell>
                            <TableCell className="hidden lg:table-cell">
                                <RecordPreviewLink
                                    kind="client"
                                    id={row.clientId}
                                    className="rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                    {row.clientName}
                                </RecordPreviewLink>
                            </TableCell>
                            <TableCell>
                                <StatusBadge tone={KIND_TONE[row.stageKind] ?? 'secondary'}>
                                    {row.stageLabel}
                                </StatusBadge>
                            </TableCell>
                            <TableCell className="hidden text-muted-foreground sm:table-cell">
                                {row.ownerName ?? 'Not provided'}
                            </TableCell>
                            <TableCell className="hidden text-muted-foreground sm:table-cell">
                                {applicationSourceLabel(row.source)}
                            </TableCell>
                            <TableCell className="hidden text-muted-foreground sm:table-cell">
                                {formatDate(row.receivedAt)}
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}

export function ApplicationsBrowser({
    initialResult,
    initialFilters,
}: {
    initialResult: ApplicationDirectoryResult;
    initialFilters: ApplicationDirectoryFilters;
}) {
    const [filters, setFilters] = useState<ApplicationDirectoryFilters>(initialFilters);
    const [searchInput, setSearchInput] = useState(initialFilters.query);
    const [result, setResult] = useState(initialResult);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const generationRef = useRef(0);
    const abortRef = useRef<AbortController | null>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const buildParams = useCallback((current: ApplicationDirectoryFilters) => {
        const params = new URLSearchParams();
        if (current.query.trim() !== '') params.set('q', current.query.trim());
        if (current.clientId !== 'all') params.set('client', current.clientId);
        if (current.jobId !== 'all') params.set('job', current.jobId);
        if (current.owner !== 'all') params.set('owner', current.owner);
        if (current.stage !== 'all') params.set('stage', current.stage);
        if (current.review) params.set('review', '1');
        if (current.dateRange !== 'all') params.set('range', current.dateRange);
        if (current.dateRange === 'custom') {
            if (current.from) params.set('from', current.from);
            if (current.to) params.set('to', current.to);
        }
        if (current.page > 1) params.set('page', String(current.page));
        if (current.view !== 'table') params.set('view', current.view);
        if (current.groupByClient) params.set('group', 'client');
        return params;
    }, []);

    const appliedUrlRef = useRef<string>(buildParams(initialFilters).toString());
    const lastInitialRef = useRef(initialResult);

    const writeUrl = useCallback(
        (current: ApplicationDirectoryFilters, mode: 'push' | 'replace') => {
            const params = buildParams(current);
            const queryString = params.toString();
            appliedUrlRef.current = queryString;
            window.history[
                mode === 'push' ? 'pushState' : 'replaceState'
            ](null, '', `/staff/applications${queryString ? `?${queryString}` : ''}`);
        },
        [buildParams],
    );

    const fetchDirectory = useCallback(
        async (
            current: ApplicationDirectoryFilters,
            options?: { history?: 'push' | 'replace' },
        ) => {
            const generation = ++generationRef.current;
            abortRef.current?.abort();
            const controller = new AbortController();
            abortRef.current = controller;
            setLoading(true);
            setError('');
            const params = buildParams(current);
            try {
                const response = await fetch(
                    `/api/staff/applications?${params.toString()}`,
                    { signal: controller.signal, headers: { accept: 'application/json' } },
                );
                if (generation !== generationRef.current) return;
                if (!response.ok) {
                    if (
                        response.status === 401
                        || response.status === 403
                        || response.status === 428
                    ) {
                        setResult((previous) => ({
                            ...previous,
                            applications: [],
                            total: 0,
                            stages: [],
                        }));
                        setError(
                            response.status === 403
                                ? 'You do not have permission to view applications.'
                                : 'Your session expired. Sign in again.',
                        );
                    } else {
                        setError('Applications could not be loaded.');
                    }
                    setLoading(false);
                    return;
                }
                const payload = await response.json();
                if (generation !== generationRef.current) return;
                setResult(payload.result as ApplicationDirectoryResult);
                setLoading(false);
                writeUrl(current, options?.history ?? 'push');
            } catch (fetchError) {
                if ((fetchError as { name?: string })?.name === 'AbortError') return;
                if (generation !== generationRef.current) return;
                setError('Applications could not be loaded.');
                setLoading(false);
            }
        },
        [buildParams, writeUrl],
    );

    useEffect(() => () => {
        generationRef.current += 1;
        abortRef.current?.abort();
        if (debounceRef.current) clearTimeout(debounceRef.current);
    }, []);

    const searchParams = useSearchParams();
    const urlKey = searchParams.toString();
    const urlFilters = useMemo<ApplicationDirectoryFilters>(() => {
        const params = new URLSearchParams(urlKey);
        const range = params.get('range') ?? '';
        return {
            query: params.get('q') ?? '',
            clientId: params.get('client') ?? 'all',
            jobId: params.get('job') ?? 'all',
            owner: params.get('owner') ?? 'all',
            stage: params.get('stage') ?? 'all',
            review: params.get('review') === '1' || params.get('review') === 'true',
            dateRange: (['7d', '30d', 'custom'] as const).includes(range as never)
                ? (range as DateRangeKey)
                : 'all',
            from: params.get('from') ?? '',
            to: params.get('to') ?? '',
            page: Math.max(1, Number(params.get('page')) || 1),
            view: params.get('view') === 'cards' ? 'cards' : 'table',
            groupByClient: params.get('group') === 'client',
        };
    }, [urlKey]);

    useEffect(() => {
        if (initialResult === lastInitialRef.current) return;
        lastInitialRef.current = initialResult;
        appliedUrlRef.current = buildParams(initialFilters).toString();
        setResult(initialResult);
        setFilters(initialFilters);
        setSearchInput(initialFilters.query);
    }, [initialResult, initialFilters, buildParams]);

    useEffect(() => {
        if (urlKey === appliedUrlRef.current) return;
        appliedUrlRef.current = urlKey;
        if (debounceRef.current) clearTimeout(debounceRef.current);
        setFilters(urlFilters);
        setSearchInput(urlFilters.query);
        void fetchDirectory(urlFilters, { history: 'replace' });
    }, [urlKey, urlFilters, fetchDirectory]);

    const apply = useCallback(
        (
            patch: Partial<ApplicationDirectoryFilters>,
            resetPage = true,
            history: 'push' | 'replace' = 'push',
        ) => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
            const next = { ...filters, ...patch };
            if (resetPage) next.page = 1;
            if (patch.clientId !== undefined) next.jobId = 'all';
            if (patch.stage !== undefined) next.review = false;
            setFilters(next);
            if (dateRangeInvalid(next)) {
                writeUrl(next, history);
                return;
            }
            void fetchDirectory(next, { history });
        },
        [filters, fetchDirectory, writeUrl],
    );

    const applyLocal = useCallback(
        (patch: Partial<ApplicationDirectoryFilters>) => {
            const next = { ...filters, ...patch };
            setFilters(next);
            writeUrl(next, 'push');
        },
        [filters, writeUrl],
    );

    const onSearchChange = (value: string) => {
        setSearchInput(value);
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
            apply({ query: value }, true, 'replace');
        }, 250);
    };

    const context: RecruitmentContext | undefined = result.context;
    const owners = useMemo(() => context?.owners ?? [], [context]);
    const clientById = useMemo(
        () => new Map((result.clients ?? []).map((client) => [client.id, client.name])),
        [result.clients],
    );
    const jobById = useMemo(
        () => new Map((result.jobs ?? []).map((job) => [job.id, job.title])),
        [result.jobs],
    );

    const scopedClient =
        filters.clientId !== 'all' ? clientById.get(filters.clientId) : undefined;
    const scopedJob =
        filters.jobId !== 'all' ? jobById.get(filters.jobId) : undefined;

    const total = result.total ?? 0;
    const pageSize = result.pageSize || 25;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const pageStart = total === 0 ? 0 : (result.page - 1) * pageSize + 1;
    const pageEnd = Math.min(total, result.page * pageSize);

    const grouped = useMemo(() => {
        if (!filters.groupByClient) return null;
        const map = new Map<string, { name: string; rows: ApplicationCard[] }>();
        for (const row of result.applications) {
            const entry = map.get(row.clientId)
                ?? { name: row.clientName, rows: [] };
            entry.rows.push(row);
            map.set(row.clientId, entry);
        }
        return Array.from(map.entries());
    }, [filters.groupByClient, result.applications]);

    const clearAll = () => {
        setSearchInput('');
        apply({
            query: '',
            clientId: 'all',
            jobId: 'all',
            owner: 'all',
            stage: 'all',
            review: false,
            dateRange: 'all',
            from: '',
            to: '',
        });
    };

    const filtersActive =
        filters.query !== ''
        || filters.clientId !== 'all'
        || filters.jobId !== 'all'
        || filters.owner !== 'all'
        || filters.stage !== 'all'
        || filters.review
        || filters.dateRange !== 'all';

    const invalidRange = dateRangeInvalid(filters);

    const stageCard = (value: string, label: string, count: number) => {
        const active = filters.stage === value;
        return (
            <button
                key={value}
                type="button"
                aria-pressed={active}
                onClick={() => apply({ stage: value })}
                className={cn(
                    'flex flex-col gap-0.5 rounded-lg border border-border bg-card px-4 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                    active ? 'border-ring bg-accent' : 'hover:border-input hover:bg-hover',
                )}
            >
                <span className="text-sm text-muted-foreground">{label}</span>
                <span className="text-[26px] leading-8 font-semibold text-foreground">
                    {count}
                </span>
            </button>
        );
    };

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                eyebrow="Workspace"
                title="Applications"
                description="Review candidates across your clients and open roles."
                actions={
                    <div className="flex items-center gap-2">
                        <Button
                            variant={filters.view === 'table' ? 'secondary' : 'outline'}
                            size="sm"
                            aria-pressed={filters.view === 'table'}
                            onClick={() => applyLocal({ view: 'table' })}
                        >
                            <Table2 aria-hidden="true" />
                            Table
                        </Button>
                        <Button
                            variant={filters.view === 'cards' ? 'secondary' : 'outline'}
                            size="sm"
                            aria-pressed={filters.view === 'cards'}
                            onClick={() => applyLocal({ view: 'cards' })}
                        >
                            <LayoutGrid aria-hidden="true" />
                            Cards
                        </Button>
                        <label className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Checkbox
                                checked={filters.groupByClient}
                                onCheckedChange={(checked) =>
                                    applyLocal({ groupByClient: checked === true })
                                }
                                aria-label="Group by client"
                            />
                            Group by client
                        </label>
                    </div>
                }
            />

            {(scopedClient || scopedJob) ? (
                <section
                    aria-label="Current application context"
                    className="flex flex-col gap-2 rounded-lg border border-border bg-secondary/50 p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                    <div className="flex flex-col gap-0.5">
                        <span className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                            Client context
                        </span>
                        {scopedClient ? (
                            <span className="text-base font-semibold text-foreground">
                                {scopedClient}
                            </span>
                        ) : null}
                        {scopedJob ? (
                            <span className="text-sm text-muted-foreground">
                                Job · {scopedJob}
                            </span>
                        ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        {scopedClient && filters.clientId !== 'all' ? (
                            <Button variant="outline" size="sm" asChild>
                                <Link href={`/staff/clients/${filters.clientId}`}>
                                    Open client
                                </Link>
                            </Button>
                        ) : null}
                        {scopedJob && filters.jobId !== 'all' ? (
                            <Button variant="outline" size="sm" asChild>
                                <Link href={`/staff/jobs/${filters.jobId}`}>
                                    Open job
                                </Link>
                            </Button>
                        ) : null}
                    </div>
                </section>
            ) : null}

            <div
                className="grid grid-cols-2 gap-3 sm:grid-cols-4"
                role="group"
                aria-label="Stage filter cards"
            >
                {stageCard('all', 'All applications', result.allCount ?? 0)}
                {(result.stages ?? []).map((stage) =>
                    stageCard(stage.key, stage.label, stage.count))}
            </div>

            {(scopedClient || scopedJob) ? (
                <div className="flex flex-wrap items-center gap-2">
                    {scopedClient ? (
                        <Badge variant="secondary" className="gap-1.5">
                            Client: {scopedClient}
                            <button
                                type="button"
                                aria-label="Clear client filter"
                                className="rounded-full outline-none hover:text-destructive focus-visible:ring-1 focus-visible:ring-ring"
                                onClick={() => apply({ clientId: 'all', jobId: 'all' })}
                            >
                                <X className="h-3 w-3" aria-hidden="true" />
                            </button>
                        </Badge>
                    ) : null}
                    {scopedJob ? (
                        <Badge variant="secondary" className="gap-1.5">
                            Job: {scopedJob}
                            <button
                                type="button"
                                aria-label="Clear job filter"
                                className="rounded-full outline-none hover:text-destructive focus-visible:ring-1 focus-visible:ring-ring"
                                onClick={() => apply({ jobId: 'all' })}
                            >
                                <X className="h-3 w-3" aria-hidden="true" />
                            </button>
                        </Badge>
                    ) : null}
                </div>
            ) : null}

            <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4">
                <div className="flex flex-wrap items-end gap-3">
                    <div className="flex min-w-[200px] flex-1 flex-col gap-1.5">
                        <Label htmlFor="application-search">Search</Label>
                        <div className="relative">
                            <Search
                                className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                                aria-hidden="true"
                            />
                            <Input
                                id="application-search"
                                className="pl-9"
                                placeholder="Candidate, job, client or reference…"
                                value={searchInput}
                                onChange={(event) => onSearchChange(event.target.value)}
                            />
                        </div>
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor="application-client-filter">Client</Label>
                        <select
                            id="application-client-filter"
                            className={selectClass}
                            value={filters.clientId}
                            onChange={(event) =>
                                apply({ clientId: event.target.value })
                            }
                        >
                            <option value="all">All clients</option>
                            {(result.clients ?? []).map((client) => (
                                <option key={client.id} value={client.id}>
                                    {client.name}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor="application-job-filter">Job</Label>
                        <select
                            id="application-job-filter"
                            className={selectClass}
                            value={filters.jobId}
                            onChange={(event) => apply({ jobId: event.target.value })}
                        >
                            <option value="all">All jobs</option>
                            {(result.jobs ?? []).map((job) => (
                                <option key={job.id} value={job.id}>
                                    {job.title}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor="application-owner-filter">Owner</Label>
                        <select
                            id="application-owner-filter"
                            className={selectClass}
                            value={filters.owner}
                            onChange={(event) => apply({ owner: event.target.value })}
                        >
                            <option value="all">All owners</option>
                            <option value="mine">Assigned to me</option>
                            {owners.map((owner) => (
                                <option key={owner.id} value={owner.id}>
                                    {owner.name}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor="application-range-filter">Received</Label>
                        <select
                            id="application-range-filter"
                            className={selectClass}
                            value={filters.dateRange}
                            onChange={(event) =>
                                apply({ dateRange: event.target.value as DateRangeKey })
                            }
                        >
                            <option value="all">All time</option>
                            <option value="7d">Last 7 days</option>
                            <option value="30d">Last 30 days</option>
                            <option value="custom">Custom range</option>
                        </select>
                    </div>
                    {filters.dateRange === 'custom' ? (
                        <div className="flex items-end gap-2">
                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor="application-from">From</Label>
                                <Input
                                    id="application-from"
                                    type="date"
                                    value={filters.from}
                                    onChange={(event) =>
                                        apply({ from: event.target.value })
                                    }
                                />
                            </div>
                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor="application-to">To</Label>
                                <Input
                                    id="application-to"
                                    type="date"
                                    value={filters.to}
                                    onChange={(event) =>
                                        apply({ to: event.target.value })
                                    }
                                />
                            </div>
                            <span className="pb-2 text-xs text-muted-foreground">
                                Dates use UTC
                            </span>
                        </div>
                    ) : null}
                    <button
                        type="button"
                        aria-pressed={filters.review}
                        onClick={() => apply({ review: !filters.review })}
                        className={cn(
                            'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                            filters.review
                                ? 'border-ring bg-nav-active text-foreground'
                                : 'border-border text-muted-foreground hover:bg-hover',
                        )}
                    >
                        Awaiting review
                    </button>
                    {filtersActive ? (
                        <Button variant="ghost" size="sm" onClick={clearAll}>
                            <X aria-hidden="true" />
                            Clear filters
                        </Button>
                    ) : null}
                </div>

                {invalidRange ? (
                    <p
                        role="alert"
                        className="flex items-center gap-2 text-sm text-destructive"
                    >
                        <CircleAlert className="h-4 w-4" aria-hidden="true" />
                        The From date is after the To date — adjust the custom range.
                    </p>
                ) : null}
            </div>

            {error ? (
                <div
                    role="alert"
                    className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3"
                >
                    <p className="text-sm text-destructive">{error}</p>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void fetchDirectory(filters)}
                    >
                        Retry
                    </Button>
                </div>
            ) : null}

            {loading ? (
                <p role="status" className="text-xs text-muted-foreground">
                    Loading applications…
                </p>
            ) : null}

            {invalidRange ? (
                <p className="text-sm text-muted-foreground">
                    Fix the date range to see results.
                </p>
            ) : result.applications.length === 0 && !loading ? (
                <EmptyState
                    icon={Search}
                    title="No applications found"
                    description={
                        filtersActive
                            ? 'Try clearing the search or filters.'
                            : 'Applications appear here when candidates apply or are added to jobs.'
                    }
                />
            ) : grouped ? (
                <div className="flex flex-col gap-6">
                    {grouped.map(([clientId, group]) => (
                        <section key={clientId} className="flex flex-col gap-3">
                            <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                                <RecordPreviewLink
                                    kind="client"
                                    id={clientId}
                                    className="rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                    {group.name}
                                </RecordPreviewLink>
                                <Badge variant="secondary">
                                    {group.rows.length} on this page
                                </Badge>
                            </h2>
                            {filters.view === 'cards' ? (
                                <CardView rows={group.rows} />
                            ) : (
                                <TableView rows={group.rows} />
                            )}
                        </section>
                    ))}
                </div>
            ) : filters.view === 'cards' ? (
                <CardView rows={result.applications} />
            ) : (
                <TableView rows={result.applications} />
            )}

            {pageCount > 1 ? (
                <div className="flex items-center justify-center gap-3">
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={result.page <= 1 || loading}
                        onClick={() => apply({ page: result.page - 1 }, false)}
                    >
                        Previous
                    </Button>
                    <span className="text-sm text-muted-foreground">
                        {pageStart}–{pageEnd} of {total} applications
                    </span>
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={result.page >= pageCount || loading}
                        onClick={() => apply({ page: result.page + 1 }, false)}
                    >
                        Next
                    </Button>
                </div>
            ) : (
                <p className="text-center text-xs text-muted-foreground">
                    {total} application{total === 1 ? '' : 's'}
                </p>
            )}
        </div>
    );
}
