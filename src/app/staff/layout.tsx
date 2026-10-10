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
            <main className="staff-scope min-h-screen bg-background font-sans text-sm text-foreground antialiased">
                {children}
            </main>
        );
    }

    return (
        <StaffSessionProvider scope={`${gate.organizationId}:${gate.principal.user_id}`}>
            <div className="staff-scope min-h-screen bg-background font-sans text-sm text-foreground antialiased">
                <AuthRecoveryNotice />
                <StaffShell
                    userName={gate.session?.user?.name ?? gate.session?.user?.email ?? 'Staff'}
                    userEmail={gate.session?.user?.email ?? ''}
                    initialCapabilities={capabilities}
                    summaryContent={<Suspense fallback={null}><StaffShellSummary /></Suspense>}
                >
                    {children}
                </StaffShell>
            </div>
        </StaffSessionProvider>
    );
}
