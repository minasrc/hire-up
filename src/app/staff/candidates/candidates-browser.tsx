'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
    FileText,
    Search,
    ShieldAlert,
    Tag,
    Upload,
    X,
} from 'lucide-react';

import { Badge } from '@/components/staff-ui/badge';
import { Button } from '@/components/staff-ui/button';
import { Checkbox } from '@/components/staff-ui/checkbox';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/staff-ui/dialog';
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
import { Tabs, TabsList, TabsTrigger } from '@/components/staff-ui/tabs';
import {
    EmptyState,
    InitialsAvatar,
    PageHeader,
    StatusBadge,
    TagPill,
} from '@/components/staff-preview/shared';
import { staffMutation } from '@/lib/staff-mutation';
import type {
    CandidateCard,
    CandidateDirectoryResult,
    RecruitmentContext,
} from '@/lib/recruitment-types';
import { RecordPreviewLink } from '../record-previews';
import { AddCandidateDialog } from './add-candidate-dialog';

type DirectoryTab = 'all' | 'mine' | 'recent';

type DirectoryFilters = CandidateDirectoryFilters;

const PAGE_SIZE = 25;
const SELECTION_MAX = 100;

const selectClass =
    'rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring';

export interface CandidateDirectoryFilters {
    tab: DirectoryTab;
    owner: string;
    tag: string;
    query: string;
}

const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric',
    });

