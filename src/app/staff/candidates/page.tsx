import Link from 'next/link';

import {
    getRecruitmentContext,
    listCandidateDirectory,
} from '@/lib/recruitment-operations';
import { ClientJobContractError } from '@/lib/recruitment-contracts';
import { StaffAuthorizationError } from '@/lib/staff-authorization';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { PageHeader } from '@/components/staff-preview/shared';
import { Card, CardContent } from '@/components/staff-ui/card';
import { CandidatesBrowser } from './candidates-browser';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Candidates · Agora staff' };

export default async function StaffCandidatesPage({
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

    let context = null;
    let result = null;
    let denied = false;
    let invalidFilters = false;
    try {
        context = await getRecruitmentContext(gate.pool, gate.identity, gate.organizationId);
        if (!context?.capabilities?.readCandidates) {
            denied = true;
        } else {
            result = await listCandidateDirectory(
                gate.pool, gate.identity, gate.organizationId,
                {
                    tab: pick('tab'),
                    owner: pick('owner'),
                    tag: pick('tag'),
                    query: pick('q'),
                    page: pick('page'),
                },
            );
        }
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
                    title="Candidates"
                    description="Everyone who has applied or been added, deduplicated by email."
                />
                <Card className="mt-6">
                    <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
                        <p className="text-sm text-muted-foreground">
                            These filters are not valid. Clear them to see the
                            candidate list.
                        </p>
                        <Link
                            href="/staff/candidates"
                            className="text-sm font-medium text-foreground underline underline-offset-4"
                        >
                            Clear filters
                        </Link>
                    </CardContent>
                </Card>
            </section>
        );
    }

    if (denied || !result || !context) {
        return (
            <section className="mx-auto w-full max-w-7xl">
                <PageHeader
                    eyebrow="Workspace"
                    title="Candidates"
                    description="Everyone who has applied or been added, deduplicated by email."
                />
                <Card className="mt-6">
                    <CardContent className="py-8 text-center">
                        <p className="text-sm text-muted-foreground">
                            Candidate access requires the candidates.read permission.
                        </p>
                    </CardContent>
                </Card>
            </section>
        );
    }

    const tab = pick('tab');
    const initialFilters = {
        tab: tab === 'mine' || tab === 'recent' ? tab : 'all',
        owner: pick('owner') ?? 'all',
        tag: pick('tag') ?? 'all',
        query: pick('q') ?? '',
    } as const;

    return (
        <section className="mx-auto w-full max-w-7xl">
            <CandidatesBrowser
                context={context}
                initialResult={result}
                initialFilters={initialFilters}
            />
        </section>
    );
}
