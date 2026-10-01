import {
    getCandidateProfileOptions,
    isMissingProfileFunctionError,
    listCandidateProfiles,
} from '@/lib/candidate-profile-operations';
import { listCandidates } from '@/lib/pipeline-operations';
import { StaffAuthorizationError } from '@/lib/staff-authorization';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { PageHeader } from '@/components/staff-preview/shared';
import { Card, CardContent } from '@/components/staff-ui/card';
import { CandidatesBrowser, type CandidateRow } from './candidates-browser';
import type { CandidateProfileOptions } from './candidate-profile-dialog';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Candidates · Agora staff' };

const LIST_LIMIT = 500;

const unavailableOptions: CandidateProfileOptions = {
    currentMembershipId: '',
    canWrite: false,
    owners: [],
};

export default async function StaffCandidatesPage() {
    const gate = await requireStaffVerified();
    let candidates: CandidateRow[] | null = null;
    let profileOptions: CandidateProfileOptions | null = null;
    let profileUnavailable = false;
    try {
        const result = await listCandidateProfiles(
            gate.pool, gate.identity, gate.organizationId,
            { limit: LIST_LIMIT });
        candidates = result?.candidates ?? [];
        profileOptions = await getCandidateProfileOptions(
            gate.pool, gate.identity, gate.organizationId);
    } catch (error) {
        if (isMissingProfileFunctionError(error)) {
            profileUnavailable = true;
            try {
                const fallback = await listCandidates(
                    gate.pool, gate.identity, gate.organizationId,
                    { limit: LIST_LIMIT });
                candidates = fallback?.candidates ?? [];
                profileOptions = unavailableOptions;
            } catch (fallbackError) {
                if (!(fallbackError instanceof StaffAuthorizationError
                    && fallbackError.code === 'FORBIDDEN')) {
                    throw fallbackError;
                }
                candidates = null;
                profileOptions = null;
            }
        } else if (error instanceof StaffAuthorizationError
            && error.code === 'FORBIDDEN') {
            candidates = null;
            profileOptions = null;
        } else {
            throw error;
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
                    capped={candidates.length >= LIST_LIMIT}
                    canReviewDuplicates={profileOptions?.canReviewDuplicates === true}
                    profileOptions={profileOptions}
                    profileUnavailable={profileUnavailable}
                />
            )}
        </section>
    );
}
