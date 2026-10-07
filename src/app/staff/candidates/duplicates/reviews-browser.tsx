'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ArrowLeft, Check, ChevronDown, ChevronUp, RotateCcw, X } from 'lucide-react';
import { Button } from '@/components/staff-ui/button';
import {
    Dialog, DialogContent, DialogDescription, DialogFooter,
    DialogHeader, DialogTitle,
} from '@/components/staff-ui/dialog';
import { ComparisonPanel, type Comparison } from './comparison-panel';

type ReviewStatus = 'pending' | 'same_person' | 'different_people';
type Decision = 'same_person' | 'different_people' | 'reopen';

interface Review {
    id: string;
    candidateAId: string;
    candidateBId: string;
    candidateAName: string | null;
    candidateBName: string | null;
    candidateAEmail: string | null;
    candidateBEmail: string | null;
    status: ReviewStatus;
    evidence: { emails?: string[]; cvHashes?: string[] };
    newEvidence: boolean;
    version: number | string;
    reviewedAt: string | null;
}

const views: { label: string; status: ReviewStatus }[] = [
    { label: 'Pending', status: 'pending' },
    { label: 'Same person', status: 'same_person' },
    { label: 'Different people', status: 'different_people' },
];

function mergeEmailOptions(comparison: Comparison): string[] {
    const emails = new Map<string, string>();
    for (const identifier of [...comparison.candidateA.identifiers, ...comparison.candidateB.identifiers]) {
        if (identifier.kind !== 'email') continue;
        const email = identifier.value.trim();
        if (email && !emails.has(email.toLowerCase())) emails.set(email.toLowerCase(), email);
    }
    return Array.from(emails.values());
}

