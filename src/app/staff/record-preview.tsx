'use client';

import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useSession } from 'next-auth/react';
import { createStaffPreviewCache } from '@/lib/staff-preview-cache';

import { JobDocumentView } from '@/components/staff-preview/job-document';
import type { CandidateDocumentRecord } from '@/components/staff-preview/real-candidate-documents';
import { Badge } from '@/components/staff-ui/badge';
import { Button } from '@/components/staff-ui/button';
import {
    Sheet, SheetContent, SheetDescription, SheetTitle,
} from '@/components/staff-ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/staff-ui/tabs';

// Document preview controls are only needed when a candidate preview opens.
const RealCandidateDocuments = dynamic(
    () => import('@/components/staff-preview/real-candidate-documents').then(
        (module) => module.RealCandidateDocuments,
    ),
    {
        loading: () => (
            <p role="status" className="py-4 text-sm text-muted-foreground">
                Loading documents…
            </p>
        ),
    },
);

type Selection = { kind: 'candidate' | 'job'; id: string };

interface CandidateRecord {
    candidate: {
        fullName: string | null;
        email?: string | null;
        headline?: string | null;
        location?: string | null;
        professionalSummary: string | null;
        professionalUrl?: string | null;
        ownerName: string | null;
    };
    identifiers: { kind: string; value: string }[];
    applications: {
        applicationId: string;
        jobTitle: string;
        clientName: string;
        stageLabel: string;
        receivedAt: string;
        submittedAchievement: string | null;
    }[];
    documents: CandidateDocumentRecord[];
    notes: { noteId: string; body: string; authorName: string | null; createdAt: string }[];
    capabilities: {
        readApplications: boolean;
        readNotes: boolean;
        downloadDocuments: boolean;
    };
}

interface JobRecord {
    job: { title: string; publicationState: string; applicationState: string };
    client: { name?: string } | null;
    draft: {
        title: string;
        revisionNumber: number;
        employmentType?: string | null;
        workplaceMode?: string | null;
        locations?: string[] | null;
        descriptionDocument?: unknown;
    } | null;
    published: {
        title: string;
        revisionNumber: number;
        employmentType?: string | null;
        workplaceMode?: string | null;
        locations?: string[] | null;
        descriptionDocument?: unknown;
    } | null;
}

const date = (value: string) => new Date(value).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
});
const jobFieldLabels: Record<string, string> = {
    full_time: 'Full-time', part_time: 'Part-time', contract: 'Contract',
    internship: 'Internship', onsite: 'On-site', hybrid: 'Hybrid', remote: 'Remote',
};
const displayLabel = (value: string) => jobFieldLabels[value]
    ?? value.charAt(0).toUpperCase() + value.slice(1);

