import { notFound } from 'next/navigation';
import { getClient } from '@/lib/client-job-operations';
import { StaffAuthorizationError } from '@/lib/staff-authorization';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { loadStaffCapabilities } from '@/lib/workspace.server';
import { PageHeader } from '@/components/staff-preview/shared';
import { Card, CardContent } from '@/components/staff-ui/card';
import { ClientDetail } from './client-detail';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Client · Agora staff' };

export default async function StaffClientPage(
    { params }: { params: Promise<{ clientId: string }> },
) {
    const gate = await requireStaffVerified();
    const { clientId } = await params;

    let client = null;
    let forbidden = false;
    try {
        const result = await getClient(
            gate.pool, gate.identity, gate.organizationId, { clientId });
        client = result?.client ?? result;
    } catch (error) {
        if (error instanceof StaffAuthorizationError && error.code === 'FORBIDDEN') {
            forbidden = true;
        } else if ((error as { code?: string })?.code === 'P0002') {
            notFound();
        } else {
            throw error;
        }
    }
    if (forbidden) {
        return (
            <section className="mx-auto w-full max-w-5xl">
                <PageHeader
                    eyebrow="Clients"
                    title="Client"
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
    if (!client) {
        notFound();
    }

    const { capabilities } = await loadStaffCapabilities();
    return <ClientDetail key={client.id} initialClient={client} capabilities={capabilities} />;
}
