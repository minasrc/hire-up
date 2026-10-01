import { Suspense } from 'react';
import { loadStaffCapabilities, loadStaffWorkspace } from '@/lib/workspace.server';
import { StaffShell } from './staff-shell';
import { StaffShellSummarySeed } from './staff-shell-summary';

async function StaffShellSummary() {
    const { summary } = await loadStaffWorkspace();
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
            <div className="staff-scope min-h-screen bg-background font-sans text-sm text-foreground antialiased">
                {children}
            </div>
        );
    }

    return (
        <div className="staff-scope min-h-screen bg-background font-sans text-sm text-foreground antialiased">
            <StaffShell
                userName={gate.session?.user?.name ?? gate.session?.user?.email ?? 'Staff'}
                userEmail={gate.session?.user?.email ?? ''}
                initialCapabilities={capabilities}
                summaryContent={<Suspense fallback={null}><StaffShellSummary /></Suspense>}
            >
                {children}
            </StaffShell>
        </div>
    );
}