function CandidatePreview({ record }: { record: CandidateRecord }) {
    const { candidate, applications, documents, notes, capabilities } = record;
    const hasViewableDocument = capabilities.downloadDocuments && documents.some((document) =>
        document.lifecycle === 'active' && document.scanState !== 'infected'
        && /\.(pdf|docx)$/i.test(document.filename));
    const email = candidate.email ?? record.identifiers.find((item) => item.kind === 'email')?.value;
    const professionalUrl = candidate.professionalUrl
        ?? record.identifiers.find((item) => item.kind === 'professional_url')?.value;
    const otherEmails = record.identifiers.filter((item) => item.kind === 'email'
        && item.value.toLowerCase() !== email?.toLowerCase());
    return <Tabs defaultValue={hasViewableDocument ? 'documents' : 'overview'} className="space-y-4">
        <TabsList aria-label="Candidate preview sections" className="flex flex-wrap">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="applications">Applications <Badge variant="secondary">{applications.length}</Badge></TabsTrigger>
            <TabsTrigger value="documents">Documents <Badge variant="secondary">{documents.length}</Badge></TabsTrigger>
            <TabsTrigger value="notes">Notes <Badge variant="secondary">{notes.length}</Badge></TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="space-y-4 text-sm">
            {candidate.headline ? <p className="font-medium">{candidate.headline}</p> : null}
            <dl className="grid gap-3 sm:grid-cols-2">
                {email ? <div><dt className="text-xs text-muted-foreground">Email</dt>
                    <dd className="break-all">{email}</dd></div> : null}
                {candidate.location ? <div><dt className="text-xs text-muted-foreground">Location</dt>
                    <dd>{candidate.location}</dd></div> : null}
                {candidate.ownerName ? <div><dt className="text-xs text-muted-foreground">Owner</dt>
                    <dd>{candidate.ownerName}</dd></div> : null}
                {professionalUrl ? <div><dt className="text-xs text-muted-foreground">Profile</dt>
                    <dd><a href={professionalUrl} target="_blank" rel="noreferrer"
                        className="break-all underline underline-offset-4">{professionalUrl}</a></dd></div> : null}
            </dl>
            {otherEmails.length ? <p className="text-muted-foreground">
                Other emails: {otherEmails.map((item) => item.value).join(', ')}
            </p> : null}
            {candidate.professionalSummary ? <section className="space-y-1 border-t border-border pt-4">
                <h3 className="font-medium">Summary</h3>
                <p className="whitespace-pre-wrap leading-6 text-muted-foreground">
                    {candidate.professionalSummary}</p>
            </section> : null}
        </TabsContent>
        <TabsContent value="applications" className="space-y-3">
            {!capabilities.readApplications ? <p className="text-sm text-muted-foreground">
                You do not have permission to view applications.</p>
                : applications.length ? applications.map((application) => <div
                    key={application.applicationId} className="space-y-2 border-b border-border pb-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <strong>{application.jobTitle}</strong>
                        <Badge variant="secondary">{application.stageLabel}</Badge>
                    </div>
                    <p className="text-muted-foreground">{application.clientName} · {date(application.receivedAt)}</p>
                    {application.submittedAchievement ? <p className="whitespace-pre-wrap">
                        {application.submittedAchievement}</p> : null}
                </div>) : <p className="text-sm text-muted-foreground">No applications yet.</p>}
        </TabsContent>
        <TabsContent value="documents">
            <RealCandidateDocuments documents={documents}
                canView={capabilities.downloadDocuments} />
        </TabsContent>
        <TabsContent value="notes" className="space-y-3">
            {!capabilities.readNotes ? <p className="text-sm text-muted-foreground">
                You do not have permission to view notes.</p>
                : notes.length ? notes.map((note) => <div key={note.noteId}
                    className="border-b border-border pb-3 text-sm">
                    <p className="whitespace-pre-wrap">{note.body}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                        {note.authorName ?? 'Staff'} · {date(note.createdAt)}</p>
                </div>) : <p className="text-sm text-muted-foreground">No notes yet.</p>}
        </TabsContent>
    </Tabs>;
}

function JobPreview({ record }: { record: JobRecord }) {
    const { job, draft, published } = record;
    const initial = draft ? 'draft' : 'published';
    return <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{displayLabel(job.publicationState)}</Badge>
            <Badge variant="secondary">Applications {displayLabel(job.applicationState)}</Badge>
        </div>
        {!draft && !published ? <p className="text-sm text-muted-foreground">
            No job description is available yet.</p> : <Tabs defaultValue={initial} className="space-y-4">
        <TabsList aria-label="Job preview sections">
            {draft ? <TabsTrigger value="draft">Draft</TabsTrigger> : null}
            {published ? <TabsTrigger value="published">Published</TabsTrigger> : null}
        </TabsList>
        {(['draft', 'published'] as const).map((kind) => {
            const revision = kind === 'draft' ? draft : published;
            if (!revision) return null;
            return <TabsContent key={kind} value={kind} className="space-y-5">
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    <span>Revision #{revision.revisionNumber}</span>
                </div>
                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                    {[
                        ['Employment', revision.employmentType],
                        ['Workplace', revision.workplaceMode],
                        ['Locations', revision.locations?.join(', ')],
                    ].filter((entry) => entry[1]).map(([label, value]) =>
                        <div key={label as string}><dt className="text-xs text-muted-foreground">{label}</dt>
                            <dd>{label === 'Locations' ? value : displayLabel(value as string)}</dd>
                        </div>)}
                </dl>
                <div className="border-t border-border pt-4">
                    <JobDocumentView document={revision.descriptionDocument} />
                </div>
            </TabsContent>;
        })}
    </Tabs>}
    </div>;
}

