import Link from 'next/link';
import { ArrowRight, Send } from 'lucide-react';
import type { IntakeResult } from './telegram-intake/intake-model';
import { listApplicationDirectory } from '@/lib/pipeline-operations';
import { listTelegramDrafts } from '@/lib/telegram-intake-operations';
import { Suspense } from 'react';
import { Card, CardContent } from '@/components/staff-ui/card';
import { PageHeader } from '@/components/staff-preview/shared';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { loadStaffCapabilities, loadStaffWorkspace } from '@/lib/workspace.server';
import { ApplicationReviewTasks, ClientsHiring, OverviewMetrics, overviewReviewLinkClass } from './overview-sections';
import { StaffTodoList } from './staff-todo-list';
import { SummaryRetry } from './summary-retry';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Overview · Agora staff' };
type SummarySection = 'metrics' | 'clients';

function OverviewLoading({ section }: { section: SummarySection | 'tasks' }) {
    const label = { metrics: 'overview', clients: 'hiring clients', tasks: 'tasks' }[section];
    return (
        <div role="status" aria-busy="true" aria-label={`Loading ${label}`} className="staff-loading-reveal">
            <span className="sr-only">Loading {label}…</span>
            {section === 'metrics' ? (
                <div aria-hidden="true" className="grid gap-4 motion-safe:animate-pulse sm:grid-cols-3">
                    {[0, 1, 2].map((item) => (
                        <div key={item} className="space-y-2 rounded-lg border border-border bg-card px-4 py-3">
                            <div className="h-4 w-24 rounded bg-secondary" />
                            <div className="h-8 w-12 rounded bg-secondary" />
                        </div>
                    ))}
                </div>
            ) : (
                <div aria-hidden="true" className={`${section === 'clients' ? 'h-80' : 'h-64'} rounded-lg border border-border bg-secondary/50 motion-safe:animate-pulse`} />
            )}
        </div>
    );
}

async function OverviewSection({ section }: { section: SummarySection }) {
    const { summary } = await loadStaffWorkspace();
    if (!summary) {
        return section === 'metrics' ? (
            <Card>
                <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
                    <p className="text-sm text-muted-foreground">Workspace summary is temporarily unavailable.</p>
                    <SummaryRetry />
                </CardContent>
            </Card>
        ) : null;
    }
    if (section === 'metrics') return <OverviewMetrics summary={summary} />;
    return <ClientsHiring summary={summary} />;
}

async function OverviewTasks() {
    const { capabilities, gate } = await loadStaffCapabilities();
    let reviewTasks = null;
    let reviewCount = 0;
    if (capabilities?.telegram && gate.stage === 'verified') {
        let inbox: IntakeResult | null = null;
        try {
            inbox = await listTelegramDrafts(gate.pool, gate.identity, gate.organizationId, { view: 'all' });
        } catch { /* The link remains available if the queue cannot be loaded. */ }
        if (inbox && inbox.counts.all > 0) {
            reviewCount = inbox.counts.all;
            reviewTasks = (
                <div aria-label="Candidate proposal tasks" className="rounded-lg border border-border p-2">
                    <Link href="/staff/telegram-intake" className={`${overviewReviewLinkClass} font-medium`}>
                        <Send className="h-4 w-4" aria-hidden="true" />
                        Review candidate proposals
                        <span className="ml-auto text-muted-foreground">{inbox.counts.all}</span>
                        <ArrowRight className="h-4 w-4" aria-hidden="true" />
                    </Link>
                    <ul className="mt-1 space-y-1">
                        {inbox.drafts.slice(0, 5).map(draft => (
                            <li key={draft.id}>
                                <Link href={`/staff/telegram-intake?draft=${draft.id}`} className={`${overviewReviewLinkClass} justify-between`}>
                                    <span className="truncate">{[draft.fields.firstName, draft.fields.lastName].filter(Boolean).join(' ') || 'Unnamed candidate'}</span>
                                    <span className="shrink-0 text-xs text-muted-foreground">{draft.existingCandidate ? 'Profile update' : 'New candidate'}</span>
                                </Link>
                            </li>
                        ))}
                    </ul>
                </div>
            );
        }
        if (!inbox) {
            reviewTasks = <Link href="/staff/telegram-intake" className="text-sm underline">Check candidate proposals</Link>;
        }
    }
    if (capabilities?.applications && gate.stage === 'verified') {
        try {
            const queue = await listApplicationDirectory(gate.pool, gate.identity, gate.organizationId, { review: 'true' });
            reviewCount += queue.total;
            reviewTasks = <>{reviewTasks}<ApplicationReviewTasks rows={queue.rows.slice(0, 5)} total={queue.total} /></>;
        } catch { /* Application queue failures must not remove manual tasks. */ }
    }
    if (capabilities?.tasks === true) {
        return <StaffTodoList writeEnabled={capabilities.writeTasks === true} reviewTasks={reviewTasks} reviewCount={reviewCount} />;
    }
    return (
        <Card id="tasks">
            <CardContent className="flex flex-col gap-3 py-8">
                {reviewTasks}
                <p className="text-sm text-muted-foreground">
                    {capabilities === null
                        ? 'Task tracking is temporarily unavailable.'
                        : 'Task tracking requires the collaboration.read permission.'}
                </p>
                {capabilities === null ? <SummaryRetry /> : null}
            </CardContent>
        </Card>
    );
}

export default async function StaffOverviewPage() {
    await requireStaffVerified();
    return (
        <section className="mx-auto flex w-full max-w-7xl flex-col gap-6">
            <PageHeader eyebrow="Workspace" title="Overview" />
            <Suspense fallback={<OverviewLoading section="metrics" />}>
                <OverviewSection section="metrics" />
            </Suspense>
            <div className="grid gap-6 lg:grid-cols-3">
                <div className="min-w-0 space-y-6 lg:col-span-2">
                    <Suspense fallback={<OverviewLoading section="tasks" />}>
                        <OverviewTasks />
                    </Suspense>
                </div>
                <Suspense fallback={<OverviewLoading section="clients" />}>
                    <OverviewSection section="clients" />
                </Suspense>
            </div>
        </section>
    );
}
