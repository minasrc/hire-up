import { listApplicationDirectory } from '@/lib/pipeline-operations';
import { StaffAuthorizationError } from '@/lib/staff-authorization';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { PageHeader } from '@/components/staff-preview/shared';
import { Card, CardContent } from '@/components/staff-ui/card';
import { ApplicationsBrowser, type ApplicationRow } from './applications-browser';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Applications · Agora staff' };

export default async function StaffApplicationsPage({ searchParams }: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const gate = await requireStaffVerified();
    const params = await searchParams;
    let applications: ApplicationRow[] | null = null;
    let directory;
    try {
        directory = await listApplicationDirectory(
            gate.pool, gate.identity, gate.organizationId, { ...params, stage: params.stage ?? 'active' });
        applications = directory.rows;
    } catch (error) {
        if (!(error instanceof StaffAuthorizationError && error.code === 'FORBIDDEN')) throw error;
    }

    if (applications === null) {
        return (
            <section className="mx-auto w-full max-w-7xl">
                <PageHeader
                    eyebrow="Workspace"
                    title="Applications"
                />
                <Card className="mt-6">
                    <CardContent className="py-8 text-center">
                        <p className="text-sm text-muted-foreground">
                            Application review requires the applications.read permission.
                        </p>
                    </CardContent>
                </Card>
            </section>
        );
    }

    return (
        <section className="mx-auto w-full max-w-7xl">
            <ApplicationsBrowser
                applications={applications}
                clientOptions={directory.clients}
                jobs={directory.jobs}
                stages={directory.stages}
                scopeTotal={directory.scopeTotal}
                total={directory.total}
                page={directory.page}
                pageSize={directory.pageSize}
            />
        </section>
    );
}
