'use client';

import Link from 'next/link';
import { Building2, LayoutGrid, Search, Table2, X } from 'lucide-react';

import { Badge } from '@/components/staff-ui/badge';
import { Button } from '@/components/staff-ui/button';
import { Card, CardContent } from '@/components/staff-ui/card';
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
import {
    EmptyState,
    InitialsAvatar,
    PageHeader,
    StatusBadge,
} from '@/components/staff-preview/shared';
import { cn } from '@/lib/utils';
import { useDirectoryNavigation } from '../use-directory-navigation';
import { optionParam, textParam } from '../filter-params';

export interface ClientRow {
    id: string;
    name: string;
    status: string;
    isStealth: boolean;
    jobCount: number;
    createdAt: string;
}

type ClientView = 'cards' | 'table';

export interface ClientFiltersState {
    page: number;
    query: string;
    status: string;
    view: ClientView;
}

const STATUS_VALUES = ['all', 'active', 'draft'] as const;
const VIEW_VALUES = ['cards', 'table'] as const;

const parseFilters = (params: { get(name: string): string | null }): ClientFiltersState => ({
    page: /^\d+$/.test(params.get('page') ?? '')
        ? Math.min(1000000, Math.max(1, Number(params.get('page')))) : 1,
    query: textParam(params, 'q'),
    status: optionParam(params, 'status', STATUS_VALUES, 'all'),
    view: optionParam(params, 'view', VIEW_VALUES, 'cards'),
});

function serializeFilters(filters: ClientFiltersState) {
    const params = new URLSearchParams();
    if (filters.query.trim()) params.set('q', filters.query);
    if (filters.status !== 'all') params.set('status', filters.status);
    if (filters.view !== 'cards') params.set('view', filters.view);
    if (filters.page > 1) params.set('page', String(filters.page));
    return params.toString();
}

