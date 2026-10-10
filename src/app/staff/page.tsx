import { Suspense } from 'react';
import { Card, CardContent } from '@/components/staff-ui/card';
import { PageHeader } from '@/components/staff-preview/shared';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { loadStaffCapabilities, loadStaffWorkspace } from '@/lib/workspace.server';
import { ClientsHiring, OverviewMetrics, ReviewQueue } from './overview-sections';
import { StaffTodoList } from './staff-todo-list';
import { SummaryRetry } from './summary-retry';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Overview · Agora staff' };
type SummarySection = 'metrics' | 'review' | 'clients';

function OverviewLoading({ section }: { section: SummarySection | 'tasks' }) {
    const label = { metrics: 'overview', review: 'review queue', clients: 'hiring clients', tasks: 'tasks' }[section];
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
    if (section === 'review') return <ReviewQueue summary={summary} />;
    return <ClientsHiring summary={summary} />;
}

async function OverviewTasks() {
    const { capabilities } = await loadStaffCapabilities();
    if (capabilities?.tasks === true) {
        return <StaffTodoList writeEnabled={capabilities.writeTasks === true} />;
    }
    return (
        <Card id="tasks">
            <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
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
                <div className="space-y-6 lg:col-span-2">
                    <Suspense fallback={<OverviewLoading section="tasks" />}>
                        <OverviewTasks />
                    </Suspense>
                    <Suspense fallback={<OverviewLoading section="review" />}>
                        <OverviewSection section="review" />
                    </Suspense>
                </div>
                <Suspense fallback={<OverviewLoading section="clients" />}>
                    <OverviewSection section="clients" />
                </Suspense>
            </div>
        </section>
    );
}
