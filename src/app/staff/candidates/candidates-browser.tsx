'use client';

import { staffWorkspaceUrl } from '@/lib/staff-workspace-fetch';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FileText, LoaderCircle, Search, X } from 'lucide-react';

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
import { candidateDirectoryQuery } from '@/lib/staff-directory-query';
import { useDirectoryNavigation } from '../use-directory-navigation';
import { CandidateUploadDialog } from './candidate-upload-dialog';
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
}: {
    candidates: CandidateRow[];
    total: number;
    page: number;
    pageSize: number;
    canReviewDuplicates?: boolean;
    profileOptions?: CandidateProfileOptions | null;
    profileUnavailable?: boolean;
    semanticSearchEnabled?: boolean;
}) {
    const router = useRouter();
    const { filters, update: navigate, pending } = useDirectoryNavigation(
        '/staff/candidates', parseFilters, serializeFilters);
    const query = filters.query;
    const updateQuery = (value: string, debounce = false) =>
        navigate({ query: value, page: 1 }, debounce);
    const rankedMode = semanticSearchEnabled && profileOptions?.canWrite === true && query.trim().length >= 3 && total === 0;
    const ranked = useCandidateSearch(query.trim(), rankedMode && !pending);
    const rows = rankedMode ? ranked.state?.rows ?? [] : candidates;
    const searching = pending || (rankedMode && (!ranked.state || ranked.state.status === 'searching'));
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-1.5">
                <h1 className="text-[26px] leading-8 font-medium text-foreground">Candidates</h1>
            </div>

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
                {semanticSearchEnabled && profileOptions?.canWrite === true ? <><Button asChild variant="outline"><Link href="/staff/telegram-intake">Review proposals</Link></Button></> : null}
                {canReviewDuplicates ? (
                    <Button asChild variant="outline">
                        <Link href="/staff/candidates/duplicates">Review matches</Link>
                    </Button>
                ) : null}
                {profileOptions?.canWrite === true ? (
                    <CandidateUploadDialog
                        options={profileOptions}
                        onCreated={(candidateId) =>
                            router.push(staffWorkspaceUrl(`/staff/candidates/${candidateId}`))}
                    />
                ) : null}
            </div>

            {profileUnavailable ? (
                <p role="status" className="text-sm text-muted-foreground">
                    Profile editing is temporarily unavailable.
                </p>
            ) : null}

            <span role="status" className="text-xs text-muted-foreground">
                {searching ? <span className="flex items-center gap-2"><LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 motion-safe:animate-spin" />Searching…</span> : rankedMode ? ranked.state?.status === 'unavailable' ? 'Search temporarily unavailable' : ranked.state?.status === 'failed' ? ranked.state.error : `${rows.length} match${rows.length === 1 ? '' : 'es'} · Best matches first` : `${total} candidate${total === 1 ? '' : 's'}`}
                {rankedMode && ['unavailable', 'failed'].includes(ranked.state?.status ?? '') ? <Button variant="ghost" size="sm" onClick={ranked.retry}>Retry</Button> : null}
            </span>

            {!rows.length && !searching ? (
                <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-card px-6 py-12 text-center">
                    <p className="text-sm font-medium text-foreground">{rankedMode && ranked.state?.status !== 'completed' ? 'Try searching by name or email' : 'No candidates found'}</p>
                    <p className="max-w-sm text-sm text-muted-foreground">
                        {!query
                            ? 'Add a candidate or import from Telegram.'
                            : 'Try clearing the search.'}
                    </p>
                </div>
            ) : (
                <div aria-busy={searching} className="overflow-hidden rounded-lg border border-border bg-card">
                    <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Name</TableHead>
                            <TableHead>Email</TableHead>
                            <TableHead>Owner</TableHead>
                            <TableHead>Applications</TableHead>
                            <TableHead>CV</TableHead>
                            <TableHead>Added</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.map((row) => (
                            <TableRow key={row.candidateId}>
                                <TableCell>
                                    <a
                                        href={`/staff/candidates/${row.candidateId}`}
                                        className="font-medium text-foreground underline-offset-4 hover:underline"
                                    >
                                        {row.fullName ?? 'Unnamed'}
                                    </a>
                                    {row.headline ? (
                                        <div className="text-xs text-muted-foreground">
                                            {row.headline}
                                        </div>
                                    ) : null}
                                </TableCell>
                                <TableCell className="text-muted-foreground">
                                    {row.email ?? '—'}
                                </TableCell>
                                <TableCell className="text-muted-foreground">
                                    {row.ownerName ?? '—'}
                                </TableCell>
                                <TableCell className="text-muted-foreground">
                                    {row.applicationCount}
                                </TableCell>
                                <TableCell>
                                    {row.hasCv ? (
                                        <FileText className="h-4 w-4 text-muted-foreground" aria-label="CV on file" />
                                    ) : (
                                        <span className="text-muted-foreground">—</span>
                                    )}
                                </TableCell>
                                <TableCell className="text-muted-foreground">
                                    {formatDate(row.createdAt)}
                                </TableCell>
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