export function CandidatesBrowser({
    context,
    initialResult,
    initialFilters,
}: {
    context: RecruitmentContext;
    initialResult: CandidateDirectoryResult;
    initialFilters: CandidateDirectoryFilters;
}) {
    const router = useRouter();
    const searchParams = useSearchParams();
    const [filters, setFilters] = useState<DirectoryFilters>(initialFilters);
    const [searchInput, setSearchInput] = useState(initialFilters.query);
    const [page, setPage] = useState(initialResult.page || 1);
    const [result, setResult] = useState(initialResult);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [tagDialogOpen, setTagDialogOpen] = useState(false);
    const [tagDraft, setTagDraft] = useState('');
    const [tagPending, setTagPending] = useState(false);
    const [tagError, setTagError] = useState('');
    const generationRef = useRef(0);
    const abortRef = useRef<AbortController | null>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const bulkOperationRef = useRef<string>(crypto.randomUUID());

    const liveContext = result.context ?? context;
    const capabilities = liveContext.capabilities;
    const canWrite = capabilities.writeCandidates === true;

    const buildParams = useCallback(
        (current: DirectoryFilters, currentPage: number) => {
            const params = new URLSearchParams();
            if (current.tab !== 'all') params.set('tab', current.tab);
            if (current.owner !== 'all') params.set('owner', current.owner);
            if (current.tag !== 'all') params.set('tag', current.tag);
            if (current.query.trim() !== '') params.set('q', current.query.trim());
            if (currentPage > 1) params.set('page', String(currentPage));
            return params;
        },
        [],
    );

    const appliedUrlRef = useRef<string>(
        buildParams(initialFilters, initialResult.page || 1).toString());
    const lastInitialRef = useRef(initialResult);

    const writeUrl = useCallback(
        (current: DirectoryFilters, currentPage: number, mode: 'push' | 'replace') => {
            const queryString = buildParams(current, currentPage).toString();
            appliedUrlRef.current = queryString;
            window.history[
                mode === 'push' ? 'pushState' : 'replaceState'
            ](null, '', `/staff/candidates${queryString ? `?${queryString}` : ''}`);
        },
        [buildParams],
    );

    const fetchDirectory = useCallback(
        async (
            current: DirectoryFilters,
            currentPage: number,
            options?: { history?: 'push' | 'replace' },
        ) => {
            const generation = ++generationRef.current;
            abortRef.current?.abort();
            const controller = new AbortController();
            abortRef.current = controller;
            setLoading(true);
            setError('');
            const params = buildParams(current, currentPage);
            try {
                const response = await fetch(
                    `/api/staff/candidates?${params.toString()}`,
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
                            candidates: [],
                            total: 0,
                            counts: {
                                all: 0,
                                restricted: 0,
                                withApplications: null,
                            },
                        }));
                        setError(
                            response.status === 403
                                ? 'You do not have permission to view candidates.'
                                : 'Your session expired. Sign in again.',
                        );
                    } else {
                        setError('Candidates could not be loaded.');
                    }
                    setLoading(false);
                    return;
                }
                const payload = await response.json();
                if (generation !== generationRef.current) return;
                setResult(payload.result as CandidateDirectoryResult);
                setLoading(false);
                writeUrl(current, currentPage, options?.history ?? 'push');
            } catch (fetchError) {
                if ((fetchError as { name?: string })?.name === 'AbortError') return;
                if (generation !== generationRef.current) return;
                setError('Candidates could not be loaded.');
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

    const urlKey = searchParams.toString();
    useEffect(() => {
        if (initialResult === lastInitialRef.current) return;
        lastInitialRef.current = initialResult;
        if (debounceRef.current) clearTimeout(debounceRef.current);
        appliedUrlRef.current = buildParams(
            initialFilters, initialResult.page || 1).toString();
        setResult(initialResult);
        setFilters(initialFilters);
        setSearchInput(initialFilters.query);
        setPage(initialResult.page || 1);
    }, [initialResult, initialFilters, buildParams]);

    useEffect(() => {
        if (urlKey === appliedUrlRef.current) return;
        appliedUrlRef.current = urlKey;
        if (debounceRef.current) clearTimeout(debounceRef.current);
        const params = new URLSearchParams(urlKey);
        const tabParam = params.get('tab');
        const nextFilters: DirectoryFilters = {
            tab: tabParam === 'mine' || tabParam === 'recent' ? tabParam : 'all',
            owner: params.get('owner') ?? 'all',
            tag: params.get('tag') ?? 'all',
            query: params.get('q') ?? '',
        };
        const nextPage = Math.max(1, Number(params.get('page')) || 1);
        setFilters(nextFilters);
        setSearchInput(nextFilters.query);
        setPage(nextPage);
        void fetchDirectory(nextFilters, nextPage, { history: 'replace' });
    }, [urlKey, fetchDirectory]);

    const applyFilters = useCallback(
        (patch: Partial<DirectoryFilters>, nextPage = 1) => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
            const next = { ...filters, ...patch };
            setFilters(next);
            setPage(nextPage);
            void fetchDirectory(next, nextPage);
        },
        [filters, fetchDirectory],
    );

    const onSearchChange = (value: string) => {
        setSearchInput(value);
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
            const next = { ...filters, query: value };
            setFilters(next);
            setPage(1);
            void fetchDirectory(next, 1, { history: 'replace' });
        }, 250);
    };

    const goToPage = (nextPage: number) => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        setPage(nextPage);
        void fetchDirectory(filters, nextPage);
    };

    const retry = () => void fetchDirectory(filters, page);

    const toggleSelect = (candidateId: string, checked: boolean) => {
        setSelected((current) => {
            const next = new Set(current);
            if (checked) {
                if (next.size >= SELECTION_MAX) return current;
                next.add(candidateId);
            } else {
                next.delete(candidateId);
            }
            return next;
        });
    };

    const eligibleOnPage = useMemo(
        () => result.candidates.filter((row) => row.lifecycle === 'active'),
        [result.candidates],
    );
    const eligibleSelectedOnPage = eligibleOnPage.filter(
        (row) => selected.has(row.candidateId));
    const selectAllState: boolean | 'indeterminate' =
        eligibleOnPage.length > 0
        && eligibleSelectedOnPage.length === eligibleOnPage.length
            ? true
            : eligibleSelectedOnPage.length > 0
              ? 'indeterminate'
              : false;

    const toggleSelectAll = (checked: boolean) => {
        setSelected((current) => {
            const next = new Set(current);
            if (checked) {
                for (const row of eligibleOnPage) {
                    if (next.size >= SELECTION_MAX) break;
                    next.add(row.candidateId);
                }
            } else {
                for (const row of eligibleOnPage) {
                    next.delete(row.candidateId);
                }
            }
            return next;
        });
    };

    const selectedCards = useMemo(
        () => result.candidates.filter(
            (row) => selected.has(row.candidateId) && row.lifecycle === 'active',
        ),
        [result.candidates, selected],
    );

    const applyBulkTag = async () => {
        const tag = tagDraft.trim();
        if (tag === '' || tagPending || selectedCards.length === 0) return;
        setTagPending(true);
        setTagError('');
        try {
            await staffMutation('/api/staff/candidates/tags', {
                candidates: selectedCards.map((row) => ({
                    candidateId: row.candidateId,
                    expectedVersion: row.version,
                })),
                tag,
                operationId: bulkOperationRef.current,
            });
            setTagDialogOpen(false);
            setTagDraft('');
            setSelected(new Set());
            bulkOperationRef.current = crypto.randomUUID();
            void fetchDirectory(filters, page, { history: 'replace' });
        } catch (caught) {
            setTagError(
                caught instanceof Error ? caught.message : 'Could not apply the tag.',
            );
        } finally {
            setTagPending(false);
        }
    };

    const total = result.total ?? result.candidates.length;
    const pageCount = Math.max(1, Math.ceil(total / (result.pageSize || PAGE_SIZE)));
    const counts = result.counts;
    const pageOutOfRange =
        result.candidates.length === 0 && (result.page || page) > 1;

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                eyebrow="Workspace"
                title="Candidates"
                description="Everyone who has applied or been added, deduplicated by email."
                actions={
                    <>
                        <Button size="sm" variant="outline" asChild>
                            <Link href="/staff/candidates/import">
                                <Upload aria-hidden="true" />
                                Import CSV
                            </Link>
                        </Button>
                        {canWrite ? (
                            <AddCandidateDialog
                                context={liveContext}
                                onCreated={(candidateId) =>
                                    router.push(`/staff/candidates/${candidateId}`)
                                }
                            />
                        ) : null}
                    </>
                }
            />

            <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4">
                <Tabs
                    value={filters.tab}
                    onValueChange={(value) =>
                        applyFilters({ tab: value as DirectoryTab })
                    }
                >
                    <div className="flex flex-wrap items-center gap-3">
                        <TabsList aria-label="Candidate filters">
                            <TabsTrigger value="all">All</TabsTrigger>
                            <TabsTrigger value="mine">Assigned to me</TabsTrigger>
                            <TabsTrigger value="recent">Recently added</TabsTrigger>
                        </TabsList>
                        <div className="relative min-w-[200px] flex-1">
                            <Search
                                className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                                aria-hidden="true"
                            />
                            <Input
                                id="candidate-search"
                                aria-label="Search candidates"
                                className="pl-9"
                                placeholder="Search name or email…"
                                value={searchInput}
                                onChange={(event) => onSearchChange(event.target.value)}
                            />
                        </div>
                    </div>
                </Tabs>
                <div className="flex flex-wrap items-end gap-3">
                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor="candidate-owner">Owner</Label>
                        <select
                            id="candidate-owner"
                            className={selectClass}
                            value={filters.owner}
                            onChange={(event) =>
                                applyFilters({ owner: event.target.value })
                            }
                        >
                            <option value="all">All owners</option>
                            <option value="mine">Assigned to me</option>
                            {(liveContext.owners ?? []).map((owner) => (
                                <option key={owner.id} value={owner.id}>
                                    {owner.name}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor="candidate-tag">Tag</Label>
                        <select
                            id="candidate-tag"
                            className={selectClass}
                            value={filters.tag}
                            onChange={(event) =>
                                applyFilters({ tag: event.target.value })
                            }
                        >
                            <option value="all">All tags</option>
                            {(liveContext.tags ?? []).map((tag) => (
                                <option key={tag} value={tag}>
                                    {tag}
                                </option>
                            ))}
                        </select>
                    </div>
                    {(filters.query || filters.owner !== 'all' || filters.tag !== 'all') ? (
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                                setSearchInput('');
                                applyFilters({ query: '', owner: 'all', tag: 'all' });
                            }}
                        >
                            <X aria-hidden="true" />
                            Clear filters
                        </Button>
                    ) : null}
                    <div className="ml-auto flex items-center gap-2">
                        <Badge variant="secondary">
                            {total} candidate{total === 1 ? '' : 's'}
                        </Badge>
                        {typeof counts?.withApplications === 'number' ? (
                            <Badge variant="outline">
                                {counts.withApplications} with applications
                            </Badge>
                        ) : null}
                        {typeof counts?.restricted === 'number' && counts.restricted > 0 ? (
                            <Badge variant="outline">
                                {counts.restricted} restricted
                            </Badge>
                        ) : null}
                    </div>
                </div>
            </div>

            {error ? (
                <div
                    role="alert"
                    className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3"
                >
                    <p className="text-sm text-destructive">{error}</p>
                    <Button variant="outline" size="sm" onClick={retry}>
                        Retry
                    </Button>
                </div>
            ) : null}

            {selected.size > 0 && canWrite ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-accent px-4 py-2">
                    <span className="text-sm font-medium text-accent-foreground">
                        {selected.size} selected
                    </span>
                    <div className="flex items-center gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={loading || error !== '' || selectedCards.length === 0}
                            onClick={() => {
                                setTagError('');
                                setTagDialogOpen(true);
                            }}
                        >
                            <Tag aria-hidden="true" />
                            Add tag
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setSelected(new Set())}
                        >
                            Clear selection
                        </Button>
                    </div>
                </div>
            ) : null}

            {pageOutOfRange ? (
                <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-card px-4 py-10 text-center">
                    <p className="text-sm font-medium text-foreground">
                        This page has no candidates
                    </p>
                    <p className="text-sm text-muted-foreground">
                        The list changed or the page number is out of range.
                    </p>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => goToPage(1)}
                    >
                        Back to page 1
                    </Button>
                </div>
            ) : result.candidates.length === 0 && !loading ? (
                <EmptyState
                    icon={Search}
                    title="No candidates found"
                    description={
                        filters.query || filters.owner !== 'all' || filters.tag !== 'all'
                            ? 'Try clearing the search or filters.'
                            : 'Candidates appear here after submissions or manual entry.'
                    }
                />
            ) : (
                <div className="overflow-hidden rounded-lg border border-border bg-card">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                {canWrite ? (
                                    <TableHead className="w-10">
                                        <Checkbox
                                            aria-label="Select all candidates on this page"
                                            checked={selectAllState}
                                            disabled={loading || error !== ''}
                                            onCheckedChange={(checked) =>
                                                toggleSelectAll(checked === true)
                                            }
                                        />
                                    </TableHead>
                                ) : null}
                                <TableHead className="w-10">
                                    <span className="sr-only">Avatar</span>
                                </TableHead>
                                <TableHead>Name</TableHead>
                                <TableHead className="hidden md:table-cell">Tags</TableHead>
                                <TableHead className="hidden sm:table-cell">Applications</TableHead>
                                <TableHead className="hidden lg:table-cell">Owner</TableHead>
                                <TableHead className="hidden sm:table-cell">CV</TableHead>
                                <TableHead className="hidden sm:table-cell">Added</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {result.candidates.map((row: CandidateCard) => {
                                const restricted = row.lifecycle === 'restricted';
                                const eligible = row.lifecycle === 'active';
                                return (
                                    <TableRow key={row.candidateId}>
                                        {canWrite ? (
                                            <TableCell>
                                                <Checkbox
                                                    aria-label={
                                                        restricted
                                                            ? `Record ${row.candidateId} is restricted`
                                                            : `Select ${row.fullName ?? 'candidate'}`
                                                    }
                                                    disabled={!eligible || loading || error !== ''}
                                                    checked={selected.has(row.candidateId)}
                                                    onCheckedChange={(checked) =>
                                                        toggleSelect(
                                                            row.candidateId,
                                                            checked === true,
                                                        )
                                                    }
                                                />
                                            </TableCell>
                                        ) : null}
                                        <TableCell>
                                            {restricted ? (
                                                <span
                                                    className="flex h-9 w-9 items-center justify-center rounded-full bg-restriction text-restriction-foreground"
                                                    aria-hidden="true"
                                                >
                                                    <ShieldAlert className="h-4 w-4" />
                                                </span>
                                            ) : (
                                                <InitialsAvatar name={row.fullName ?? '?'} />
                                            )}
                                        </TableCell>
                                        <TableCell>
                                            {restricted ? (
                                                <div className="flex items-center gap-2">
                                                    <StatusBadge tone="restriction">
                                                        Restricted
                                                    </StatusBadge>
                                                    <span className="font-mono text-xs text-muted-foreground">
                                                        Record {row.candidateId.slice(0, 8)}
                                                    </span>
                                                </div>
                                            ) : (
                                                <div className="flex min-w-0 flex-col">
                                                    <RecordPreviewLink
                                                        kind="candidate"
                                                        id={row.candidateId}
                                                        className="rounded-sm font-medium text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                                                    >
                                                        {row.fullName ?? 'Unnamed'}
                                                    </RecordPreviewLink>
                                                    <span className="truncate text-xs text-muted-foreground">
                                                        {row.email
                                                            ?? [row.headline, row.location]
                                                                .filter(Boolean)
                                                                .join(' · ')
                                                            ?? ''}
                                                    </span>
                                                </div>
                                            )}
                                        </TableCell>
                                        <TableCell className="hidden md:table-cell">
                                            <div className="flex max-w-[220px] flex-wrap gap-1">
                                                {(row.tags ?? [])
                                                    .slice(0, 3)
                                                    .map((tag) => (
                                                        <TagPill key={tag}>{tag}</TagPill>
                                                    ))}
                                                {(row.tags?.length ?? 0) > 3 ? (
                                                    <TagPill>
                                                        +{row.tags!.length - 3}
                                                    </TagPill>
                                                ) : null}
                                            </div>
                                        </TableCell>
                                        <TableCell className="hidden text-muted-foreground sm:table-cell">
                                            {restricted
                                                ? '—'
                                                : (row.applicationCount ?? '—')}
                                        </TableCell>
                                        <TableCell className="hidden text-muted-foreground lg:table-cell">
                                            {row.ownerName ?? 'Unassigned'}
                                        </TableCell>
                                        <TableCell className="hidden sm:table-cell">
                                            {row.hasCv ? (
                                                <FileText
                                                    className="h-4 w-4 text-muted-foreground"
                                                    aria-label="CV on file"
                                                />
                                            ) : (
                                                <span className="text-muted-foreground">—</span>
                                            )}
                                        </TableCell>
                                        <TableCell className="hidden text-muted-foreground sm:table-cell">
                                            {formatDate(row.createdAt)}
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                </div>
            )}

            {loading ? (
                <p role="status" className="text-xs text-muted-foreground">
                    Loading candidates…
                </p>
            ) : null}

            {pageCount > 1 ? (
                <div className="flex items-center justify-center gap-3">
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={page <= 1 || loading}
                        onClick={() => goToPage(page - 1)}
                    >
                        Previous
                    </Button>
                    <span className="text-sm text-muted-foreground">
                        Page {result.page ?? page} of {pageCount}
                    </span>
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={(result.page ?? page) >= pageCount || loading}
                        onClick={() => goToPage(page + 1)}
                    >
                        Next
                    </Button>
                </div>
            ) : null}

            <Dialog
                open={tagDialogOpen}
                onOpenChange={(open) => {
                    if (tagPending) return;
                    setTagDialogOpen(open);
                    if (!open) setTagError('');
                }}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Add tag</DialogTitle>
                        <DialogDescription>
                            Add a tag to {selectedCards.length} selected candidate
                            {selectedCards.length === 1 ? '' : 's'}.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor="bulk-tag-input">Tag</Label>
                        <Input
                            id="bulk-tag-input"
                            value={tagDraft}
                            maxLength={80}
                            onChange={(event) => setTagDraft(event.target.value)}
                        />
                    </div>
                    {tagError ? (
                        <p role="alert" className="text-sm text-destructive">
                            {tagError}
                        </p>
                    ) : null}
                    <DialogFooter>
                        <Button
                            variant="ghost"
                            disabled={tagPending}
                            onClick={() => setTagDialogOpen(false)}
                        >
                            Cancel
                        </Button>
                        <Button
                            disabled={tagPending || tagDraft.trim() === ''}
                            onClick={() => void applyBulkTag()}
                        >
                            {tagPending ? 'Applying…' : 'Apply tag'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
