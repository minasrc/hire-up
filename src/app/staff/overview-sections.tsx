import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowRight, Building2, Inbox, Lock } from 'lucide-react';

import { Badge } from '@/components/staff-ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/staff-ui/card';
import type { StaffWorkspaceRecentApplication, StaffWorkspaceSummary } from '@/lib/workspace-types';
import { cn } from '@/lib/utils';

function MetricCard({
    label,
    value,
    href,
}: {
    label: string;
    value: number | null;
    href: string;
}) {
    const inner = (
        <>
            <span className="text-sm text-muted-foreground">{label}</span>
            <span className="text-[26px] leading-8 font-semibold text-foreground">
                {value === null ? 'Restricted' : value}
            </span>
        </>
    );
    if (value === null) {
        return (
            <Card className="flex flex-col gap-0.5 px-4 py-3 text-left opacity-80">
                <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                    {label}
                </span>
                <span className="text-[26px] leading-8 font-semibold text-muted-foreground">
                    Restricted
                </span>
            </Card>
        );
    }
    return (
        <Link
            href={href}
            className="flex flex-col gap-0.5 rounded-lg border border-border bg-card px-4 py-3 outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
        >
            {inner}
        </Link>
    );
}

export function OverviewMetrics({ summary }: { summary: StaffWorkspaceSummary }) {
    return (
        <div className="grid gap-4 sm:grid-cols-3">
            <MetricCard
                label="Candidates"
                value={summary.metrics.candidates}
                href="/staff/candidates"
            />
            <MetricCard
                label="Applications"
                value={summary.metrics.applications}
                href="/staff/applications"
            />
            <MetricCard
                label="Open roles"
                value={summary.metrics.openRoles}
                href="/staff/jobs?state=published&intake=open"
            />
        </div>
    );
}

function PermissionNote({ permission }: { permission: string }) {
    return (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Lock className="h-4 w-4" aria-hidden="true" />
            Requires the {permission} permission.
        </p>
    );
}

export const overviewReviewLinkClass = 'flex items-center gap-3 rounded-md px-3 py-2 text-sm outline-none transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:ring-2 focus-visible:ring-ring';

export function ApplicationReviewTasks({ rows, total }: { rows: StaffWorkspaceRecentApplication[]; total: number }) {
    if (total === 0) return null;
    return (
        <div aria-label="Application review tasks" className="rounded-lg border border-border p-2">
            <Link href="/staff/applications?review=1" className={`${overviewReviewLinkClass} font-medium`}>
                <Inbox className="h-4 w-4" aria-hidden="true" />
                Application reviews
                <span className="ml-auto text-muted-foreground">{total}</span>
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
            <ul className="mt-1 space-y-1">
                {rows.map(row => (
                    <li key={row.applicationId}>
                        <Link href={`/staff/candidates/${row.candidateId}`} className={overviewReviewLinkClass}>
                            <span className="flex min-w-0 flex-col">
                                <span className="truncate">{row.candidateName}</span>
                                <span className="truncate text-xs text-muted-foreground">{row.jobTitle} · {row.clientName}</span>
                            </span>
                            <span className="ml-auto shrink-0 text-xs text-muted-foreground">Application</span>
                        </Link>
                    </li>
                ))}
            </ul>
        </div>
    );
}

export function ClientsHiring({ summary }: { summary: StaffWorkspaceSummary }) {
    const rows = summary.clientsHiring;
    const total = summary.clientsHiringTotal;
    return (
        <Card className="h-fit">
            <CardHeader className="gap-1">
                <CardTitle className="flex items-center gap-2 text-base">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-secondary">
                        <Building2
                            className="h-3.5 w-3.5 text-secondary-foreground"
                            aria-hidden="true"
                        />
                    </span>
                    Clients hiring
                </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
                {!summary.capabilities.jobs ? (
                    <PermissionNote permission="jobs.read" />
                ) : rows.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                        No published open roles yet.
                    </p>
                ) : (
                    <ul className="flex flex-col gap-2">
                        {rows.map((row) => (
                            <li
                                key={row.clientId}
                                className="flex flex-col items-start gap-2 rounded-lg border border-border px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                            >
                                <div className="flex min-w-0 flex-col">
                                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                                        <Link
                                            href={`/staff/clients/${row.clientId}`}
                                            className="min-w-0 truncate rounded-sm text-sm font-medium text-foreground outline-none hover:text-accent-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                                        >
                                            {row.name}
                                        </Link>
                                        {row.isStealth ? (
                                            <Badge variant="outline">Stealth</Badge>
                                        ) : null}
                                    </span>
                                </div>
                                <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                                    <Link
                                        href={`/staff/jobs?client=${row.clientId}&state=published&intake=open`}
                                        className="rounded-sm font-medium text-accent-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                                    >
                                        {row.openRoles} open role{row.openRoles === 1 ? '' : 's'}
                                    </Link>
                                    {row.applications === null ? (
                                        <span className="text-muted-foreground">—</span>
                                    ) : (
                                        <Link
                                            href={`/staff/applications?client=${row.clientId}`}
                                            className="rounded-sm font-medium text-accent-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                                        >
                                            {row.applications} application{row.applications === 1 ? '' : 's'}
                                        </Link>
                                    )}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
                {total !== null && total > rows.length ? (
                    <p className="text-xs text-muted-foreground">
                        Showing the top {rows.length} of {total} clients hiring.
                    </p>
                ) : null}
            </CardContent>
        </Card>
    );
}

export function WorkspaceColumn({ children }: { children: ReactNode }) {
    return <div className={cn('flex flex-col gap-6')}>{children}</div>;
}
