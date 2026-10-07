import { notFound } from 'next/navigation';
import { getCandidateWorkspace } from '@/lib/recruitment-operations';
import { StaffAuthorizationError } from '@/lib/staff-authorization';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { PageHeader } from '@/components/staff-preview/shared';
import { Card, CardContent } from '@/components/staff-ui/card';
import { CandidateDetail, RestrictedCandidateNotice } from './candidate-detail';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Candidate · Agora staff' };

export default async function StaffCandidatePage({
    params,
}: {
    params: Promise<{ candidateId: string }>;
}) {
    const gate = await requireStaffVerified();
    const { candidateId } = await params;
    let workspace = null;
    try {
        workspace = await getCandidateWorkspace(
            gate.pool, gate.identity, gate.organizationId, candidateId);
    } catch (error) {
        if (error instanceof StaffAuthorizationError && error.code === 'FORBIDDEN') {
            return (
                <section className="mx-auto w-full max-w-5xl">
                    <PageHeader
                        eyebrow="Workspace"
                        title="Candidate"
                        description="Profile, applications, documents and staff notes."
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
        if ((error as { code?: string })?.code === 'P0002') {
            notFound();
        }
        throw error;
    }
    if (!workspace?.candidate) {
        notFound();
    }

    return (
        <section className="mx-auto w-full max-w-7xl">
            {workspace.candidate.lifecycle === 'restricted' ? (
                <RestrictedCandidateNotice workspace={workspace} />
            ) : (
                <CandidateDetail workspace={workspace} />
            )}
        </section>
    );
}
