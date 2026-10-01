import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { loadStaffWorkspace } from '@/lib/workspace.server';
import { PageHeader } from '@/components/staff-preview/shared';
import { Card, CardContent } from '@/components/staff-ui/card';
import { ClientForm } from '../../workspace-forms';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'New client · Agora staff' };

export default async function StaffClientNewPage() {
    await requireStaffVerified();
    const { summary } = await loadStaffWorkspace();
    const canWrite = summary?.capabilities.writeClients === true;
    return (
        <section className="mx-auto flex w-full max-w-5xl flex-col gap-6">
            <Link
                href="/staff/clients"
                className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground"
            >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                Back to clients
            </Link>
            <PageHeader
                eyebrow="Clients"
                title="New client"
            />
            <Card>
                <CardContent className="pt-6">
                    {canWrite ? (
                        <ClientForm />
                    ) : (
                        <p className="py-4 text-center text-sm text-muted-foreground">
                            {summary === null
                                ? 'Client creation is temporarily unavailable.'
                                : 'Creating clients requires the clients.write permission.'}
                        </p>
                    )}
                </CardContent>
            </Card>
        </section>
    );
}
