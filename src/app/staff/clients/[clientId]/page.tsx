import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { getClientWorkspace } from '@/lib/recruitment-operations';
import { StaffAuthorizationError } from '@/lib/staff-authorization';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { loadStaffWorkspace } from '@/lib/workspace.server';
import { FieldLabel, PageHeader, StatusBadge } from '@/components/staff-preview/shared';
import { Badge } from '@/components/staff-ui/badge';
import { Button } from '@/components/staff-ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/staff-ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/staff-ui/table';
import { jobStatusLabel, socialPlatformLabel } from '@/lib/job-display';
import type { ApplicationCard, StaffJobCard } from '@/lib/recruitment-types';
import { ClientForm } from '../../workspace-forms';
import { RecordPreviewLink } from '../../record-previews';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Client · Agora staff' };

const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric',
    });

const countText = (value: number | null | undefined) =>
    value === null || value === undefined ? '—' : String(value);

export default async function StaffClientPage(
    { params }: { params: Promise<{ clientId: string }> },
) {
    const gate = await requireStaffVerified();
    const { clientId } = await params;

    let workspace = null;
    let forbidden = false;
    try {
        workspace = await getClientWorkspace(
            gate.pool, gate.identity, gate.organizationId, clientId);
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
                    description="Client profile, roles and applications."
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
    if (!workspace?.client) {
        notFound();
    }

    const { client, jobs, jobTotal, openRoles, applicationCount, interviewingCount, recentApplications, context } = workspace;
    const { summary } = await loadStaffWorkspace();
    const canWrite = summary?.capabilities.writeClients === true;
    const canWriteJobs = context?.capabilities?.writeJobs === true;
    const canReadApplications = context?.capabilities?.readApplications === true;

    return (
        <section className="mx-auto flex w-full max-w-6xl flex-col gap-6">
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
                description="Client profile, roles and applications."
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

            <div className="grid grid-cols-3 gap-3">
                {[
                    {
                        label: 'Open roles',
                        value: openRoles,
                        href: `/staff/jobs?client=${client.id}`,
                    },
                    {
                        label: 'Applications',
                        value: applicationCount,
                        href: `/staff/applications?client=${client.id}`,
                    },
                    {
                        label: 'Interviewing',
                        value: interviewingCount,
                        href: `/staff/applications?client=${client.id}&stage=interview`,
                    },
                ].map((metric) =>
                    metric.value === null || metric.value === undefined ? (
                        <div
                            key={metric.label}
                            className="flex flex-col gap-0.5 rounded-lg bg-secondary/50 px-4 py-3"
                        >
                            <span className="text-xs text-muted-foreground">
                                {metric.label}
                            </span>
                            <span className="text-xl font-semibold text-foreground">
                                —
                            </span>
                        </div>
                    ) : (
                        <Link
                            key={metric.label}
                            href={metric.href}
                            className="flex flex-col gap-0.5 rounded-lg bg-secondary/50 px-4 py-3 outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            <span className="text-xs text-muted-foreground">
                                {metric.label}
                            </span>
                            <span className="text-xl font-semibold text-foreground">
                                {metric.value}
                            </span>
                        </Link>
                    ),
                )}
            </div>

            <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <div className="flex flex-col gap-6">
                    <Card>
                        <CardHeader>
                            <CardTitle className="text-base">Roles</CardTitle>
                            <CardDescription>
                                {jobTotal !== null && jobs.length < jobTotal
                                    ? `Showing the ${jobs.length} most recent of ${jobTotal} roles.`
                                    : 'Jobs for this client.'}
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            {jobs.length === 0 ? (
                                <p className="text-sm text-muted-foreground">
                                    {jobTotal === null
                                        ? 'The roles list requires the jobs.read permission.'
                                        : 'No roles for this client yet.'}
                                </p>
                            ) : (
                                <div className="overflow-hidden rounded-lg border border-border">
                                    <Table>
                                        <TableHeader>
                                            <TableRow>
                                                <TableHead>Role</TableHead>
                                                <TableHead className="hidden sm:table-cell">Location</TableHead>
                                                <TableHead className="w-16">Apps</TableHead>
                                                <TableHead>Status</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {jobs.map((job: StaffJobCard) => (
                                                <TableRow key={job.id}>
                                                    <TableCell>
                                                        <RecordPreviewLink
                                                            kind="job"
                                                            id={job.id}
                                                            className="rounded-sm font-medium text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                                                        >
                                                            {job.title}
                                                        </RecordPreviewLink>
                                                    </TableCell>
                                                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                                                        {(job.locations?.length ?? 0) > 0
                                                            ? job.locations.join(', ')
                                                            : '—'}
                                                    </TableCell>
                                                    <TableCell className="text-muted-foreground">
                                                        {job.applicationCount === null
                                                            || job.applicationCount === undefined ? (
                                                            '—'
                                                        ) : (
                                                            <Link
                                                                href={`/staff/applications?client=${client.id}&job=${job.id}`}
                                                                className="rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                                                            >
                                                                {job.applicationCount}
                                                            </Link>
                                                        )}
                                                    </TableCell>
                                                    <TableCell>
                                                        <StatusBadge
                                                            tone={
                                                                jobStatusLabel(job) === 'Listed'
                                                                    ? 'success'
                                                                    : jobStatusLabel(job) === 'Draft'
                                                                      ? 'secondary'
                                                                      : 'outline'
                                                            }
                                                        >
                                                            {jobStatusLabel(job)}
                                                        </StatusBadge>
                                                    </TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                </div>
                            )}
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle className="text-base">Recent applications</CardTitle>
                            <CardDescription>
                                The five most recent applications for this client.
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            {recentApplications.length === 0 ? (
                                <p className="text-sm text-muted-foreground">
                                    {applicationCount === null
                                        ? 'Recent applications require the applications.read permission.'
                                        : 'No applications for this client yet.'}
                                </p>
                            ) : (
                                <div className="overflow-hidden rounded-lg border border-border">
                                    <Table>
                                        <TableHeader>
                                            <TableRow>
                                                <TableHead>Candidate</TableHead>
                                                <TableHead>Job</TableHead>
                                                <TableHead>Stage</TableHead>
                                                <TableHead className="hidden sm:table-cell">Received</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {recentApplications.map((row: ApplicationCard) => (
                                                <TableRow key={row.applicationId}>
                                                    <TableCell>
                                                        <RecordPreviewLink
                                                            kind="candidate"
                                                            id={row.candidateId}
                                                            className="rounded-sm font-medium text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                                                        >
                                                            {row.candidateName ?? 'Unnamed'}
                                                        </RecordPreviewLink>
                                                    </TableCell>
                                                    <TableCell className="text-muted-foreground">
                                                        {row.jobTitle}
                                                    </TableCell>
                                                    <TableCell>
                                                        <Badge variant="secondary">
                                                            {row.stageLabel}
                                                        </Badge>
                                                    </TableCell>
                                                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                                                        {formatDate(row.receivedAt)}
                                                    </TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </div>

                <div className="flex flex-col gap-6">
                    <Card>
                        <CardHeader>
                            <CardTitle className="text-base">Client details</CardTitle>
                            <CardDescription>
                                Contact details and how this client appears publicly.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="flex flex-col gap-4">
                            <dl className="grid gap-4">
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
                                            className="break-all underline underline-offset-4 hover:opacity-70"
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
                                        <ul className="flex flex-col gap-0.5">
                                            {client.socialLinks.map((link) => (
                                                <li key={`${link.platform}:${link.url}`}>
                                                    <a
                                                        href={link.url}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                        className="w-fit break-all rounded-sm text-xs font-medium text-accent-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                                                    >
                                                        {socialPlatformLabel(link.platform)}
                                                        {' · '}
                                                        {link.url}
                                                    </a>
                                                </li>
                                            ))}
                                        </ul>
                                    ) : (
                                        '—'
                                    )}
                                </FieldLabel>
                            </dl>
                            {client.isStealth && client.anonymousDescription ? (
                                <div className="rounded-lg bg-secondary/50 px-3 py-2">
                                    <p className="text-xs font-medium text-muted-foreground">
                                        Public description
                                    </p>
                                    <p className="mt-1 text-sm text-foreground">
                                        {client.anonymousDescription}
                                    </p>
                                </div>
                            ) : null}
                        </CardContent>
                    </Card>
                </div>
            </div>

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
