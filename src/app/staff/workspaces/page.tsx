import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth-options';
import { staffIdentityFromSession, staffInviteEmailFromSession } from '@/lib/staff-identity';
import { staffGoogleCredentialStatus } from '@/lib/staff-google.server';
import { getStaffPool } from '@/lib/staff-db.server';
import { multiWorkspaceEnabled } from '@/lib/staff-workspace-context.server';
import { listStaffWorkspaces } from '@/lib/staff-workspace-directory';
import { staffGate } from '@/lib/staff-gate.server';
import { staffWorkspaceProvisioningStatus } from '@/lib/staff-workspace-operations';
import { WorkspaceCreate } from './workspace-create';
import { StaffSignOutButton } from '../staff-auth-buttons';
import { WorkspaceChooser, type WorkspaceChoice } from './workspace-chooser';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Choose workspace' };

export default async function WorkspacesPage() {
    if (!multiWorkspaceEnabled()) redirect('/staff');
    const session = await getServerSession(authOptions);
    const identity = staffIdentityFromSession(session);
    if (!identity || await staffGoogleCredentialStatus(identity.subject) === 'revoked') redirect('/staff/sign-in');
    const pool = getStaffPool();
    if (!pool) redirect('/staff/unavailable');
    let workspaces: WorkspaceChoice[];
    try { workspaces = await listStaffWorkspaces(pool, identity, staffInviteEmailFromSession(session)); }
    catch { redirect('/staff/unavailable'); }
    const gate = await staffGate();
    let provisioning = null;
    if (gate.stage === 'verified') {
        try { provisioning = await staffWorkspaceProvisioningStatus(pool, identity, gate.organizationId); }
        catch { /* The directory remains usable if provisioning is unavailable. */ }
    }
    return <section className="mx-auto max-w-2xl space-y-6 px-6 py-12">
        <div className="space-y-2">
            <h1 className="text-2xl font-semibold">Choose your workspace</h1>
            <p className="text-muted-foreground">Signed in as {session?.user?.email}. Each workspace keeps its members and imported conversations separate.</p>
        </div>
        <WorkspaceChooser initialWorkspaces={workspaces} />
        {provisioning?.canCreate && <WorkspaceCreate initialCreated={provisioning.created ?? []} />}
        <StaffSignOutButton />
    </section>;
}
