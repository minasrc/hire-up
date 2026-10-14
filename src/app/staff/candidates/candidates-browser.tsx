'use client';

import { staffWorkspaceUrl } from '@/lib/staff-workspace-fetch';

import Link from 'next/link';
import { useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Clock3, ChevronRight, LoaderCircle, Search, X } from 'lucide-react';

import { InitialsAvatar, PageHeader } from '@/components/staff-preview/shared';
import { Badge } from '@/components/staff-ui/badge';
import { Button } from '@/components/staff-ui/button';
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
    type CandidateProfileOptions,
} from './candidate-profile-dialog';
import { candidateSearchIntent } from '@/lib/candidate-search-query';
import { candidateDirectoryQuery } from '@/lib/staff-directory-query';
import { useDirectoryNavigation } from '../use-directory-navigation';
import { CandidateUploadDialog } from './candidate-upload-dialog';
import { searchIndexingStatus } from './search/search-model';
import { useSearchIndexing } from './use-search-indexing';
import { useCandidateSearch } from './use-candidate-search';
import { StaffDate } from '../staff-date';

export interface CandidateRow {
    candidateId: string;
    fullName: string | null;
    email: string | null;
    ownerName: string | null;
    applicationCount: number;
    hasCv: boolean;
    createdAt: string;
    headline?: string | null;
    location?: string | null;
}

const subscribeToHydration = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

const formatDate = (iso: string) => <StaffDate value={iso} />;

const parseFilters = (params: { get(name: string): string | null }) =>
    candidateDirectoryQuery({ q: params.get('q'), page: params.get('page') });
const serializeFilters = (filters: { query: string; page: number }) => {
    const params = new URLSearchParams();
    if (filters.query.trim()) params.set('q', filters.query);
    if (filters.page > 1) params.set('page', String(filters.page));
    return params.toString();
};

