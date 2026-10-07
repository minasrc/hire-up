'use client';

import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type ReactNode,
} from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { usePathname, useRouter } from 'next/navigation';
import { Lock, ShieldAlert } from 'lucide-react';

import { Badge } from '@/components/staff-ui/badge';
import { Button } from '@/components/staff-ui/button';
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetTitle,
} from '@/components/staff-ui/sheet';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/staff-ui/table';
import { JobDocumentView } from '@/components/staff-preview/job-document';
import {
    InitialsAvatar,
    StatusBadge,
    TagPill,
} from '@/components/staff-preview/shared';
import {
    employmentTypeLabel,
    jobStatusLabel,
    socialPlatformLabel,
    workplaceModeLabel,
} from '@/lib/job-display';
import type {
    ApplicationCard,
    CandidateWorkspace,
    ClientWorkspace,
    JobWorkspace,
} from '@/lib/recruitment-types';
import {
    RecordPreviewContext,
    RecordPreviewLink,
    recordHref,
    useRecordPreview,
    type RecordPreviewKind,
} from './record-preview-context';

export {
    RecordPreviewLink,
    recordHref,
    useRecordPreview,
    type RecordPreviewKind,
};

// Candidate editing is only needed after opening a candidate preview.
const CandidateDetail = dynamic(
    () => import('./candidates/[candidateId]/candidate-detail').then(
        (module) => module.CandidateDetail,
    ),
    {
        loading: () => (
            <p role="status" className="py-8 text-sm text-muted-foreground">
                Loading candidate details…
            </p>
        ),
    },
);

const NewRevisionButton = dynamic(
    () => import('./workspace-forms').then((module) => module.NewRevisionButton),
    {
        loading: () => (
            <Button variant="outline" size="sm" disabled>
                Loading draft action…
            </Button>
        ),
    },
);

const RECORD_ENDPOINTS: Record<RecordPreviewKind, string> = {
    candidate: '/api/staff/candidates',
    job: '/api/staff/jobs',
    client: '/api/staff/clients',
};

const STAGE_TONES: Record<string, 'accent' | 'warning' | 'success' | 'secondary'> = {
    new: 'accent',
    reviewing: 'warning',
    interview: 'success',
    hired: 'success',
    rejected: 'secondary',
};

function stageTone(key: string): 'accent' | 'warning' | 'success' | 'secondary' {
    return STAGE_TONES[key] ?? 'secondary';
}

type PreviewData =
    | { kind: 'candidate'; data: CandidateWorkspace }
    | { kind: 'job'; data: JobWorkspace }
    | { kind: 'client'; data: ClientWorkspace };

function JobPreviewBody({ workspace }: { workspace: JobWorkspace }) {
    const { job, draft, published } = workspace;
    const shown = draft ?? published;
    const status = jobStatusLabel(job);
    const applicationCount = job.applicationCount;
    return (
        <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center gap-2">
                <StatusBadge
                    tone={
                        status === 'Listed'
                            ? 'success'
                            : status === 'Draft'
                              ? 'secondary'
                              : 'outline'
                    }
                >
                    {status}
                </StatusBadge>
                {job.publicationState !== 'draft' && draft ? (
                    <TagPill>Unpublished draft</TagPill>
                ) : null}
                {shown?.employmentType ? (
                    <TagPill>{employmentTypeLabel(shown.employmentType)}</TagPill>
                ) : null}
                {shown?.workplaceMode ? (
                    <TagPill>{workplaceModeLabel(shown.workplaceMode)}</TagPill>
                ) : null}
                {(shown?.locations?.length ?? 0) > 0 ? (
                    <TagPill>{shown!.locations.join(', ')}</TagPill>
                ) : null}
                {(shown?.remoteRegions?.length ?? 0) > 0 ? (
                    <TagPill>Remote: {shown!.remoteRegions.join(', ')}</TagPill>
                ) : null}
                {job.clientIsStealth ? (
                    <Badge variant="outline">Identity hidden externally</Badge>
                ) : null}
            </div>
            <p className="text-sm text-muted-foreground">
                <RecordPreviewLink
                    kind="client"
                    id={job.clientId}
                    className="rounded-sm font-medium text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                >
                    {job.clientName ?? 'Client'}
                </RecordPreviewLink>
            </p>
            <p className="text-sm text-muted-foreground">
                {applicationCount === null || applicationCount === undefined
                    ? 'Application count unavailable.'
                    : `${applicationCount} application${applicationCount === 1 ? '' : 's'} for this role.`}
            </p>
            {shown?.descriptionDocument ? (
                <JobDocumentView document={shown.descriptionDocument} />
            ) : (
                <p className="text-sm text-muted-foreground">No description yet.</p>
            )}
        </div>
    );
}

