import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { getClient } from '@/lib/client-job-operations';
import { SOCIAL_PLATFORM_NAMES } from '@/lib/client-job-contracts';
import { StaffAuthorizationError } from '@/lib/staff-authorization';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { loadStaffWorkspace } from '@/lib/workspace.server';
import { FieldLabel, PageHeader, StatusBadge } from '@/components/staff-preview/shared';
import { Button } from '@/components/staff-ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/staff-ui/card';
import { ClientForm } from '../../workspace-forms';

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

    const { summary } = await loadStaffWorkspace();
    const canWrite = summary?.capabilities.writeClients === true;
    const canReadJobs = summary?.capabilities.jobs === true;
    const canWriteJobs = summary?.capabilities.writeJobs === true;
    const canReadApplications = summary?.capabilities.applications === true;

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
                title={client.name}
                actions={
                    <>
                        <StatusBadge
                            tone={client.status === 'active' ? 'success' : 'secondary'}
                        >
                            {client.status}
                        </StatusBadge>
                        {client.isStealth ? (
                            <StatusBadge tone="warning">Stealth</StatusBadge>
                        ) : null}
                        {canReadJobs ? (
                            <Button variant="outline" size="sm" asChild>
                                <Link href={`/staff/jobs?client=${client.id}`}>
                                    View jobs
                                </Link>
                            </Button>
                        ) : null}
                        {client.status === 'active' && canWriteJobs ? (
                            <Button variant="outline" size="sm" asChild>
                                <Link href={`/staff/jobs/new?client=${client.id}`}>
                                    Add job
                                </Link>
                            </Button>
                        ) : null}
                        {canReadApplications ? (
                            <Button variant="outline" size="sm" asChild>
                                <Link href={`/staff/applications?client=${client.id}`}>
                                    View applications
                                </Link>
                            </Button>
                        ) : null}
                    </>
                }
            />

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Summary</CardTitle>
                </CardHeader>
                <CardContent>
                    <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        <FieldLabel label="Contact name">
                            {client.contactName ?? '—'}
                        </FieldLabel>
                        <FieldLabel label="Contact email">
                            {client.contactEmail ?? '—'}
                        </FieldLabel>
                        <FieldLabel label="Telegram">
                            {client.telegramUsername
                                ? `@${client.telegramUsername}`
                                : '—'}
                        </FieldLabel>
                        <FieldLabel label="Website">
                            {client.website ? (
                                <a
                                    href={client.website}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="underline underline-offset-4 hover:opacity-70"
                                >
                                    {client.website}
                                </a>
                            ) : (
                                '—'
                            )}
                        </FieldLabel>
                        <FieldLabel label="Visibility">
                            {client.isStealth ? 'Stealth (identity hidden)' : 'Named'}
                        </FieldLabel>
                        <FieldLabel label="Social links">
                            {client.socialLinks?.length ? (
                                <ul aria-label="Client social links" className="flex flex-col gap-1">
                                    {client.socialLinks.map((link: { platform: string; url: string }) => (
                                        <li key={`${link.platform}:${link.url}`}>
                                            <a
                                                href={link.url}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="break-all underline underline-offset-4 hover:opacity-70"
                                            >
                                                {SOCIAL_PLATFORM_NAMES[
                                                    link.platform as keyof typeof SOCIAL_PLATFORM_NAMES
                                                ] ?? link.platform}
                                                {' · '}
                                                {link.url}
                                            </a>
                                        </li>
                                    ))}
                                </ul>
                            ) : '—'}
                        </FieldLabel>
                    </dl>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Edit client</CardTitle>
                    <CardDescription>
                        Changes to the public profile require a job re-review before
                        listings reflect them.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {canWrite ? (
                        <ClientForm clientId={client.id} initial={client} />
                    ) : (
                        <p className="py-4 text-center text-sm text-muted-foreground">
                            {summary === null
                                ? 'Editing is temporarily unavailable.'
                                : 'Editing this client requires the clients.write permission.'}
                        </p>
                    )}
                </CardContent>
            </Card>
        </section>
    );
}