const recordPath = /^\/staff\/(candidates|jobs)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

export function RecordPreview({ children }: { children: ReactNode }) {
    const [selection, setSelection] = useState<Selection | null>(null);
    const { data: session, status } = useSession();
    const sessionIdentity = session?.user?.email;
    const sessionCache = useMemo(() => ({
        status, sessionIdentity, records: createStaffPreviewCache(),
    }), [status, sessionIdentity]);
    const cache = sessionCache.records;
    const [loaded, setLoaded] = useState<{
        cache: ReturnType<typeof createStaffPreviewCache>;
        key: string;
        value: CandidateRecord | JobRecord;
    } | null>(null);
    if (loaded && loaded.cache !== cache) setLoaded(null);
    const [revision, setRevision] = useState(0);
    const selectionKey = selection ? `${selection.kind}:${selection.id}` : '';
    const record = status === 'authenticated' && loaded?.cache === cache
        && loaded.key === selectionKey ? loaded.value : null;
    const [error, setError] = useState('');
    const triggerRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
        let refreshTimer: ReturnType<typeof setTimeout>;
        const invalidate = () => {
            cache.clear();
            setLoaded(null);
            setError('');
            clearTimeout(refreshTimer);
            refreshTimer = setTimeout(() => setRevision((value) => value + 1), 50);
        };
        const authLost = () => {
            invalidate();
            setSelection(null);
        };
        const onFocus = () => {
            if (document.visibilityState === 'visible') invalidate();
        };
        const onVisibility = () => {
            // Clear hidden-tab PII and check permissions again upon returning.
            invalidate();
        };
        window.addEventListener('staff-workspace-updated', invalidate);
        window.addEventListener('staff-session-invalidated', authLost);
        window.addEventListener('focus', onFocus);
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            clearTimeout(refreshTimer);
            cache.clear();
            window.removeEventListener('staff-workspace-updated', invalidate);
            window.removeEventListener('staff-session-invalidated', authLost);
            window.removeEventListener('focus', onFocus);
            document.removeEventListener('visibilitychange', onVisibility);
        };
    }, [cache]);

    useEffect(() => {
        if (!selection || status !== 'authenticated'
            || document.visibilityState !== 'visible') return;
        let current = true;
        cache.load(selectionKey, async (signal: AbortSignal) => {
            const response = await fetch(
                `/api/staff/${selection.kind === 'candidate' ? 'candidates' : 'jobs'}/${selection.id}`,
                { signal, cache: 'no-store' },
            );
            if (signal.aborted) throw new DOMException('Preview request superseded', 'AbortError');
            if (!response.ok) {
                const failure = Object.assign(new Error(
                    response.status === 403
                        ? 'You do not have permission to view this record.'
                        : response.status === 401 || response.status === 428
                          ? 'Your session expired. Sign in again.'
                          : 'This record could not be loaded.',
                ), { status: response.status });
                if ([401, 403, 428].includes(response.status)) {
                    cache.clear();
                    setLoaded(null);
                    setError(failure.message);
                }
                throw failure;
            }
            const payload = await response.json();
            if (!payload?.result) throw new Error('This record could not be loaded.');
            return payload.result;
        }).then((value: CandidateRecord | JobRecord) => {
            if (current && cache.peek(selectionKey) === value) {
                setLoaded({ cache, key: selectionKey, value });
            }
        }).catch((reason: Error) => {
            if (current && reason.name !== 'AbortError') {
                setLoaded(null);
                setError(reason.message);
            }
        });
        // Switching or closing a preview detaches its subscriber, allowing a
        // quick reopen to share the same request without stale state writes.
        return () => { current = false; };
    }, [selection, selectionKey, cache, revision, status]);

    const handleClick = (event: MouseEvent<HTMLElement>) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey
            || event.shiftKey || event.altKey) return;
        const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
        if (!anchor || !event.currentTarget.contains(anchor)
            || anchor.target || anchor.hasAttribute('download')) return;
        const url = new URL(anchor.href);
        if (url.origin !== window.location.origin || url.search || url.hash) return;
        const match = recordPath.exec(url.pathname);
        if (!match) return;
        event.preventDefault();
        event.stopPropagation();
        triggerRef.current = anchor;
        const next: Selection = {
            kind: match[1] === 'jobs' ? 'job' : 'candidate', id: match[2],
        };
        const key = `${next.kind}:${next.id}`;
        const cached = cache.peek(key) as CandidateRecord | JobRecord | undefined;
        setLoaded(cached ? { cache, key, value: cached } : null);
        setError('');
        setSelection(next);
    };

    const fullUrl = selection
        ? `/staff/${selection.kind === 'candidate' ? 'candidates' : 'jobs'}/${selection.id}`
        : '';
    const title = selection?.kind === 'candidate'
        ? record ? (record as CandidateRecord).candidate.fullName ?? 'Unnamed candidate'
            : 'Candidate preview'
        : selection?.kind === 'job'
            ? record ? (record as JobRecord).job.title : 'Job preview'
            : 'Record preview';
    const subtitle = selection?.kind === 'candidate' && record
        ? (record as CandidateRecord).candidate.headline ?? 'Candidate profile'
        : selection?.kind === 'job' && record
            ? (record as JobRecord).client?.name ?? 'Job details'
            : 'Loading record';

    return <>
        <main onClickCapture={handleClick}
            className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
        <Sheet open={selection !== null} onOpenChange={(open) => {
            if (!open) {
                setSelection(null);
                setLoaded(null);
                setError('');
            }
        }}>
            <SheetContent side="right" className="w-full max-w-full gap-0 p-0 sm:max-w-[min(900px,75vw)]"
                onCloseAutoFocus={(event) => {
                    event.preventDefault();
                    if (triggerRef.current?.isConnected) {
                        triggerRef.current.focus();
                    } else {
                        const heading = document.querySelector<HTMLElement>('main h1');
                        if (heading) {
                            heading.tabIndex = -1;
                            heading.focus();
                        }
                    }
                }}>
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4 pr-12">
                    <div className="min-w-0 space-y-1">
                        <SheetTitle className="break-words text-base">{title}</SheetTitle>
                        <SheetDescription>{subtitle}</SheetDescription>
                    </div>
                    {selection ? <Button size="sm" variant="outline" asChild>
                        <Link href={fullUrl}>Open full {selection.kind}</Link>
                    </Button> : null}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
                    {status === 'unauthenticated' ? <p role="alert" className="text-sm text-destructive">
                        Your session expired. Sign in again.</p>
                        : error ? <div className="space-y-3">
                            <p role="alert" className="text-sm text-destructive">{error}</p>
                            <Button size="sm" variant="outline" onClick={() => {
                                setError('');
                                setRevision((value) => value + 1);
                            }}>Retry</Button>
                        </div>
                        : !selection || !record ? <p role="status" className="text-sm text-muted-foreground">
                            Loading preview…</p>
                            : selection?.kind === 'candidate'
                                ? <CandidatePreview key={selection.id} record={record as CandidateRecord} />
                                : <JobPreview key={selection?.id} record={record as JobRecord} />}
                </div>
            </SheetContent>
        </Sheet>
    </>;
}
