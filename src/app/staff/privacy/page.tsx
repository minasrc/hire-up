import { listPrivacyCases } from '@/lib/recruitment-operations';
import { StaffAuthorizationError } from '@/lib/staff-authorization';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { PageHeader } from '@/components/staff-preview/shared';
import { Card, CardContent } from '@/components/staff-ui/card';

import { PrivacyWorkspace } from './privacy-workspace';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Data requests · Agora staff' };

export default async function StaffPrivacyPage() {
    const gate = await requireStaffVerified();

    let result = null;
    let denied = false;
    try {
        result = await listPrivacyCases(gate.pool, gate.identity, gate.organizationId);
    } catch (error) {
        if (error instanceof StaffAuthorizationError && error.code === 'FORBIDDEN') {
            denied = true;
        } else {
            throw error;
        }
    }

    return (
        <section className="mx-auto flex w-full max-w-5xl flex-col gap-6">
            <PageHeader
                eyebrow="Privacy"
                title="Data requests"
                description="Privacy cases and records with restricted staff access."
            />
            {denied || !result ? (
                <Card>
                    <CardContent className="py-8 text-center">
                        <p className="text-sm text-muted-foreground">
                            Viewing data requests requires the privacy.manage permission.
                        </p>
                    </CardContent>
                </Card>
            ) : (
                <PrivacyWorkspace result={result} />
            )}
        </section>
    );
}
