import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { getJobWorkspace } from '@/lib/client-job-operations';
import { StaffAuthorizationError } from '@/lib/staff-authorization';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { loadStaffWorkspace } from '@/lib/workspace.server';
import { PageHeader } from '@/components/staff-preview/shared';
import { Card, CardContent } from '@/components/staff-ui/card';
import { JobForm } from '../../../workspace-forms';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Edit draft · Agora staff' };

export default async function StaffJobEditPage(
    { params }: { params: Promise<{ jobId: string }> },
) {
    const gate = await requireStaffVerified();
    const { jobId } = await params;

    let workspace = null;
    let loadFailure: 'forbidden' | 'unavailable' | null = null;
    try {
        workspace = await getJobWorkspace(
            gate.pool, gate.identity, gate.organizationId, { jobId });
    } catch (error) {
        if (error instanceof StaffAuthorizationError && error.code === 'FORBIDDEN') {
            loadFailure = 'forbidden';
        } else if ((error as { code?: string })?.code === 'P0002') {
            notFound();
        } else {
            loadFailure = 'unavailable';
        }
    }

    if (loadFailure) {
        return (
            <section className="mx-auto w-full max-w-5xl">
                <PageHeader
                    eyebrow="Jobs"
                    title="Edit draft"
                />
                <Card className="mt-6">
                    <CardContent className="py-8 text-center">
                        <p className="text-sm text-muted-foreground">
                            {loadFailure === 'forbidden'
                                ? 'Job access requires the jobs.read and clients.read permissions.'
                                : 'This job could not be loaded. Go back and try again.'}
                        </p>
                    </CardContent>
                </Card>
            </section>
        );
    }
    if (!workspace?.job) {
        notFound();
    }
    if (!workspace.draft) {
        redirect(`/staff/jobs/${jobId}`);
    }

    const { summary } = await loadStaffWorkspace();
    const canWrite = summary?.capabilities.writeJobs === true;
    const { job, draft } = workspace;
    return (
        <section className="mx-auto flex w-full max-w-5xl flex-col gap-6">
            <Link
                href={`/staff/jobs/${job.id}`}
                className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground"
            >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                Back to {job.title}
            </Link>
            <PageHeader
                eyebrow="Jobs"
                title={`Edit draft revision #${draft.revisionNumber}`}
                description={job.title}
            />
            <Card>
                <CardContent className="pt-6">
                    {canWrite ? (
                        <JobForm
                            clients={[]}
                            jobId={job.id}
                            revisionId={draft.id}
                            expectedVersion={draft.version}
                            initial={{
                                clientId: job.clientId,
                                title: draft.title,
                                employmentType: draft.employmentType,
                                workplaceMode: draft.workplaceMode,
                                locations: draft.locations ?? [],
                                remoteRegions: draft.remoteRegions ?? [],
                                compensationMin: draft.compensationMin,
                                compensationMax: draft.compensationMax,
                                currency: draft.currency,
                                payPeriod: draft.payPeriod,
                                bonuses: draft.bonuses ?? [],
                                descriptionDocument: draft.descriptionDocument,
                                descriptionText: draft.descriptionText ?? '',
                            }}
                        />
                    ) : (
                        <p className="py-4 text-center text-sm text-muted-foreground">
                            {summary === null
                                ? 'Editing is temporarily unavailable.'
                                : 'Editing this job requires the jobs.write permission.'}
                        </p>
                    )}
                </CardContent>
            </Card>
        </section>
    );
}