function ClientPreviewBody({ workspace }: { workspace: ClientWorkspace }) {
    const { client } = workspace;
    const canReadApplications =
        workspace.context?.capabilities?.readApplications === true;
    return (
        <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center gap-2">
                <StatusBadge tone={client.status === 'draft' ? 'secondary' : 'success'}>
                    {client.status === 'draft' ? 'Draft client' : 'Active client'}
                </StatusBadge>
                {client.isStealth ? (
                    <Badge variant="outline">Identity hidden externally</Badge>
                ) : null}
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
                {[
                    {
                        label: 'Open roles',
                        value: workspace.openRoles,
                        href: `/staff/jobs?client=${client.id}`,
                    },
                    {
                        label: 'Applications',
                        value: workspace.applicationCount,
                        href: `/staff/applications?client=${client.id}`,
                    },
                    {
                        label: 'Interviewing',
                        value: workspace.interviewingCount,
                        href: `/staff/applications?client=${client.id}&stage=interview`,
                    },
                ].map((metric) =>
                    metric.value === null || metric.value === undefined ? (
                        <div
                            key={metric.label}
                            className="flex flex-col gap-0.5 rounded-lg bg-secondary/50 px-2 py-2"
                        >
                            <span className="text-[11px] text-muted-foreground">
                                {metric.label}
                            </span>
                            <span className="text-sm font-semibold text-foreground">—</span>
                        </div>
                    ) : (
                        <Link
                            key={metric.label}
                            href={metric.href}
                            className="flex flex-col gap-0.5 rounded-lg bg-secondary/50 px-2 py-2 outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            <span className="text-[11px] text-muted-foreground">
                                {metric.label}
                            </span>
                            <span className="text-sm font-semibold text-foreground">
                                {metric.value}
                            </span>
                        </Link>
                    ),
                )}
            </div>
            <section className="flex flex-col gap-3">
                <h2 className="text-sm font-semibold text-foreground">Client details</h2>
                <dl className="grid gap-3 sm:grid-cols-2">
                    <div>
                        <dt className="text-xs text-muted-foreground">Contact</dt>
                        <dd className="text-sm text-foreground">
                            {client.contactName ?? 'Not provided'}
                        </dd>
                        <dd className="text-xs text-muted-foreground">
                            {client.contactEmail ?? 'No contact email'}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-xs text-muted-foreground">Website</dt>
                        <dd className="truncate text-sm text-foreground">
                            {client.website ? (
                                <a
                                    href={client.website}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="rounded-sm underline underline-offset-4 outline-none hover:opacity-70 focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                    {client.website}
                                </a>
                            ) : (
                                'Not provided'
                            )}
                        </dd>
                    </div>
                </dl>
                {(client.socialLinks?.length ?? 0) > 0 ? (
                    <div className="flex flex-col gap-1">
                        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                            Social links
                        </span>
                        <ul className="flex flex-col gap-0.5">
                            {client.socialLinks!.map((link) => (
                                <li key={`${link.platform}:${link.url}`}>
                                    <a
                                        href={link.url}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="w-fit break-all rounded-sm text-xs font-medium text-accent-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                                    >
                                        {socialPlatformLabel(link.platform)}
                                        {' · '}
                                        {link.url}
                                    </a>
                                </li>
                            ))}
                        </ul>
                    </div>
                ) : null}
                {client.isStealth && client.anonymousDescription ? (
                    <p className="rounded-lg bg-secondary/50 px-3 py-2 text-sm text-muted-foreground">
                        {client.anonymousDescription}
                    </p>
                ) : null}
            </section>
            <section className="flex flex-col gap-3">
                <h2 className="text-sm font-semibold text-foreground">Roles</h2>
                {workspace.jobs.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        {workspace.jobTotal === null
                            ? 'The roles list requires the jobs.read permission.'
                            : 'No roles for this client yet.'}
                    </p>
                ) : (
                    <div className="overflow-hidden rounded-lg border border-border bg-card">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Role</TableHead>
                                    <TableHead className="w-16">Apps</TableHead>
                                    <TableHead>Status</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {workspace.jobs.map((job) => (
                                    <TableRow key={job.id}>
                                        <TableCell>
                                            <div className="flex min-w-0 flex-col">
                                                <RecordPreviewLink
                                                    kind="job"
                                                    id={job.id}
                                                    className="rounded-sm font-medium text-foreground outline-none hover:text-accent-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                                                >
                                                    {job.title}
                                                </RecordPreviewLink>
                                                <span className="text-xs text-muted-foreground">
                                                    {job.locations.length > 0
                                                        ? job.locations.join(', ')
                                                        : job.remoteRegions.length > 0
                                                          ? `Remote · ${job.remoteRegions.join(', ')}`
                                                          : 'Location not specified'}{' '}
                                                    · {employmentTypeLabel(job.employmentType)}
                                                </span>
                                            </div>
                                        </TableCell>
                                        <TableCell className="text-muted-foreground">
                                            {canReadApplications
                                                && job.applicationCount !== null
                                                && job.applicationCount !== undefined ? (
                                                <Link
                                                    href={`/staff/applications?client=${client.id}&job=${job.id}`}
                                                    className="rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                                                >
                                                    {job.applicationCount}
                                                </Link>
                                            ) : (
                                                job.applicationCount ?? '—'
                                            )}
                                        </TableCell>
                                        <TableCell>
                                            <StatusBadge
                                                tone={
                                                    jobStatusLabel(job) === 'Listed'
                                                        ? 'success'
                                                        : jobStatusLabel(job) === 'Draft'
                                                          ? 'secondary'
                                                          : 'outline'
                                                }
                                            >
                                                {jobStatusLabel(job)}
                                            </StatusBadge>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                )}
            </section>
            <section className="flex flex-col gap-3">
                <h2 className="text-sm font-semibold text-foreground">Recent applications</h2>
                {workspace.recentApplications.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        {workspace.applicationCount === null
                            ? 'Recent applications require the applications.read permission.'
                            : 'No applications for this client yet.'}
                    </p>
                ) : (
                    <div className="overflow-hidden rounded-lg border border-border bg-card">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Candidate</TableHead>
                                    <TableHead>Job</TableHead>
                                    <TableHead>Stage</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {workspace.recentApplications.map((row: ApplicationCard) => (
                                    <TableRow key={row.applicationId}>
                                        <TableCell>
                                            <RecordPreviewLink
                                                kind="candidate"
                                                id={row.candidateId}
                                                className="rounded-sm font-medium text-foreground outline-none hover:text-accent-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                                            >
                                                {row.candidateName}
                                            </RecordPreviewLink>
                                        </TableCell>
                                        <TableCell>{row.jobTitle}</TableCell>
                                        <TableCell>
                                            <StatusBadge tone={stageTone(row.stageKind)}>
                                                {row.stageLabel}
                                            </StatusBadge>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                )}
            </section>
        </div>
    );
}

export function StaffRecordPreviewProvider({ children }: { children: ReactNode }) {
    const router = useRouter();
    const pathname = usePathname();
    const [preview, setPreview] = useState<{ kind: RecordPreviewKind; id: string } | null>(null);
    const [record, setRecord] = useState<PreviewData | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const generationRef = useRef(0);
    const abortRef = useRef<AbortController | null>(null);
    const triggerRef = useRef<HTMLElement | null>(null);
    const previewRef = useRef<{ kind: RecordPreviewKind; id: string } | null>(null);
    const pathnameRef = useRef(pathname);

    const cancelActive = useCallback(() => {
        abortRef.current?.abort();
        abortRef.current = null;
    }, []);

    const load = useCallback(
        async (kind: RecordPreviewKind, id: string) => {
            const generation = ++generationRef.current;
            cancelActive();
            const controller = new AbortController();
            abortRef.current = controller;
            setLoading(true);
            setError('');
            setRecord(null);
            try {
                const response = await fetch(`${RECORD_ENDPOINTS[kind]}/${id}`, {
                    signal: controller.signal,
                    headers: { accept: 'application/json' },
                });
                if (generation !== generationRef.current) return;
                if (!response.ok) {
                    setError(
                        response.status === 401 || response.status === 428
                            ? 'Your session expired. Sign in again.'
                            : response.status === 403
                              ? 'You do not have permission to view this record.'
                              : response.status === 404
                                ? 'This record could not be found.'
                                : 'The record could not be loaded.',
                    );
                    setLoading(false);
                    return;
                }
                const payload = await response.json();
                if (generation !== generationRef.current) return;
                setRecord({ kind, data: payload.result } as PreviewData);
                setLoading(false);
            } catch (fetchError) {
                if ((fetchError as { name?: string })?.name === 'AbortError') return;
                if (generation !== generationRef.current) return;
                setError('The record could not be loaded.');
                setLoading(false);
            }
        },
        [cancelActive],
    );

    const open = useCallback(
        (kind: RecordPreviewKind, id: string, trigger: HTMLElement) => {
            triggerRef.current = trigger;
            previewRef.current = { kind, id };
            setPreview({ kind, id });
            void load(kind, id);
        },
        [load],
    );

    const close = useCallback(() => {
        generationRef.current += 1;
        cancelActive();
        previewRef.current = null;
        setPreview(null);
        setRecord(null);
        setError('');
        setLoading(false);
    }, [cancelActive]);

    const refresh = useCallback(
        (kind: RecordPreviewKind, id: string) => {
            const current = previewRef.current;
            if (current?.kind === kind && current.id === id) {
                void load(kind, id);
            }
            router.refresh();
        },
        [load, router],
    );

    useEffect(() => cancelActive, [cancelActive]);

    useEffect(() => {
        if (pathname !== pathnameRef.current) {
            pathnameRef.current = pathname;
            close();
        }
    }, [pathname, close]);

    const title = preview
        ? record?.kind === 'candidate'
            ? record.data.candidate.fullName
            : record?.kind === 'job'
              ? record.data.job.title
              : record?.kind === 'client'
                ? record.data.client.name
                : loading
                  ? 'Loading…'
                  : error
                    ? 'Preview unavailable'
                    : 'Preview'
        : '';
    const subtitle =
        record?.kind === 'candidate'
            ? record.data.candidate.lifecycle === 'restricted'
                ? `Record ${record.data.candidate.candidateId}`
                : [record.data.candidate.headline, record.data.candidate.location]
                      .filter(Boolean)
                      .join(' · ') || 'Candidate'
            : record?.kind === 'job'
              ? `${record.data.job.clientName ?? 'Client'} · ${
                    record.data.draft?.locations?.join(', ')
                    ?? record.data.published?.locations?.join(', ')
                    ?? 'Location not specified'
                }`
              : record?.kind === 'client'
                ? 'Client'
                : '';

    return (
        <RecordPreviewContext.Provider value={{ open }}>
            {children}
            <Sheet
                open={preview !== null}
                onOpenChange={(openSheet) => {
                    if (!openSheet) close();
                }}
            >
                <SheetContent
                    side="right"
                    className="w-full max-w-full gap-0 p-0 sm:max-w-[min(900px,75vw)]"
                    onCloseAutoFocus={(event) => {
                        event.preventDefault();
                        const trigger = triggerRef.current;
                        if (trigger?.isConnected) {
                            trigger.focus();
                            return;
                        }
                        const heading = document.querySelector<HTMLElement>('main h1');
                        if (heading) {
                            heading.setAttribute('tabindex', '-1');
                            heading.focus();
                        }
                    }}
                >
                    <div className="sticky top-0 flex items-center justify-between gap-3 border-b border-border bg-card px-5 py-4 pr-12">
                        <div className="flex min-w-0 items-center gap-3">
                            {record?.kind === 'candidate' ? (
                                <InitialsAvatar name={record.data.candidate.fullName} />
                            ) : null}
                            <div className="flex min-w-0 flex-col">
                                <SheetTitle className="truncate text-base">{title}</SheetTitle>
                                <SheetDescription className="truncate">
                                    {subtitle}
                                </SheetDescription>
                            </div>
                        </div>
                        {preview && record?.kind === 'candidate'
                            && record.data.candidate.lifecycle === 'restricted' ? null : (
                            <Button size="sm" disabled={!preview} asChild>
                                <Link
                                    href={preview ? recordHref(preview.kind, preview.id) : '#'}
                                    onClick={() => {
                                        if (
                                            preview
                                            && recordHref(preview.kind, preview.id) === pathname
                                        ) {
                                            close();
                                        }
                                    }}
                                >
                                    {preview?.kind === 'candidate'
                                        ? 'Open full profile'
                                        : preview?.kind === 'job'
                                          ? 'Open full job'
                                          : 'Open full client'}
                                </Link>
                            </Button>
                        )}
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                        {loading ? (
                            <p className="py-8 text-sm text-muted-foreground">Loading…</p>
                        ) : error ? (
                            <div className="flex flex-col items-start gap-3 py-8">
                                <p role="alert" className="text-sm text-destructive">
                                    {error}
                                </p>
                                {preview ? (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => void load(preview.kind, preview.id)}
                                    >
                                        Retry
                                    </Button>
                                ) : null}
                            </div>
                        ) : record?.kind === 'candidate' ? (
                            record.data.candidate.lifecycle === 'restricted' ? (
                                <div className="flex flex-col gap-4">
                                    <StatusBadge tone="restriction">Restricted</StatusBadge>
                                    <div className="flex items-start gap-3 rounded-lg border border-restriction/60 bg-restriction/40 p-4">
                                        <ShieldAlert
                                            className="mt-0.5 h-4 w-4 shrink-0 text-restriction-foreground"
                                            aria-hidden="true"
                                        />
                                        <p className="text-sm text-restriction-foreground/90">
                                            Staff access to this record is restricted. Notes,
                                            contact details and documents are hidden in this
                                            preview.
                                        </p>
                                    </div>
                                    {record.data.capabilities?.managePrivacy ? (
                                        <Button variant="outline" className="w-fit" asChild>
                                            <a href="/staff/privacy">
                                                <Lock aria-hidden="true" />
                                                Open data requests
                                            </a>
                                        </Button>
                                    ) : null}
                                </div>
                            ) : (
                                <CandidateDetail
                                    key={`candidate:${record.data.candidate.candidateId}`}
                                    workspace={record.data}
                                    embedded
                                    onChanged={() =>
                                        refresh(
                                            'candidate',
                                            record.data.candidate.candidateId,
                                        )
                                    }
                                />
                            )
                        ) : record?.kind === 'job' ? (
                            <div
                                key={`job:${record.data.job.id}`}
                                className="flex flex-col gap-5"
                            >
                                <div className="flex flex-wrap items-center gap-2">
                                    {record.data.context?.capabilities?.writeJobs === true ? (
                                        record.data.draft ? (
                                            <Button size="sm" variant="outline" asChild>
                                                <Link href={`/staff/jobs/${record.data.job.id}/edit`}>
                                                    Edit draft
                                                </Link>
                                            </Button>
                                        ) : (
                                            <NewRevisionButton
                                                jobId={record.data.job.id}
                                                expectedJobVersion={record.data.job.version}
                                            />
                                        )
                                    ) : null}
                                    {record.data.context?.capabilities?.readApplications
                                        === true ? (
                                        <Button size="sm" variant="outline" asChild>
                                            <Link
                                                href={`/staff/applications?client=${record.data.job.clientId}&job=${record.data.job.id}`}
                                            >
                                                View applications
                                            </Link>
                                        </Button>
                                    ) : null}
                                </div>
                                <JobPreviewBody workspace={record.data} />
                            </div>
                        ) : record?.kind === 'client' ? (
                            <div
                                key={`client:${record.data.client.id}`}
                                className="flex flex-col gap-5"
                            >
                                <div className="flex flex-wrap items-center gap-2">
                                    {record.data.context?.capabilities?.writeJobs === true
                                        && record.data.client.status === 'active' ? (
                                        <Button size="sm" variant="outline" asChild>
                                            <Link href={`/staff/jobs/new?client=${record.data.client.id}`}>
                                                Add job
                                            </Link>
                                        </Button>
                                    ) : null}
                                    {record.data.context?.capabilities?.readApplications
                                        === true ? (
                                        <Button size="sm" variant="outline" asChild>
                                            <Link href={`/staff/applications?client=${record.data.client.id}`}>
                                                View applications
                                            </Link>
                                        </Button>
                                    ) : null}
                                </div>
                                <ClientPreviewBody workspace={record.data} />
                            </div>
                        ) : null}
                    </div>
                </SheetContent>
            </Sheet>
        </RecordPreviewContext.Provider>
    );
}
