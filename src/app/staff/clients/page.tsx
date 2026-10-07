import { listClients } from '@/lib/client-job-operations';
import { StaffAuthorizationError } from '@/lib/staff-authorization';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { loadStaffWorkspace } from '@/lib/workspace.server';
import { PageHeader } from '@/components/staff-preview/shared';
import { Card, CardContent } from '@/components/staff-ui/card';
import { ClientsBrowser, type ClientRow } from './clients-browser';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Clients · Agora staff' };

const LIST_LIMIT = 500;

export default async function StaffClientsPage() {
    const gate = await requireStaffVerified();
    const clientsPromise: Promise<ClientRow[] | null> = listClients(
        gate.pool, gate.identity, gate.organizationId, { limit: LIST_LIMIT },
    ).catch((error: unknown) => {
        if (error instanceof StaffAuthorizationError && error.code === 'FORBIDDEN') {
            return null;
        }
        throw error;
    });
    // Both reads authorize independently; keep concurrency bounded to two.
    const [{ summary }, clients] = await Promise.all([
        loadStaffWorkspace(),
        clientsPromise,
    ]);

    if (clients === null) {
        return (
            <section className="mx-auto w-full max-w-7xl">
                <PageHeader
                    eyebrow="Workspace"
                    title="Clients"
                    description="Your client relationships and hiring activity."
                />
                <Card className="mt-6">
                    <CardContent className="py-8 text-center">
                        <p className="text-sm text-muted-foreground">
                            Client access requires the clients.read permission.
                        </p>
                    </CardContent>
                </Card>
            </section>
        );
    }

    return (
        <section className="mx-auto w-full max-w-7xl">
            <ClientsBrowser
                clients={clients}
                canCreate={summary?.capabilities.writeClients === true}
                canReadJobs={summary?.capabilities.jobs === true}
                canReadApplications={summary?.capabilities.applications === true}
                capped={clients.length >= LIST_LIMIT}
            />
        </section>
    );
}
