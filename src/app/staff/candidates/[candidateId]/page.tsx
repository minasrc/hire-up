import { resolveCandidateRedirect } from '@/lib/candidate-profile-read';
import { notFound, redirect } from 'next/navigation';
import { getCandidateUploadDetails } from '@/lib/candidate-upload-operations';
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
            const target = await resolveCandidateRedirect(
                gate.pool, gate.identity, gate.organizationId, candidateId);
            if (target) redirect(`/staff/candidates/${target}`);
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

    let uploadDetails = null;
    try {
        uploadDetails = await getCandidateUploadDetails(
            gate.pool, gate.identity, gate.organizationId, { candidateId });
    } catch (error) {
        // Older deployments can still display existing profiles before rollout.
        if ((error as { code?: string })?.code !== '42883') throw error;
    }

    return (
        <section className="mx-auto w-full max-w-7xl">
            <CandidateDetail
                workspace={uploadDetails ? { ...workspace, candidate: { ...workspace.candidate, secondaryEmails: uploadDetails.secondaryEmails } } : workspace}
                profileUnavailable={profileUnavailable}
            />
            {uploadDetails?.compensationPreference ? (
                <Card className="mt-6"><CardContent className="py-4">
                    <h2 className="text-sm font-medium">Compensation preference</h2>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{uploadDetails.compensationPreference}</p>
                </CardContent></Card>
            ) : null}
        </section>
    );
}
