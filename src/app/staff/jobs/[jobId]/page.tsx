import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import {
    getClient,
    previewJobPublic,
} from '@/lib/client-job-operations';
import { getJobWorkspace } from '@/lib/recruitment-operations';
import { StaffAuthorizationError } from '@/lib/staff-authorization';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { loadStaffWorkspace } from '@/lib/workspace.server';
import { FieldLabel, PageHeader, StatusBadge, TagPill } from '@/components/staff-preview/shared';
import { JobDocumentView } from '@/components/staff-preview/job-document';
import {
    employmentTypeLabel,
    jobStatusLabel,
    workplaceModeLabel,
} from '@/lib/job-display';
import { Button } from '@/components/staff-ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/staff-ui/card';
import {
    DuplicateJobButton,
    JobListingToggle,
    NewRevisionButton,
    PublishButton,
} from '../../workspace-forms';
import { RecordPreviewLink } from '../../record-previews';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Job · Agora staff' };

const formatCompensation = (revision: {
    compensationMin?: string | null;
    compensationMax?: string | null;
    currency?: string | null;
    payPeriod?: string | null;
} | null | undefined) => {
    const min = revision?.compensationMin;
    const max = revision?.compensationMax;
    if (!min && !max) return null;
    const range = min && max ? `${min}–${max}` : (min ?? max);
    return `${range} ${revision?.currency ?? ''}${
        revision?.payPeriod ? ` per ${revision.payPeriod}` : ''
    }`.trim();
};

const formatDateTime = (iso: string | null | undefined) =>
    iso
        ? new Date(iso).toLocaleString('en-GB', {
              day: 'numeric', month: 'short', year: 'numeric',
              hour: '2-digit', minute: '2-digit',
          })
        : null;

