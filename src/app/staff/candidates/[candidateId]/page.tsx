import { notFound } from 'next/navigation';
import {
    getCandidateProfile,
    isMissingProfileFunctionError,
} from '@/lib/candidate-profile-operations';
import { getCandidateWorkspace } from '@/lib/pipeline-operations';
import { StaffAuthorizationError } from '@/lib/staff-authorization';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { PageHeader } from '@/components/staff-preview/shared';
import { Card, CardContent } from '@/components/staff-ui/card';
import { CandidateDetail } from './candidate-detail';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Candidate · Agora staff' };

const denied = (
    <section className="mx-auto w-full max-w-5xl">
        <PageHeader
            eyebrow="Workspace"
            title="Candidate"
            description="Applications, documents and staff notes."
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

export default async function StaffCandidatePage({
    params,
}: {
    params: Promise<{ candidateId: string }>;
}) {
    const gate = await requireStaffVerified();
    const { candidateId } = await params;
    let workspace = null;
    let profileUnavailable = false;
    try {
        workspace = await getCandidateProfile(
            gate.pool, gate.identity, gate.organizationId, { candidateId });
    } catch (error) {
        if (error instanceof StaffAuthorizationError && error.code === 'FORBIDDEN') {
            return denied;
        }
        if ((error as { code?: string })?.code === 'P0002') {
            notFound();
        }
        if (!isMissingProfileFunctionError(error)) {
            throw error;
        }
        profileUnavailable = true;
        try {
            workspace = await getCandidateWorkspace(
                gate.pool, gate.identity, gate.organizationId, { candidateId });
        } catch (fallbackError) {
            if ((fallbackError as { code?: string })?.code === 'P0002') {
                notFound();
            }
            if (fallbackError instanceof StaffAuthorizationError
                && fallbackError.code === 'FORBIDDEN') {
                return denied;
            }
            throw fallbackError;
        }
    }

    return (
        <section className="mx-auto w-full max-w-7xl">
            <CandidateDetail
                workspace={workspace}
                profileUnavailable={profileUnavailable}
            />
        </section>
    );
}