export function DuplicateReviewsBrowser({
    reviews, status, demo = false, demoComparisons = {},
}: {
    reviews: Review[];
    status: ReviewStatus;
    demo?: boolean;
    demoComparisons?: Record<string, Comparison>;
}) {
    const router = useRouter();
    const [busyId, setBusyId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loadResult, setLoadResult] = useState<{
        id: string;
        key: number;
        comparison?: Comparison;
        error?: boolean;
    } | null>(null);
    const [reloadKey, setReloadKey] = useState(0);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [resolvedIds, setResolvedIds] = useState<string[]>([]);
    const [demoReviews, setDemoReviews] = useState(reviews);
    const [demoStatus, setDemoStatus] = useState(status);
    const [mergeChoice, setMergeChoice] = useState<{
        review: Review; comparison: Comparison; targetId: string; email: string;
    } | null>(null);
    const [mergeError, setMergeError] = useState<string | null>(null);
    const [mergedId, setMergedId] = useState<string | null>(null);
    const activeStatus = demo ? demoStatus : status;
    const visibleReviews = demo
        ? demoReviews.filter((review) => review.status === demoStatus)
        : reviews.filter((review) => !resolvedIds.includes(review.id));
    const selected = visibleReviews.find((review) => review.id === selectedId) ?? null;
    const selectedReviewId = selected?.id;

    useEffect(() => {
        if (!selectedReviewId || demo) return;
        const controller = new AbortController();
        fetch(`/api/staff/candidates/duplicates?reviewId=${encodeURIComponent(selectedReviewId)}`, {
            signal: controller.signal,
            cache: 'no-store',
        }).then(async (response) => {
            if (!response.ok) throw new Error('Unable to load comparison');
            return response.json();
        }).then((payload) => {
            setLoadResult({ id: selectedReviewId, key: reloadKey, comparison: payload.result });
        })
            .catch((reason) => {
                if (reason.name !== 'AbortError') {
                    setLoadResult({ id: selectedReviewId, key: reloadKey, error: true });
                }
            });
        return () => controller.abort();
    }, [selectedReviewId, demo, reloadKey]);

    const currentLoad = loadResult?.id === selected?.id && loadResult?.key === reloadKey
        ? loadResult : null;
    const loading = Boolean(selected && !demo && !currentLoad);
    const detailError = currentLoad?.error
        ? 'Unable to load the comparison. Select it again to retry.' : null;
    const detail = demo && selected ? demoComparisons[selected.id] ?? null
        : currentLoad?.comparison ?? null;

    const toggleReview = (reviewId: string) => {
        setError(null);
        if (selectedId === reviewId) {
            setSelectedId(null);
        } else {
            setSelectedId(reviewId);
            setReloadKey((value) => value + 1);
        }
    };

    const decide = async (review: Review, decision: Decision) => {
        if (busyId || !detail) return;
        if (demo) {
            setDemoReviews((current) => current.map((entry) => entry.id === review.id ? {
                ...entry,
                status: decision === 'reopen' ? 'pending' : decision,
                newEvidence: false,
                version: Number(entry.version) + 1,
            } : entry));
            setSelectedId(null);
            return;
        }
        setBusyId(review.id);
        setError(null);
        try {
            const response = await fetch('/api/staff/candidates/duplicates', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    reviewId: review.id,
                    expectedVersion: review.version,
                    decision,
                }),
            });
            if (!response.ok) {
                setError(response.status === 409
                    ? 'This suggestion changed. Refresh and review it again.'
                    : 'Your decision could not be saved. Please try again.');
                return;
            }
            setResolvedIds((current) => [...current, review.id]);
            setSelectedId(null);
        } catch {
            setError('The connection was interrupted. Please try again.');
        } finally {
            setBusyId(null);
        }
    };

    const beginMerge = (review: Review, comparison: Comparison) => {
        const targetId = comparison.candidateA.candidate.candidateId;
        const emails = mergeEmailOptions(comparison);
        const preferredEmail = comparison.candidateA.candidate.email?.trim().toLowerCase();
        const email = emails.find((option) => option.toLowerCase() === preferredEmail) ?? emails[0] ?? '';
        setMergeError(null);
        setMergeChoice({ review, comparison, targetId, email });
    };

    const confirmMerge = async () => {
        if (!mergeChoice || busyId) return;
        const { review, comparison, targetId, email } = mergeChoice;
        const isA = targetId === comparison.candidateA.candidate.candidateId;
        const target = isA ? comparison.candidateA : comparison.candidateB;
        const source = isA ? comparison.candidateB : comparison.candidateA;
        setBusyId(review.id);
        setMergeError(null);
        try {
            if (!demo) {
                const response = await fetch('/api/staff/candidates/duplicates/merge', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        reviewId: review.id,
                        expectedVersion: review.version,
                        targetCandidateId: targetId,
                        expectedTargetVersion: target.candidate.version,
                        expectedSourceVersion: source.candidate.version,
                        primaryEmail: email || null,
                    }),
                });
                if (!response.ok) {
                    setMergeError(response.status === 409
                        ? 'These records changed. Close this window, refresh, and compare them again.'
                        : response.status === 422
                            ? 'These records have privacy or file conditions that need manual review before merging.'
                            : response.status === 403
                                ? 'You do not have permission to merge candidates.'
                                : 'The merge could not be completed. No records were changed. Please try again.');
                    return;
                }
            } else {
                setDemoReviews((current) => current.filter((entry) => entry.id !== review.id));
            }
            setMergedId(targetId);
            setResolvedIds((current) => [...current, review.id]);
            setSelectedId(null);
            setMergeChoice(null);
            if (!demo) router.refresh();
        } catch {
            setMergeError('The connection was interrupted. Check the candidate profile before trying again.');
        } finally {
            setBusyId(null);
        }
    };

    const mergeEmails = mergeChoice ? mergeEmailOptions(mergeChoice.comparison) : [];

    return <section className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
            <div>
                {!demo ? <Link href="/staff/candidates"
                    className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                    <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Candidates
                </Link> : null}
                <h1 className="mt-2 text-[26px] font-medium text-foreground">Duplicate review</h1>
            </div>
            <span className="text-sm text-muted-foreground">
                {visibleReviews.length} {activeStatus === 'pending' ? 'to review' : 'reviewed'}
            </span>
        </header>
        {mergedId ? <p role="status" className="border-l-2 border-attention bg-attention/20 px-4 py-3 text-sm">
            Candidates merged. Their applications and CVs are now in one profile.{' '}
            {!demo ? <Link href={`/staff/candidates/${mergedId}`}
                className="font-medium underline underline-offset-4">Open profile</Link> : null}
        </p> : null}
        <nav aria-label="Review status" className="flex gap-1 border-b border-border">
            {views.map((view) => {
                const className = `border-b-2 px-3 py-2 text-sm font-medium transition-colors
                    ${activeStatus === view.status ? 'border-primary text-foreground'
                        : 'border-transparent text-muted-foreground hover:text-foreground'}`;
                return demo ? <button key={view.status} type="button"
                    onClick={() => { setDemoStatus(view.status); setSelectedId(null); }}
                    aria-current={activeStatus === view.status ? 'page' : undefined}
                    className={className}>{view.label}</button>
                    : <Link key={view.status}
                        href={view.status === 'pending' ? '/staff/candidates/duplicates'
                            : `/staff/candidates/duplicates?status=${view.status}`}
                        aria-current={activeStatus === view.status ? 'page' : undefined}
                        className={className}>{view.label}</Link>;
            })}
        </nav>
        <section aria-label="Potential duplicates" className="min-w-0">
            <h2 className="mb-2 text-sm font-semibold">Potential duplicates</h2>
            {visibleReviews.length === 0 ? <p className="py-12 text-center text-sm text-muted-foreground">
                {activeStatus === 'pending' ? 'No potential duplicates to review.' : 'No reviews in this category.'}
            </p> : <div className="divide-y divide-border border-y border-border">
                {visibleReviews.map((review) => {
                    const expanded = selected?.id === review.id;
                    return <article key={review.id} className="min-w-0">
                        <button type="button" onClick={() => toggleReview(review.id)}
                            aria-expanded={expanded}
                            className={`flex w-full items-center gap-3 border-l-2 px-4 py-4 text-left hover:bg-muted
                                ${expanded ? 'border-ring bg-muted' : 'border-transparent'}`}>
                            <span className="min-w-0 flex-1">
                                <span className="block text-sm font-medium">
                                    {review.candidateAName || 'Unnamed'} / {review.candidateBName || 'Unnamed'}
                                </span>
                                <span className="block text-xs text-muted-foreground">
                                    {(review.evidence.emails?.length ?? 0) > 0 ? 'Shared email' : null}
                                    {(review.evidence.emails?.length ?? 0) > 0
                                        && (review.evidence.cvHashes?.length ?? 0) > 0 ? ' · ' : null}
                                    {(review.evidence.cvHashes?.length ?? 0) > 0 ? 'Identical CV' : null}
                                    {review.newEvidence ? ' · New evidence' : ''}
                                </span>
                            </span>
                            {expanded ? <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                                : <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                        </button>
                        {expanded ? <div id={`review-${review.id}`}
                            className="min-w-0 space-y-6 border-t border-border px-4 py-5 sm:px-6">
                            {loading ? <p role="status" className="py-6 text-sm text-muted-foreground">Loading profiles…</p>
                                : detailError ? <div className="flex flex-wrap items-center gap-3 py-6">
                                    <p role="alert" className="text-sm text-destructive">{detailError}</p>
                                    <Button size="sm" variant="outline"
                                        onClick={() => setReloadKey((value) => value + 1)}>Retry</Button>
                                </div> : detail ? <>
                                    {error ? <p role="alert" className="border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                                        {error}</p> : null}
                                    <ComparisonPanel comparison={detail} demo={demo}
                                        hasEmailMatch={(review.evidence.emails?.length ?? 0) > 0}
                                        hasCvMatch={(review.evidence.cvHashes?.length ?? 0) > 0}
                                        actions={<div className="flex flex-wrap gap-2">
                                            {review.status === 'pending' ? <>
                                                <Button size="sm" variant="outline" disabled={busyId === review.id}
                                                    onClick={() => decide(review, 'different_people')}>
                                                    <X className="h-4 w-4" aria-hidden="true" /> Not duplicate
                                                </Button>
                                            </> : null}
                                            {(demo || detail.canMerge) && review.status !== 'different_people'
                                                ? <Button size="sm" disabled={busyId === review.id}
                                                    className="bg-attention text-attention-foreground hover:bg-attention/80 hover:text-attention-foreground"
                                                    onClick={() => beginMerge(review, detail)}>
                                                    <Check className="h-4 w-4" aria-hidden="true" /> Merge
                                                </Button> : null}
                                            {!demo && !detail.canMerge && review.status === 'pending'
                                                ? <Button size="sm" disabled={busyId === review.id}
                                                    onClick={() => decide(review, 'same_person')}>
                                                    <Check className="h-4 w-4" aria-hidden="true" /> Confirm match
                                                </Button> : null}
                                            {review.status !== 'pending' && review.newEvidence ? <Button size="sm" variant="outline"
                                                disabled={busyId === review.id} onClick={() => decide(review, 'reopen')}>
                                                <RotateCcw className="h-4 w-4" aria-hidden="true" /> Review new evidence
                                            </Button> : null}
                                            {review.status === 'different_people' && !review.newEvidence
                                                ? <span className="text-sm text-muted-foreground">Reviewed: different people</span>
                                                : null}
                                        </div>} />
                                    {review.status === 'same_person' && !detail.canMerge && !demo
                                        ? <p className="text-xs text-muted-foreground">Match confirmed. An administrator can merge the records.</p>
                                        : null}
                                </> : null}
                        </div> : null}
                    </article>;
                })}
            </div>}
        </section>
        <Dialog open={mergeChoice !== null} onOpenChange={(open) => {
            if (!open && !busyId) setMergeChoice(null);
        }}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Merge candidates</DialogTitle>
                    <DialogDescription>
                        Keep one profile with all applications, CVs, notes, and email addresses.
                        The other profile will redirect to it. This cannot be undone here.
                    </DialogDescription>
                </DialogHeader>
                {mergeChoice ? <div className="space-y-4 text-sm">
                    <fieldset className="space-y-2">
                        <legend className="font-medium">Primary profile</legend>
                        {[mergeChoice.comparison.candidateA, mergeChoice.comparison.candidateB]
                            .map((profile) => <label key={profile.candidate.candidateId}
                                className="flex cursor-pointer items-center gap-2 border border-border px-3 py-2">
                                <input type="radio" name="primaryCandidate"
                                    checked={mergeChoice.targetId === profile.candidate.candidateId}
                                    onChange={() => setMergeChoice({ ...mergeChoice,
                                        targetId: profile.candidate.candidateId })} />
                                <span>{profile.candidate.fullName || 'Unnamed'} ·{' '}
                                    {profile.candidate.email || profile.candidate.candidateId}</span>
                            </label>)}
                    </fieldset>
                    {mergeEmails.length > 1 ? <label className="block space-y-1">
                        <span className="font-medium">Primary email</span>
                        <select value={mergeChoice.email}
                            onChange={(event) => setMergeChoice({ ...mergeChoice, email: event.target.value })}
                            className="w-full border border-input bg-card px-3 py-2 text-foreground">
                            {mergeEmails.map((email) => <option key={email} value={email}>{email}</option>)}
                        </select>
                        <span className="block text-xs text-muted-foreground">
                            Other email addresses remain on the combined profile.
                        </span>
                    </label> : null}
                    {mergeError ? <p role="alert" className="text-destructive">{mergeError}</p> : null}
                </div> : null}
                <DialogFooter>
                    <Button variant="outline" disabled={Boolean(busyId)} onClick={() => setMergeChoice(null)}>
                        Cancel
                    </Button>
                    <Button disabled={Boolean(busyId)}
                        className="bg-attention text-attention-foreground hover:bg-attention/80"
                        onClick={confirmMerge}>{busyId ? 'Merging…' : 'Merge candidates'}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    </section>;
}
