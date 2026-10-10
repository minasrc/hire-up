'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { SOCIAL_PLATFORM_NAMES } from '@/lib/client-job-contracts';
import type { StaffWorkspaceCapabilities } from '@/lib/workspace-types';
import { FieldLabel, PageHeader, StatusBadge } from '@/components/staff-preview/shared';
import { Button } from '@/components/staff-ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/staff-ui/card';
import { ClientForm, type SavedClient } from '../../workspace-forms';

export function ClientDetail({ initialClient, capabilities }: {
    initialClient: SavedClient;
    capabilities: StaffWorkspaceCapabilities | null;
}) {
    const [client, setClient] = useState(initialClient);
    const [seenInitial, setSeenInitial] = useState(initialClient);
    if (seenInitial !== initialClient) {
        setSeenInitial(initialClient);
        if (initialClient.id !== client.id || BigInt(initialClient.version) >= BigInt(client.version)) {
            setClient(initialClient);
        }
    }
    const onSaved = (saved: SavedClient) => setClient(current =>
        saved.id === current.id && BigInt(saved.version) >= BigInt(current.version) ? saved : current);
    const canWrite = capabilities?.writeClients === true;
    const canReadJobs = capabilities?.jobs === true;
    const canWriteJobs = capabilities?.writeJobs === true;
    const canReadApplications = capabilities?.applications === true;

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
                        <ClientForm clientId={client.id} initial={client} onSaved={onSaved} />
                    ) : (
                        <p className="py-4 text-center text-sm text-muted-foreground">
                            {capabilities === null
                                ? 'Editing is temporarily unavailable.'
                                : 'Editing this client requires the clients.write permission.'}
                        </p>
                    )}
                </CardContent>
            </Card>
        </section>
    );
}
