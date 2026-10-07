'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
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
import { optionParam, textParam } from '../filter-params';
import { RecordPreviewLink } from '../record-previews';

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
    query: string;
    status: string;
    view: ClientView;
}

const STATUS_VALUES = ['all', 'active', 'draft'] as const;
const VIEW_VALUES = ['cards', 'table'] as const;

const parseFilters = (params: { get(name: string): string | null }): ClientFiltersState => ({
    query: textParam(params, 'q'),
    status: optionParam(params, 'status', STATUS_VALUES, 'all'),
    view: optionParam(params, 'view', VIEW_VALUES, 'cards'),
});

function syncUrl(filters: ClientFiltersState) {
    const params = new URLSearchParams();
    if (filters.query.trim()) params.set('q', filters.query);
    if (filters.status !== 'all') params.set('status', filters.status);
    if (filters.view !== 'cards') params.set('view', filters.view);
    const query = params.toString();
    window.history.replaceState(
        null, '', `/staff/clients${query ? `?${query}` : ''}`);
}

export function ClientsBrowser({
    clients,
    canCreate,
    canReadJobs = true,
    canReadApplications = true,
    capped,
}: {
    clients: ClientRow[];
    canCreate: boolean;
    canReadJobs?: boolean;
    canReadApplications?: boolean;
    capped: boolean;
}) {
    const searchParams = useSearchParams();
    const filters = parseFilters(searchParams);

    const update = (next: ClientFiltersState) => {
        syncUrl(next);
    };

    const term = filters.query.trim().toLowerCase();
    const filteredClients = useMemo(
        () =>
            clients.filter((client) => {
                if (filters.status !== 'all' && client.status !== filters.status) return false;
                if (!term) return true;
                return client.name.toLowerCase().includes(term);
            }),
        [clients, filters.status, term],
    );

    const filtersActive = term !== '' || filters.status !== 'all';
    const clearFilters = () => update({ ...filters, query: '', status: 'all' });

    return (
        <div className="flex flex-col gap-6">
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
                            value={filters.query}
                            onChange={(event) =>
                                update({ ...filters, query: event.target.value })
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
                    {filteredClients.length} client{filteredClients.length === 1 ? '' : 's'}
                    {capped
                        ? ' · Showing the latest 500 clients; filters apply to loaded records'
                        : ''}
                </p>
                <div
                    className="flex items-center rounded-lg border border-border"
                    role="group"
                    aria-label="Clients view"
                >
                    <button
                        type="button"
                        aria-pressed={filters.view === 'cards'}
                        onClick={() => update({ ...filters, view: 'cards' })}
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
                        onClick={() => update({ ...filters, view: 'table' })}
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

            {filteredClients.length === 0 ? (
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
                            {filteredClients.map((client) => (
                                <TableRow
                                    key={client.id}
                                    className={cn(
                                        client.status === 'draft' && 'bg-muted',
                                    )}
                                >
                                    <TableCell>
                                        <div className="flex items-center gap-3">
                                            <InitialsAvatar name={client.name} size="sm" />
                                            <RecordPreviewLink
                                                kind="client"
                                                id={client.id}
                                                className="w-fit rounded-sm font-medium text-foreground outline-none hover:text-accent-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                                            >
                                                {client.name}
                                            </RecordPreviewLink>
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
                    {filteredClients.map((client) => (
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
                                        <RecordPreviewLink
                                            kind="client"
                                            id={client.id}
                                            className="truncate rounded-sm text-sm font-semibold text-foreground outline-none after:absolute after:inset-0 hover:text-accent-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                                        >
                                            {client.name}
                                        </RecordPreviewLink>
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
        </div>
    );
}
