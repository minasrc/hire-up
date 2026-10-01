import { Suspense } from 'react';
import { Card, CardContent } from '@/components/staff-ui/card';
import { PageHeader } from '@/components/staff-preview/shared';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { loadStaffWorkspace } from '@/lib/workspace.server';
import { ClientsHiring, OverviewMetrics, ReviewQueue } from './overview-sections';
import { StaffTodoList } from './staff-todo-list';
import { SummaryRetry } from './summary-retry';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Overview · Agora staff' };

function OverviewLoading() {
    return (
        <div role="status" aria-busy="true" aria-label="Loading overview" className="staff-loading-reveal space-y-6">
            <span className="sr-only">Loading overview…</span>
            <div aria-hidden="true" className="grid gap-4 motion-safe:animate-pulse sm:grid-cols-3">
                {[0, 1, 2].map((item) => (
                    <div key={item} className="space-y-2 rounded-lg border border-border bg-card px-4 py-3">
                        <div className="h-4 w-24 rounded bg-secondary" />
                        <div className="h-8 w-12 rounded bg-secondary" />
                    </div>
                ))}
            </div>
            <div aria-hidden="true" className="grid gap-6 motion-safe:animate-pulse lg:grid-cols-3">
                <div className="space-y-6 lg:col-span-2">
                    <div className="h-64 rounded-lg border border-border bg-secondary/50" />
                    <div className="h-64 rounded-lg border border-border bg-secondary/50" />
                </div>
                <div className="h-80 rounded-lg border border-border bg-secondary/50" />
            </div>
        </div>
    );
}

async function OverviewContent() {
    const { summary } = await loadStaffWorkspace();

    if (!summary) {
        return (
            <section className="mx-auto flex w-full max-w-7xl flex-col gap-6">
                <Card>
                    <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
                        <p className="text-sm text-muted-foreground">
                            Workspace summary is temporarily unavailable.
                        </p>
                        <SummaryRetry />
                    </CardContent>
                </Card>
            </section>
        );
    }

    return (
        <section className="mx-auto flex w-full max-w-7xl flex-col gap-6">
            <OverviewMetrics summary={summary} />
            <div className="grid gap-6 lg:grid-cols-3">
                <div className="space-y-6 lg:col-span-2">
                    {summary.capabilities.tasks ? (
                        <StaffTodoList writeEnabled={summary.capabilities.writeTasks} />
                    ) : (
                        <Card id="tasks">
                            <CardContent className="py-8 text-center">
                                <p className="text-sm text-muted-foreground">
                                    Task tracking requires the collaboration.read permission.
                                </p>
                            </CardContent>
                        </Card>
                    )}
                    <ReviewQueue summary={summary} />
                </div>
                <ClientsHiring summary={summary} />
            </div>
        </section>
    );
}

export default async function StaffOverviewPage() {
    await requireStaffVerified();
    return (
        <section className="mx-auto flex w-full max-w-7xl flex-col gap-6">
            <PageHeader
                eyebrow="Workspace"
                title="Overview"
            />
            <Suspense fallback={<OverviewLoading />}>
                <OverviewContent />
            </Suspense>
        </section>
    );
}
