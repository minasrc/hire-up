import { listJobs } from '@/lib/client-job-operations';
import { StaffAuthorizationError } from '@/lib/staff-authorization';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { loadStaffWorkspace } from '@/lib/workspace.server';
import { PageHeader } from '@/components/staff-preview/shared';
import { Card, CardContent } from '@/components/staff-ui/card';
import { JobsBrowser, type JobRow } from './jobs-browser';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Jobs · Agora staff' };

const LIST_LIMIT = 500;

export default async function StaffJobsPage() {
    const gate = await requireStaffVerified();
    const jobsPromise: Promise<JobRow[] | null> = listJobs(
        gate.pool, gate.identity, gate.organizationId, { limit: LIST_LIMIT },
    ).catch((error: unknown) => {
        if (error instanceof StaffAuthorizationError && error.code === 'FORBIDDEN') {
            return null;
        }
        throw error;
    });
    // Both reads authorize independently; keep concurrency bounded to two.
    const [{ summary }, jobs] = await Promise.all([
        loadStaffWorkspace(),
        jobsPromise,
    ]);

    if (jobs === null) {
        return (
            <section className="mx-auto w-full max-w-7xl">
                <PageHeader
                    eyebrow="Workspace"
                    title="Jobs"
                    description="Drafts and published roles across your clients."
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

    const clients = Array.from(
        new Map(
            jobs.map((job) => [job.clientId, job.clientName] as const),
        ).entries(),
    )
        .map(([id, name]) => ({ id, name }))
        .sort((left, right) => left.name.localeCompare(right.name));

    return (
        <section className="mx-auto w-full max-w-7xl">
            <JobsBrowser
                jobs={jobs}
                clients={clients}
                currentMembershipId={gate.principal.membership_id}
                canCreate={summary?.capabilities.writeJobs === true}
                capped={jobs.length >= LIST_LIMIT}
            />
        </section>
    );
}