export default async function StaffJobPage(
    { params }: { params: Promise<{ jobId: string }> },
) {
    const gate = await requireStaffVerified();
    const { jobId } = await params;

    let workspace = null;
    try {
        workspace = await getJobWorkspace(
            gate.pool, gate.identity, gate.organizationId, jobId);
    } catch (error) {
        if (error instanceof StaffAuthorizationError && error.code === 'FORBIDDEN') {
            return (
                <section className="mx-auto w-full max-w-5xl">
                    <PageHeader
                        eyebrow="Jobs"
                        title="Job"
                        description="Drafts, publication state and the public preview for this role."
                    />
                    <Card className="mt-6">
                        <CardContent className="py-8 text-center">
                            <p className="text-sm text-muted-foreground">
                                Job access requires the jobs.read and clients.read permissions.
                            </p>
                        </CardContent>
                    </Card>
                </section>
            );
        }
        if ((error as { code?: string })?.code === 'P0002') {
            notFound();
        }
        throw error;
    }
    if (!workspace?.job) {
        notFound();
    }

    const { job, draft, published, publicationNeedsReview } = workspace;
    const { summary } = await loadStaffWorkspace();
    const capabilities = workspace.context?.capabilities ?? summary?.capabilities;
    const canWrite = capabilities?.writeJobs === true;
    const canReadApplications = capabilities?.readApplications === true;
    // Client details and the public preview are independent, optional reads.
    // Settling both preserves their separate error states without a waterfall.
    const [clientResult, previewResult] = await Promise.allSettled([
        getClient(gate.pool, gate.identity, gate.organizationId,
            { clientId: job.clientId }),
        draft
            ? previewJobPublic(gate.pool, gate.identity, gate.organizationId,
                { revisionId: draft.id })
            : Promise.resolve(null),
    ]);
    const client = clientResult.status === 'fulfilled'
        ? clientResult.value?.client ?? clientResult.value
        : null;
    const clientError = clientResult.status === 'rejected';
    const preview = previewResult.status === 'fulfilled' ? previewResult.value : null;
    const previewError = previewResult.status === 'rejected';

    const field = (label: string, value: ReactNode) => (
        <FieldLabel label={label}>{value ?? '—'}</FieldLabel>
    );

    const duplicateSource = draft ?? published;
    const shownRevision = draft ?? published;

    return (
        <section className="mx-auto flex w-full max-w-5xl flex-col gap-6">
            <Link
                href="/staff/jobs"
                className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground"
            >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                Back to jobs
            </Link>

            <PageHeader
                eyebrow="Jobs"
                title={job.title}
                description={
                    client?.name
                        ? `${client.name} · revision workspace for this role`
                        : 'Revision workspace for this role'
                }
                actions={
                    <>
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
                        {job.publicationState !== 'draft' && draft ? (
                            <TagPill>Unpublished draft</TagPill>
                        ) : null}
                        {job.publicationState === 'published'
                            && job.publiclyListed === true
                            && job.applicationState === 'closed' ? (
                                <TagPill>Applications closed</TagPill>
                            ) : null}
                    </>
                }
            />

            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                {client?.name ? (
                    <RecordPreviewLink
                        kind="client"
                        id={job.clientId}
                        className="rounded-sm font-medium text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        {client.name}
                    </RecordPreviewLink>
                ) : null}
                {shownRevision?.locations?.length ? (
                    <span>· {shownRevision.locations.join(', ')}</span>
                ) : null}
                {shownRevision?.employmentType ? (
                    <span>· {employmentTypeLabel(shownRevision.employmentType)}</span>
                ) : null}
                {shownRevision?.workplaceMode ? (
                    <span>· {workplaceModeLabel(shownRevision.workplaceMode)}</span>
                ) : null}
                {job.applicationCount !== null && job.applicationCount !== undefined ? (
                    <span>
                        ·{' '}
                        {canReadApplications ? (
                            <Link
                                href={`/staff/applications?client=${job.clientId}&job=${job.id}`}
                                className="rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                            >
                                {job.applicationCount} application
                                {job.applicationCount === 1 ? '' : 's'}
                            </Link>
                        ) : (
                            `${job.applicationCount} application${
                                job.applicationCount === 1 ? '' : 's'
                            }`
                        )}
                    </span>
                ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-2">
                {canWrite && duplicateSource ? (
                    <DuplicateJobButton
                        sourceJobId={job.id}
                        clientId={job.clientId}
                        sourceRevisionId={duplicateSource.id}
                        expectedSourceVersion={duplicateSource.version}
                    />
                ) : null}
                {canReadApplications ? (
                    <Button variant="outline" size="sm" asChild>
                        <Link href={`/staff/applications?client=${job.clientId}&job=${job.id}`}>
                            View applications
                        </Link>
                    </Button>
                ) : null}
            </div>

            {clientError ? (
                <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning-foreground">
                    Client details are temporarily unavailable — the job data below is
                    unaffected.
                </p>
            ) : null}

            <Card>
                <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex flex-col gap-1">
                        <CardTitle className="text-base">Draft revision</CardTitle>
                        {draft ? (
                            <CardDescription>
                                Revision #{draft.revisionNumber} · version {draft.version}
                            </CardDescription>
                        ) : null}
                    </div>
                    {canWrite ? (
                        draft ? (
                            <Button variant="outline" size="sm" asChild>
                                <Link href={`/staff/jobs/${job.id}/edit`}>Edit draft</Link>
                            </Button>
                        ) : (
                            <NewRevisionButton
                                jobId={job.id}
                                expectedJobVersion={job.version}
                            />
                        )
                    ) : (
                        <p className="text-xs text-muted-foreground">
                            Editing this job requires the jobs.write permission.
                        </p>
                    )}
                </CardHeader>
                <CardContent className="flex flex-col gap-5">
                    {draft ? (
                        <>
                            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                                {field('Title', draft.title)}
                                {field('Employment', draft.employmentType)}
                                {field('Workplace', draft.workplaceMode)}
                                {field('Locations', draft.locations?.join(', ') || null)}
                                {field(
                                    'Remote regions',
                                    draft.remoteRegions?.join(', ') || null,
                                )}
                                {field('Compensation', formatCompensation(draft))}
                            </dl>
                            <div className="border-t border-border pt-4">
                                <JobDocumentView document={draft.descriptionDocument} />
                            </div>
                        </>
                    ) : (
                        <p className="text-sm text-muted-foreground">
                            No open draft — start a new revision to make changes.
                        </p>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex flex-col gap-1">
                        <CardTitle className="text-base">Public board</CardTitle>
                        <CardDescription>
                            {job.publicationState === 'draft'
                                ? 'Used when this draft is published.'
                                : 'Unlisted jobs do not accept public applications.'}
                        </CardDescription>
                    </div>
                    {canWrite ? (
                        <JobListingToggle
                            jobId={job.id}
                            listed={job.publiclyListed}
                            expectedVersion={job.version}
                        />
                    ) : (
                        <p className="text-xs text-muted-foreground">
                            Changing visibility requires the jobs.write permission.
                        </p>
                    )}
                </CardHeader>
                <CardContent>
                    <p className="text-sm text-muted-foreground">
                        {job.publicationState === 'draft'
                            ? 'Visibility after publishing: '
                            : 'Current visibility: '}
                        <span className="font-medium text-foreground">
                            {job.publiclyListed ? 'Listed' : 'Unlisted'}
                        </span>
                    </p>
                </CardContent>
            </Card>

            {published ? (
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Current version</CardTitle>
                        <CardDescription>
                            Revision #{published.revisionNumber}
                            {published.publishedAt
                                ? ` · published ${formatDateTime(published.publishedAt)}`
                                : ''}
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-5">
                        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                            {field('Published as', published.publishedCompanyName)}
                        </dl>
                        {publicationNeedsReview ? (
                            <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning-foreground">
                                The client public profile changed since publication —
                                review before relying on this listing.
                            </p>
                        ) : null}
                        <div className="border-t border-border pt-4">
                            <JobDocumentView document={published.descriptionDocument} />
                        </div>
                    </CardContent>
                </Card>
            ) : null}

            {draft && previewError ? (
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Review before publishing</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-sm text-muted-foreground">
                            The publish preview is temporarily unavailable — reload the
                            page to try again before publishing.
                        </p>
                    </CardContent>
                </Card>
            ) : null}

            {preview && draft ? (
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Review before publishing</CardTitle>
                        <CardDescription>
                            {job.publiclyListed
                                ? 'This version will appear on the public board when published.'
                                : 'This version will stay unlisted when published.'}
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-5">
                        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                            {field('Role', preview.projection?.title)}
                            {field(
                                'Locations',
                                preview.projection?.locations?.join(', ') || null,
                            )}
                            {field(
                                'Compensation',
                                preview.projection?.compensation
                                    ? formatCompensation({
                                          compensationMin:
                                              preview.projection.compensation.min,
                                          compensationMax:
                                              preview.projection.compensation.max,
                                          currency:
                                              preview.projection.compensation.currency,
                                          payPeriod:
                                              preview.projection.compensation.payPeriod,
                                      })
                                    : null,
                            )}
                            {field(
                                'Company shown publicly',
                                preview.projection?.company?.name,
                            )}
                            {field(
                                'Public description',
                                preview.projection?.company?.description,
                            )}
                        </dl>
                        <div className="border-t border-border pt-4">
                            <JobDocumentView
                                document={preview.projection?.descriptionDocument}
                            />
                        </div>
                        <div>
                            {canWrite ? (
                                <PublishButton
                                    jobId={job.id}
                                    revisionId={draft.id}
                                    expectedVersion={draft.version}
                                    expectedClientVersion={preview.clientVersion}
                                    reviewHash={preview.reviewHash}
                                />
                            ) : (
                                <p className="text-xs text-muted-foreground">
                                    Publishing requires the jobs.write permission.
                                </p>
                            )}
                        </div>
                    </CardContent>
                </Card>
            ) : null}
        </section>
    );
}
