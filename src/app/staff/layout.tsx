import { loadStaffWorkspace } from '@/lib/workspace.server';
import { AuthRecoveryNotice } from './auth-recovery-notice';
import { StaffShell } from './staff-shell';

export const metadata = {
    title: 'Agora Staff',
};

// Every staff route renders inside the token scope. Verified members get the
// workspace chrome (sidebar, header, notifications); sign-in/no-access/MFA
// stages render bare so pre-access pages never show navigation.
export default async function StaffLayout({ children }: { children: React.ReactNode }) {
    const { gate, summary } = await loadStaffWorkspace();
    if (gate.stage !== 'verified') {
        return (
            <div className="staff-scope min-h-screen bg-background font-sans text-sm text-foreground antialiased">
                {children}
            </div>
        );
    }

    return (
        <div className="staff-scope min-h-screen bg-background font-sans text-sm text-foreground antialiased">
            <AuthRecoveryNotice />
            <StaffShell
                userName={gate.session?.user?.name ?? gate.session?.user?.email ?? 'Staff'}
                userEmail={gate.session?.user?.email ?? ''}
                initialSummary={summary}
            >
                {children}
            </StaffShell>
        </div>
    );
}