export function CandidatesBrowser({
    candidates,
    total,
    page,
    pageSize,
    canReviewDuplicates = false,
    profileOptions = null,
    profileUnavailable = false,
    semanticSearchEnabled = false,
    pendingProposalCount = 0,
}: {
    candidates: CandidateRow[];
    total: number;
    page: number;
    pageSize: number;
    canReviewDuplicates?: boolean;
    profileOptions?: CandidateProfileOptions | null;
    profileUnavailable?: boolean;
    semanticSearchEnabled?: boolean;
    pendingProposalCount?: number;
}) {
    const router = useRouter();
    const clientReady = useSyncExternalStore(subscribeToHydration, clientSnapshot, serverSnapshot);
    const { filters, update: navigate, pending } = useDirectoryNavigation(
        '/staff/candidates', parseFilters, serializeFilters);
    const query = filters.query;
    const updateQuery = (value: string, debounce = false) =>
        navigate({ query: value, page: 1 }, debounce);
    const rankedMode = semanticSearchEnabled && profileOptions?.canWrite === true && query.trim().length >= 3 && total === 0 && !candidateSearchIntent(query).experience;
    const backgroundIndexing = useSearchIndexing(semanticSearchEnabled && profileOptions?.canWrite === true, total);
    const ranked = useCandidateSearch(query.trim(), rankedMode && !pending, backgroundIndexing.revision);
    const indexing = searchIndexingStatus(backgroundIndexing.coverage ?? (rankedMode ? ranked.state?.coverage : null));
    const rows = rankedMode ? ranked.state?.rows ?? [] : candidates;
    const searching = pending || (rankedMode && (!ranked.state || ranked.state.status === 'searching'));
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    return (
        <div className="flex flex-col gap-6">
            <PageHeader eyebrow="Workspace" title="Candidates" actions={profileOptions?.canWrite === true ? (
                    <CandidateUploadDialog
                        options={profileOptions}
                        onCreated={(candidateId) =>
                            router.push(staffWorkspaceUrl(`/staff/candidates/${candidateId}`))}
                    />
                ) : null} />

            <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4">
                <div className="flex flex-1 flex-col gap-1.5">
                    <Label htmlFor="candidate-search" className="sr-only">Search candidates</Label>
                    <div className="relative">
                        <Search
                            className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                            aria-hidden="true"
                        />
                        <Input
                            id="candidate-search"
                            disabled={!clientReady}
                            className="pl-9"
                            placeholder="Search by name, email, or describe a candidate…"
                            value={query}
                            maxLength={200}
                            onChange={(event) => updateQuery(event.target.value, true)}
                        />
                    </div>
                </div>
                {query ? (
                    <Button variant="ghost" size="sm" onClick={() => updateQuery('')}>
                        <X aria-hidden="true" />
                        Clear
                    </Button>
                ) : null}
                {pendingProposalCount > 0 && profileOptions?.canWrite === true ? <Button asChild variant="outline"><Link href="/staff/telegram-intake">Review proposals ({pendingProposalCount})</Link></Button> : null}
                {canReviewDuplicates ? (
                    <Button asChild variant="outline">
                        <Link href="/staff/candidates/duplicates">Review matches</Link>
                    </Button>
                ) : null}

            </div>

            {profileUnavailable ? (
                <p role="status" className="text-sm text-muted-foreground">
                    Profile editing is temporarily unavailable.
                </p>
            ) : null}

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span role="status">
                    {searching ? <span className="flex items-center gap-2"><LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 motion-safe:animate-spin" />Searching…</span> : rankedMode ? ranked.state?.status === 'unavailable' ? 'Search temporarily unavailable' : ranked.state?.status === 'failed' ? ranked.state.error : `${rows.length} match${rows.length === 1 ? '' : 'es'} · Best matches first` : `${total} candidate${total === 1 ? '' : 's'}`}
                </span>
                {indexing ? (
                    <span role="status" aria-label="Search indexing status" className="flex flex-wrap items-center gap-1.5">
                        {backgroundIndexing.animated ? <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 motion-safe:animate-spin" /> : indexing.failed ? <AlertCircle aria-hidden="true" className="h-3.5 w-3.5" /> : <Clock3 aria-hidden="true" className="h-3.5 w-3.5" />}
                        <span>{indexing.pending ? `${indexing.pending} profile${indexing.pending === 1 ? '' : 's'} processing for search` : indexing.failed ? 'Some profiles need attention' : indexing.label}</span>
                        {indexing.pending && indexing.failed ? <span>· Some profiles need attention</span> : null}
                        {rankedMode && indexing.incomplete ? <span>· Results may be incomplete</span> : null}
                        <Button variant="ghost" size="sm" onClick={() => { backgroundIndexing.refresh(); if (rankedMode) ranked.retry(); }}>Refresh</Button>
                    </span>
                ) : null}
                {rankedMode && ranked.state?.status === 'completed' && ranked.state.error ? <span role="status">{ranked.state.error}</span> : null}
                {rankedMode && (['unavailable', 'failed'].includes(ranked.state?.status ?? '') || ranked.state?.error) ? <Button variant="ghost" size="sm" onClick={ranked.retry}>Retry search</Button> : null}
            </div>

            {!rows.length && !searching ? (
                <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-card px-6 py-12 text-center">
                    <p className="text-sm font-medium text-foreground">{rankedMode && ranked.state?.status !== 'completed' ? 'Try searching by name or email' : rankedMode && indexing?.incomplete ? 'No matches in searchable profiles' : 'No candidates found'}</p>
                    <p className="max-w-sm text-sm text-muted-foreground">
                        {!query
                            ? 'Add a candidate or import from Telegram.'
                            : rankedMode && indexing?.incomplete ? 'Search by name or email.' : 'Try clearing the search.'}
                    </p>
                </div>
            ) : (
                <div aria-busy={searching} className="overflow-hidden rounded-lg border border-border bg-card">
                    <Table containerClassName="max-h-[min(65vh,640px)] overflow-y-auto overscroll-contain" aria-label="Candidates">
                    <TableHeader className="sticky top-0 z-10 bg-card">
                        <TableRow>
                            <TableHead>Name</TableHead>
                            <TableHead>Role</TableHead>
                            <TableHead>Owner</TableHead>
                            <TableHead>Applications</TableHead>
                            <TableHead>CV</TableHead>
                            <TableHead className="hidden xl:table-cell">Added</TableHead>
                            <TableHead><span className="sr-only">Open candidate</span></TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.map((row) => (
                            <TableRow key={row.candidateId}>
                                <TableCell>
                                    <div className="flex items-center gap-3">
                                        <InitialsAvatar name={row.fullName ?? 'Unnamed candidate'} />
                                        <div className="min-w-0">
                                            <a data-preview-trigger href={staffWorkspaceUrl(`/staff/candidates/${row.candidateId}`)} className="font-medium text-foreground underline-offset-4 hover:underline">{row.fullName ?? 'Unnamed'}</a>
                                            {row.email && <p className="mt-0.5 text-xs text-muted-foreground">{row.email}</p>}
                                        </div>
                                    </div>
                                </TableCell>
                                <TableCell>
                                    <p>{row.headline ?? '—'}</p>
                                    {row.location && <p className="mt-0.5 text-xs text-muted-foreground">{row.location}</p>}
                                </TableCell>
                                <TableCell className="text-muted-foreground">
                                    {row.ownerName ? <span className="inline-flex items-center gap-2"><InitialsAvatar name={row.ownerName} size="sm" />{row.ownerName}</span> : 'Unassigned'}
                                </TableCell>
                                <TableCell className="text-muted-foreground">
                                    {row.applicationCount}
                                </TableCell>
                                <TableCell>
                                    <Badge variant={row.hasCv ? 'success' : 'secondary'}>{row.hasCv ? 'CV on file' : 'No documents'}</Badge>
                                </TableCell>
                                <TableCell className="hidden text-muted-foreground xl:table-cell">{formatDate(row.createdAt)}</TableCell>
                                <TableCell><a href={staffWorkspaceUrl(`/staff/candidates/${row.candidateId}`)} data-full-page title="Open full profile" aria-label={`Open full profile for ${row.fullName ?? 'candidate'}`} className="inline-flex rounded-md p-1 hover:bg-secondary"><ChevronRight className="size-4" aria-hidden="true" /></a></TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                    </Table>
                </div>
            )}
            <nav aria-label="Directory pages" className="flex items-center justify-between gap-3">
                <Button variant="outline" size="sm" disabled={searching || (rankedMode ? ranked.page <= 1 : page <= 1)}
                    onClick={() => rankedMode ? ranked.previous() : navigate({ ...filters, page: page - 1 })}>Previous</Button>
                <span className="text-xs text-muted-foreground">
                    {rankedMode ? `Page ${ranked.page}` : `Page ${page} of ${totalPages}`}
                    {!rankedMode && total > 0 ? ` · ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}` : ''}
                </span>
                <Button variant="outline" size="sm" disabled={searching || (rankedMode ? !ranked.state?.next : page >= totalPages)}
                    onClick={() => rankedMode ? ranked.next() : navigate({ ...filters, page: page + 1 })}>Next</Button>
            </nav>
        </div>
    );
}
