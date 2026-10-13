import { WorkspaceBoundary } from './workspace-boundary';
import { multiWorkspaceEnabled } from '@/lib/staff-workspace-context.server';
import { Suspense } from 'react';
import { loadStaffCapabilities, loadStaffNotifications } from '@/lib/workspace.server';
import { AuthRecoveryNotice } from './auth-recovery-notice';
import { StaffSessionProvider } from './session-provider';
import { StaffShell } from './staff-shell';
import { StaffShellSummarySeed } from './staff-shell-summary';

async function StaffShellSummary() {
    const { summary } = await loadStaffNotifications();
    return <StaffShellSummarySeed summary={summary} />;
}

export const metadata = {
    title: 'Agora Staff',
};

// Every staff route renders inside the token scope. Verified members get the
// workspace chrome (sidebar, header, notifications); sign-in/no-access/MFA
// stages render bare so pre-access pages never show navigation.
export default async function StaffLayout({ children }: { children: React.ReactNode }) {
    const { gate, capabilities } = await loadStaffCapabilities();
    if (gate.stage !== 'verified') {
        return (
            <WorkspaceBoundary multiWorkspace={multiWorkspaceEnabled()} organizationId={'organizationId' in gate ? gate.organizationId : undefined} key={'organizationId' in gate ? gate.organizationId : 'no-workspace'}>
                {'organizationId' in gate && <meta name="staff-workspace-id" content={gate.organizationId} data-multi-workspace={multiWorkspaceEnabled() ? '1' : '0'} />}
                <main className="staff-scope min-h-screen bg-background font-sans text-sm text-foreground antialiased">
                    {children}
                </main>
            </WorkspaceBoundary>
        );
    }

    return (
        <WorkspaceBoundary multiWorkspace={multiWorkspaceEnabled()} organizationId={gate.organizationId} key={gate.organizationId}>
            <meta name="staff-workspace-id" content={gate.organizationId} data-multi-workspace={multiWorkspaceEnabled() ? '1' : '0'} />
            <StaffSessionProvider
                key={`${gate.organizationId}:${gate.principal.user_id}`}
                scope={`${gate.organizationId}:${gate.principal.user_id}`}
                userId={gate.principal.user_id}
                timeZone={gate.principal.time_zone ?? null}
                timeZoneVersion={gate.principal.time_zone_version ?? '0'}
            >
                <div className="staff-scope min-h-screen bg-background font-sans text-sm text-foreground antialiased">
                    <AuthRecoveryNotice />
                    <StaffShell
                        workspaceName={gate.principal.workspace_name ?? 'Agora'}
                        multiWorkspace={multiWorkspaceEnabled()}
                        userName={gate.session?.user?.name ?? gate.session?.user?.email ?? 'Staff'}
                        userEmail={gate.session?.user?.email ?? ''}
                        initialCapabilities={capabilities}
                        summaryContent={<Suspense fallback={null}><StaffShellSummary /></Suspense>}
                    >
                        {children}
                    </StaffShell>
                </div>
            </StaffSessionProvider>
        </WorkspaceBoundary>
    );
}
