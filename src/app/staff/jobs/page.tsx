import { listJobDirectory } from '@/lib/client-job-operations';
import { StaffAuthorizationError } from '@/lib/staff-authorization';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { loadStaffCapabilities } from '@/lib/workspace.server';
import { PageHeader } from '@/components/staff-preview/shared';
import { Card, CardContent } from '@/components/staff-ui/card';
import { JobsBrowser, type JobRow } from './jobs-browser';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Jobs · Agora staff' };

type Directory = {
    rows: JobRow[];
    total: number;
    page: number;
    pageSize: number;
    clients: { id: string; name: string }[];
};


export default async function StaffJobsPage({
    searchParams,
}: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
    const gate = await requireStaffVerified();
    const directoryPromise: Promise<Directory | null> = listJobDirectory(
        gate.pool, gate.identity, gate.organizationId, await searchParams,
    ).catch((error: unknown) => {
        if (error instanceof StaffAuthorizationError && error.code === 'FORBIDDEN') {
            return null;
        }
        throw error;
    });
    // Both reads authorize independently; keep concurrency bounded to two.
    const [{ capabilities }, directory] = await Promise.all([
        loadStaffCapabilities(),
        directoryPromise,
    ]);

    if (directory === null) {
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

    return (
        <section className="mx-auto w-full max-w-7xl">
            <JobsBrowser
                jobs={directory.rows}
                clients={directory.clients}
                canCreate={capabilities?.writeJobs === true}
                total={directory.total}
                page={directory.page}
                pageSize={directory.pageSize}
            />
        </section>
    );
}
