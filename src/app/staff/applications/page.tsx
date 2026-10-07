import Link from 'next/link';

import { listApplicationDirectory } from '@/lib/recruitment-operations';
import { ClientJobContractError } from '@/lib/recruitment-contracts';
import { StaffAuthorizationError } from '@/lib/staff-authorization';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { PageHeader } from '@/components/staff-preview/shared';
import { Card, CardContent } from '@/components/staff-ui/card';
import { ApplicationsBrowser } from './applications-browser';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Applications · Agora staff' };

export default async function StaffApplicationsPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const gate = await requireStaffVerified();
    const params = await searchParams;
    const pick = (key: string) => {
        const value = params[key];
        return typeof value === 'string' ? value : undefined;
    };

    let result = null;
    let denied = false;
    let invalidFilters = false;
    try {
        result = await listApplicationDirectory(
            gate.pool, gate.identity, gate.organizationId,
            {
                query: pick('q'),
                clientId: pick('client'),
                jobId: pick('job'),
                owner: pick('owner'),
                stage: pick('stage'),
                review: pick('review'),
                dateRange: pick('range'),
                from: pick('from'),
                to: pick('to'),
                page: pick('page'),
            },
        );
    } catch (error) {
        if (error instanceof StaffAuthorizationError && error.code === 'FORBIDDEN') {
            denied = true;
        } else if (error instanceof ClientJobContractError) {
            invalidFilters = true;
        } else {
            throw error;
        }
    }

    if (invalidFilters) {
        return (
            <section className="mx-auto w-full max-w-7xl">
                <PageHeader
                    eyebrow="Workspace"
                    title="Applications"
                    description="Review candidates across your clients and open roles."
                />
                <Card className="mt-6">
                    <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
                        <p className="text-sm text-muted-foreground">
                            These filters are not valid. Clear them to see the
                            application list.
                        </p>
                        <Link
                            href="/staff/applications"
                            className="text-sm font-medium text-foreground underline underline-offset-4"
                        >
                            Clear filters
                        </Link>
                    </CardContent>
                </Card>
            </section>
        );
    }

    if (denied || !result) {
        return (
            <section className="mx-auto w-full max-w-7xl">
                <PageHeader
                    eyebrow="Workspace"
                    title="Applications"
                    description="Review candidates across your clients and open roles."
                />
                <Card className="mt-6">
                    <CardContent className="py-8 text-center">
                        <p className="text-sm text-muted-foreground">
                            Application review requires the applications.read,
                            candidates.read, jobs.read and clients.read permissions.
                        </p>
                    </CardContent>
                </Card>
            </section>
        );
    }

    const initialFilters = {
        query: pick('q') ?? '',
        clientId: pick('client') ?? 'all',
        jobId: pick('job') ?? 'all',
        owner: pick('owner') ?? 'all',
        stage: pick('stage') ?? 'all',
        review: pick('review') === '1' || pick('review') === 'true',
        dateRange: ['7d', '30d', 'custom'].includes(pick('range') ?? '')
            ? (pick('range') as '7d' | '30d' | 'custom')
            : 'all',
        from: pick('from') ?? '',
        to: pick('to') ?? '',
        page: Math.max(1, Number(pick('page')) || 1),
        view: pick('view') === 'cards' ? 'cards' : 'table',
        groupByClient: pick('group') === 'client',
    } as const;

    return (
        <section className="mx-auto w-full max-w-7xl">
            <ApplicationsBrowser
                initialResult={result}
                initialFilters={initialFilters}
            />
        </section>
    );
}