export function ClientsBrowser({
    clients,
    canCreate,
    canReadJobs = true,
    canReadApplications = true,
    total,
    page,
    pageSize,
}: {
    clients: ClientRow[];
    canCreate: boolean;
    canReadJobs?: boolean;
    canReadApplications?: boolean;
    total: number;
    page: number;
    pageSize: number;
}) {
    const { filters, update: navigate, pending } = useDirectoryNavigation(
        '/staff/clients', parseFilters, serializeFilters,
    );
    const update = (next: ClientFiltersState, debounce = false) => {
        navigate({ ...next, page: 1 }, debounce);
    };
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const filtersActive = filters.query.trim() !== '' || filters.status !== 'all';
    const clearFilters = () => update({ ...filters, query: '', status: 'all' });

    return (
        <div className="flex flex-col gap-6" aria-busy={pending}>
            <PageHeader
                eyebrow="Workspace"
                title="Clients"
                description="Your client relationships and hiring activity."
                actions={
                    canCreate ? (
                        <Button asChild>
                            <Link href="/staff/clients/new">Add client</Link>
                        </Button>
                    ) : undefined
                }
            />

            <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 md:flex-row md:items-end">
                <div className="flex flex-1 flex-col gap-1.5">
                    <Label htmlFor="client-search">Search clients</Label>
                    <div className="relative">
                        <Search
                            className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                            aria-hidden="true"
                        />
                        <Input
                            id="client-search"
                            className="pl-9"
                            placeholder="Search name…"
                            maxLength={200}
                            value={filters.query}
                            onChange={(event) =>
                                update({ ...filters, query: event.target.value }, true)
                            }
                        />
                    </div>
                </div>
                <div className="flex flex-col gap-1.5 md:w-44">
                    <Label htmlFor="client-status-filter">Status</Label>
                    <Select
                        value={filters.status}
                        onValueChange={(value) => update({ ...filters, status: value })}
                    >
                        <SelectTrigger id="client-status-filter" aria-label="Filter clients by status">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All statuses</SelectItem>
                            <SelectItem value="active">Active</SelectItem>
                            <SelectItem value="draft">Draft</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
                {filtersActive ? (
                    <Button variant="ghost" size="sm" onClick={clearFilters}>
                        <X aria-hidden="true" />
                        Clear filters
                    </Button>
                ) : null}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
                <p role="status" className="text-xs text-muted-foreground">
                    {total} client{total === 1 ? '' : 's'}
                    {pending ? ' · Updating…' : ''}
                </p>
                <div
                    className="flex items-center rounded-lg border border-border"
                    role="group"
                    aria-label="Clients view"
                >
                    <button
                        type="button"
                        aria-pressed={filters.view === 'cards'}
                        onClick={() => navigate({ ...filters, page, view: 'cards' }, false, true)}
                        className={cn(
                            'flex items-center gap-1.5 rounded-l-lg px-3 py-1.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                            filters.view === 'cards'
                                ? 'bg-accent text-accent-foreground'
                                : 'text-muted-foreground hover:bg-hover',
                        )}
                    >
                        <LayoutGrid className="h-4 w-4" aria-hidden="true" />
                        Cards
                    </button>
                    <button
                        type="button"
                        aria-pressed={filters.view === 'table'}
                        onClick={() => navigate({ ...filters, page, view: 'table' }, false, true)}
                        className={cn(
                            'flex items-center gap-1.5 rounded-r-lg border-l border-border px-3 py-1.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                            filters.view === 'table'
                                ? 'bg-accent text-accent-foreground'
                                : 'text-muted-foreground hover:bg-hover',
                        )}
                    >
                        <Table2 className="h-4 w-4" aria-hidden="true" />
                        Table
                    </button>
                </div>
            </div>

            {clients.length === 0 ? (
                <EmptyState
                    icon={Building2}
                    title="No clients found"
                    description="Try a different name or status."
                    action={
                        filtersActive ? (
                            <Button variant="outline" onClick={clearFilters}>
                                Clear filters
                            </Button>
                        ) : undefined
                    }
                />
            ) : filters.view === 'table' ? (
                <div className="overflow-hidden rounded-lg border border-border bg-card">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Client</TableHead>
                                <TableHead>Status</TableHead>
                                <TableHead>Jobs</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {clients.map((client) => (
                                <TableRow
                                    key={client.id}
                                    className={cn(
                                        client.status === 'draft' && 'bg-muted',
                                    )}
                                >
                                    <TableCell>
                                        <div className="flex items-center gap-3">
                                            <InitialsAvatar name={client.name} size="sm" />
                                            <Link
                                                href={`/staff/clients/${client.id}`}
                                                className="w-fit rounded-sm font-medium text-foreground outline-none hover:text-accent-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                                            >
                                                {client.name}
                                            </Link>
                                        </div>
                                    </TableCell>
                                    <TableCell>
                                        <span className="flex flex-wrap items-center gap-1.5">
                                            <StatusBadge
                                                tone={
                                                    client.status === 'draft'
                                                        ? 'secondary'
                                                        : 'success'
                                                }
                                            >
                                                {client.status === 'draft' ? 'Draft' : 'Active'}
                                            </StatusBadge>
                                            {client.isStealth ? (
                                                <Badge variant="outline">Stealth</Badge>
                                            ) : null}
                                        </span>
                                    </TableCell>
                                    <TableCell>
                                        {canReadJobs ? (
                                            <Link
                                                href={`/staff/jobs?client=${client.id}`}
                                                className="rounded-sm text-xs font-medium text-accent-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                                            >
                                                {client.jobCount} job{client.jobCount === 1 ? '' : 's'}
                                            </Link>
                                        ) : (
                                            <span className="text-xs text-muted-foreground">
                                                {client.jobCount} job{client.jobCount === 1 ? '' : 's'}
                                            </span>
                                        )}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </div>
            ) : (
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {clients.map((client) => (
                        <Card
                            key={client.id}
                            className={cn(
                                'relative',
                                client.status === 'draft' && 'bg-muted',
                            )}
                        >
                            <CardContent className="flex flex-col gap-4 p-5">
                                <div className="flex items-center gap-3">
                                    <InitialsAvatar name={client.name} />
                                    <div className="flex min-w-0 flex-col">
                                        <Link
                                            href={`/staff/clients/${client.id}`}
                                            className="truncate rounded-sm text-sm font-semibold text-foreground outline-none after:absolute after:inset-0 hover:text-accent-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                                        >
                                            {client.name}
                                        </Link>
                                        <span className="text-xs text-muted-foreground">
                                            {client.status === 'draft' ? 'Draft client' : 'Active client'}
                                        </span>
                                    </div>
                                    <div className="relative z-10 ml-auto flex w-fit flex-col items-end gap-1">
                                        {client.status === 'draft' ? (
                                            <StatusBadge tone="secondary">Draft</StatusBadge>
                                        ) : null}
                                        {client.isStealth ? (
                                            <Badge variant="outline">
                                                Identity hidden externally
                                            </Badge>
                                        ) : null}
                                    </div>
                                </div>
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    {canReadJobs ? (
                                        <Link
                                            href={`/staff/jobs?client=${client.id}`}
                                            className="relative z-10 rounded-sm text-xs font-medium text-accent-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                                        >
                                            {client.jobCount} job{client.jobCount === 1 ? '' : 's'}
                                        </Link>
                                    ) : (
                                        <span className="text-xs text-muted-foreground">
                                            {client.jobCount} job{client.jobCount === 1 ? '' : 's'}
                                        </span>
                                    )}
                                    {canReadApplications ? (
                                        <Link
                                            href={`/staff/applications?client=${client.id}`}
                                            className="relative z-10 rounded-sm text-xs font-medium text-accent-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                                        >
                                            Applications
                                        </Link>
                                    ) : null}
                                </div>
                            </CardContent>
                        </Card>
                    ))}
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
