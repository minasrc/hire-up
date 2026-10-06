import { getStaffDirectory } from '@/lib/staff-operations';
import { StaffAuthorizationError } from '@/lib/staff-authorization';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { PageHeader } from '@/components/staff-preview/shared';
import { Card, CardContent } from '@/components/staff-ui/card';
import { MembersBrowser } from './members-browser';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Members · Agora staff' };

export default async function StaffMembersPage() {
    const gate = await requireStaffVerified();
    let directory: {
        members: any[];
        roles: any[];
        inviteDomains?: string[];
    } | null = null;
    try {
        directory = await getStaffDirectory(
            gate.pool, gate.identity, gate.organizationId, { limit: 500 });
    } catch (error) {
        if (!(error instanceof StaffAuthorizationError && error.code === 'FORBIDDEN')) {
            throw error;
        }
    }

    if (!directory) {
        return (
            <section className="mx-auto w-full max-w-7xl">
                <PageHeader
                    eyebrow="Workspace"
                    title="Members"
                />
                <Card className="mt-6">
                    <CardContent className="py-8 text-center">
                        <p className="text-sm text-muted-foreground">
                            Member administration requires the staff.manage permission.
                        </p>
                    </CardContent>
                </Card>
            </section>
        );
    }

    return (
        <section className="mx-auto w-full max-w-7xl">
            <MembersBrowser
                currentMembershipId={gate.principal.membership_id}
                members={directory.members}
                roles={directory.roles}
                inviteDomains={directory.inviteDomains ?? []}
                capped={directory.members.length >= 500}
            />
        </section>
    );
}
