import { listTelegramDrafts } from '@/lib/telegram-intake-operations';
import { loadStaffCapabilities } from '@/lib/workspace.server';
import type { IntakeResult } from '../telegram-intake/intake-model';
import { listCandidateProfileDirectory } from '@/lib/candidate-profile-operations';
import { StaffAuthorizationError } from '@/lib/staff-authorization';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { PageHeader } from '@/components/staff-preview/shared';
import { Card, CardContent } from '@/components/staff-ui/card';
import { CandidatesBrowser, type CandidateRow } from './candidates-browser';
import type { CandidateProfileOptions } from './candidate-profile-dialog';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Candidates · Agora staff' };

export default async function StaffCandidatesPage({ searchParams }: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const gate = await requireStaffVerified();
    const params = await searchParams;
    let candidates: CandidateRow[] | null = null;
    let profileOptions: CandidateProfileOptions | null = null;
    let total = 0;
    let page = 1;
    let pageSize = 50;
    try {
        const result = await listCandidateProfileDirectory(
            gate.pool, gate.identity, gate.organizationId, params);
        candidates = result.rows;
        profileOptions = result.profileOptions;
        total = result.total;
        page = result.page;
        pageSize = result.pageSize;
    } catch (error) {
        if (!(error instanceof StaffAuthorizationError && error.code === 'FORBIDDEN')) throw error;
    }

    let pendingProposalCount = 0;
    if (candidates !== null && profileOptions?.canWrite && process.env.TELEGRAM_INTAKE_ENABLED === '1') {
        const { capabilities } = await loadStaffCapabilities();
        if (capabilities?.telegram) {
            try {
                const inbox: IntakeResult = await listTelegramDrafts(gate.pool, gate.identity, gate.organizationId, { view: 'all' });
                pendingProposalCount = inbox.counts.all;
            } catch { /* An unavailable inbox must not block the candidate directory. */ }
        }
    }

    return (
        <section className="mx-auto w-full max-w-7xl">
            {candidates === null ? (
                <>
                    <PageHeader
                        eyebrow="Workspace"
                        title="Candidates"
                    />
                    <Card className="mt-6">
                        <CardContent className="py-8 text-center">
                            <p className="text-sm text-muted-foreground">
                                Candidate access requires the candidates.read permission.
                            </p>
                        </CardContent>
                    </Card>
                </>
            ) : (
                <CandidatesBrowser
                    candidates={candidates}
                    semanticSearchEnabled={process.env.TELEGRAM_INTAKE_ENABLED === '1'}
                    pendingProposalCount={pendingProposalCount}
                    total={total}
                    page={page}
                    pageSize={pageSize}
                    canReviewDuplicates={profileOptions?.canReviewDuplicates === true}
                    profileOptions={profileOptions}
                />
            )}
        </section>
    );
}
