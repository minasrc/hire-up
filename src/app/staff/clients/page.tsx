import { listClientDirectory } from '@/lib/client-job-operations';
import { StaffAuthorizationError } from '@/lib/staff-authorization';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { loadStaffCapabilities } from '@/lib/workspace.server';
import { PageHeader } from '@/components/staff-preview/shared';
import { Card, CardContent } from '@/components/staff-ui/card';
import { ClientsBrowser, type ClientRow } from './clients-browser';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Clients · Agora staff' };

type Directory = {
    rows: ClientRow[];
    total: number;
    page: number;
    pageSize: number;
};


export default async function StaffClientsPage({
    searchParams,
}: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
    const gate = await requireStaffVerified();
    const directoryPromise: Promise<Directory | null> = listClientDirectory(
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
                    title="Clients"
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
                clients={directory.rows}
                canCreate={capabilities?.writeClients === true}
                canReadJobs={capabilities?.jobs === true}
                canReadApplications={capabilities?.applications === true}
                total={directory.total}
                page={directory.page}
                pageSize={directory.pageSize}
            />
        </section>
    );
}
