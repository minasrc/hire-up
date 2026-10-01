import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { getClient, listClients } from '@/lib/client-job-operations';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { loadStaffWorkspace } from '@/lib/workspace.server';
import { EmptyState, PageHeader } from '@/components/staff-preview/shared';
import { Button } from '@/components/staff-ui/button';
import { Card, CardContent } from '@/components/staff-ui/card';
import { Briefcase } from 'lucide-react';
import { JobForm } from '../../workspace-forms';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'New job · Agora staff' };

export default async function StaffJobNewPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const gate = await requireStaffVerified();
    const { summary } = await loadStaffWorkspace();
    const canWrite = summary?.capabilities.writeJobs === true;
    const params = await searchParams;
    const requestedClient = typeof params.client === 'string' ? params.client : undefined;

    type ClientOption = { id: string; name: string; status: string };
    const clients: ClientOption[] = canWrite
        ? (await listClients(gate.pool, gate.identity, gate.organizationId, { limit: 500 }))
            .filter((client: ClientOption) => client.status === 'active')
        : [];
    let preselectedClientId = clients.some((client) => client.id === requestedClient)
        ? requestedClient
        : undefined;
    if (canWrite && !preselectedClientId && requestedClient
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestedClient)) {
        try {
            const result = await getClient(
                gate.pool, gate.identity, gate.organizationId,
                { clientId: requestedClient });
            const requested = result?.client ?? result;
            if (requested?.status === 'active' && requested?.id && requested?.name) {
                clients.push({
                    id: requested.id,
                    name: requested.name,
                    status: requested.status,
                });
                preselectedClientId = requested.id;
            }
        } catch (error) {
            if ((error as { code?: string })?.code !== 'P0002') {
                throw error;
            }
        }
    }

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
                title="New job draft"
            />
            {!canWrite ? (
                <Card>
                    <CardContent className="py-8 text-center">
                        <p className="text-sm text-muted-foreground">
                            {summary === null
                                ? 'Job creation is temporarily unavailable.'
                                : 'Creating jobs requires the jobs.write permission.'}
                        </p>
                    </CardContent>
                </Card>
            ) : clients.length === 0 ? (
                <EmptyState
                    icon={Briefcase}
                    title="Create a client first"
                    description="Jobs require an active client. Create or activate a client first."
                    action={
                        summary?.capabilities.writeClients === true ? (
                            <Button asChild>
                                <Link href="/staff/clients/new">New client</Link>
                            </Button>
                        ) : undefined
                    }
                />
            ) : (
                <Card>
                    <CardContent className="pt-6">
                        <JobForm
                            clients={clients.map((client) => ({
                                id: client.id,
                                name: client.name,
                            }))}
                            preselectedClientId={preselectedClientId}
                        />
                    </CardContent>
                </Card>
            )}
        </section>
    );
}
