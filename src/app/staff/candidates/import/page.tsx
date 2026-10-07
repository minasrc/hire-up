import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { getRecruitmentContext } from '@/lib/recruitment-operations';
import { StaffAuthorizationError } from '@/lib/staff-authorization';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { PageHeader } from '@/components/staff-preview/shared';
import { Card, CardContent } from '@/components/staff-ui/card';
import { ImportWizard } from './import-wizard';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Import candidates · Agora staff' };

export default async function StaffCandidateImportPage() {
    const gate = await requireStaffVerified();
    let context = null;
    try {
        context = await getRecruitmentContext(
            gate.pool, gate.identity, gate.organizationId);
    } catch (error) {
        if (!(error instanceof StaffAuthorizationError)) throw error;
    }

    const canWrite = context?.capabilities?.writeCandidates === true;

    return (
        <section className="mx-auto flex w-full max-w-4xl flex-col gap-6">
            <Link
                href="/staff/candidates"
                className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground"
            >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                Back to candidates
            </Link>
            <PageHeader
                eyebrow="Candidates"
                title="Import CSV"
                description="Upload a CSV of candidates, map its columns and review each row before importing."
            />
            {context === null || !canWrite ? (
                <Card>
                    <CardContent className="py-8 text-center">
                        <p className="text-sm text-muted-foreground">
                            {context === null
                                ? 'Import is temporarily unavailable.'
                                : 'Importing candidates requires the candidates.write permission.'}
                        </p>
                    </CardContent>
                </Card>
            ) : (
                <ImportWizard context={context} />
            )}
        </section>
    );
}
