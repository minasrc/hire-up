'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { FileText, Search, X } from 'lucide-react';

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
import { CandidateUploadDialog } from './candidate-upload-dialog';

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

const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric',
    });

export function CandidatesBrowser({
    candidates,
    capped = false,
    canReviewDuplicates = false,
    profileOptions = null,
    profileUnavailable = false,
    semanticSearchEnabled = false,
}: {
    candidates: CandidateRow[];
    capped?: boolean;
    canReviewDuplicates?: boolean;
    profileOptions?: CandidateProfileOptions | null;
    profileUnavailable?: boolean;
    semanticSearchEnabled?: boolean;
}) {
    const router = useRouter();
    const searchParams = useSearchParams();
    const query = searchParams.get('q') ?? '';

    const updateQuery = (value: string) => {
        const params = new URLSearchParams();
        if (value.trim()) params.set('q', value);
        const queryString = params.toString();
        window.history.replaceState(
            null, '',
            `/staff/candidates${queryString ? `?${queryString}` : ''}`);
    };

    const visible = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (!needle) return candidates;
        return candidates.filter((row) =>
            `${row.fullName ?? ''} ${row.email ?? ''}`.toLowerCase().includes(needle));
    }, [candidates, query]);

    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-1.5">
                <p className="text-[11px] font-semibold tracking-[0.08em] text-accent-foreground uppercase">
                    Workspace
                </p>
                <h1 className="text-[26px] leading-8 font-medium text-foreground">Candidates</h1>
            </div>

            <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4">
                <div className="flex flex-1 flex-col gap-1.5">
                    <Label htmlFor="candidate-search">Name/email lookup</Label>
                    <div className="relative">
                        <Search
                            className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                            aria-hidden="true"
                        />
                        <Input
                            id="candidate-search"
                            className="pl-9"
                            placeholder="Search name or email…"
                            value={query}
                            onChange={(event) => updateQuery(event.target.value)}
                        />
                    </div>
                </div>
                {query ? (
                    <Button variant="ghost" size="sm" onClick={() => updateQuery('')}>
                        <X aria-hidden="true" />
                        Clear
                    </Button>
                ) : null}
                {semanticSearchEnabled && profileOptions?.canWrite === true ? <><Button asChild variant="outline"><Link href="/staff/telegram-intake">Telegram intake</Link></Button><Button asChild variant="outline"><Link href="/staff/candidates/search">Search by meaning</Link></Button></> : null}
                {canReviewDuplicates ? (
                    <Button asChild variant="outline">
                        <Link href="/staff/candidates/duplicates">Review matches</Link>
                    </Button>
                ) : null}
                {profileOptions?.canWrite === true ? (
                    <CandidateUploadDialog
                        options={profileOptions}
                        onCreated={(candidateId) =>
                            router.push(`/staff/candidates/${candidateId}`)}
                    />
                ) : null}
            </div>

            {profileUnavailable ? (
                <p role="status" className="text-sm text-muted-foreground">
                    Profile editing is temporarily unavailable.
                </p>
            ) : null}

            <span role="status" className="text-xs text-muted-foreground">
                {visible.length} candidate{visible.length === 1 ? '' : 's'}
                {capped
                    ? ' · Showing the latest 500 candidates; filters apply to loaded records'
                    : ''}
            </span>

            {visible.length === 0 ? (
                <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-card px-6 py-12 text-center">
                    <p className="text-sm font-medium text-foreground">No candidates found</p>
                    <p className="max-w-sm text-sm text-muted-foreground">
                        {candidates.length === 0
                            ? 'Candidates appear here after submissions are imported from the applications page.'
                            : 'Try clearing the search.'}
                    </p>
                </div>
            ) : (
                <div className="overflow-hidden rounded-lg border border-border bg-card">
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
                        {visible.map((row) => (
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
        </div>
    );
}
