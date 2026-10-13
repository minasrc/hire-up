import { redirect } from 'next/navigation';
import { staffGate } from '@/lib/staff-gate.server';
import { multiWorkspaceEnabled } from '@/lib/staff-workspace-context.server';
import { MfaVerifyForm } from '../mfa-forms';

export const dynamic = 'force-dynamic';

export const metadata = {
    title: 'Two-factor verification · Agora staff',
};

export default async function StaffMfaVerifyPage() {
    const gate = await staffGate();
    if (gate.stage === 'unavailable') {
        redirect('/staff/unavailable');
    }
    if (gate.stage === 'signed-out' || gate.stage === 'reauthenticate') {
        redirect('/staff/sign-in');
    }
    if (gate.stage === 'workspace-required') redirect('/staff/workspaces');
    if (gate.stage === 'unresolved') {
        redirect('/staff/no-access');
    }
    if (gate.stage === 'verified') {
        redirect('/staff');
    }
    if (gate.totp?.status !== 'active') {
        redirect('/staff/mfa/enroll');
    }

    const multiWorkspace = multiWorkspaceEnabled();
    const workspaceName = gate.principal?.workspace_name || 'Agora';

    return (
        <section className="mx-auto flex max-w-md flex-col items-center px-6 py-24 text-center">
            <p className="text-sm uppercase tracking-widest text-foreground/50">{multiWorkspace ? workspaceName : 'Agora staff'}</p>
            <h1 className="mt-3 text-2xl font-semibold">Two-factor verification</h1>
            <p className="mt-4 text-sm leading-6 text-foreground/60">
                Enter the six-digit code from your authenticator app.
            </p>
            <MfaVerifyForm />
            {multiWorkspace && <a href="/staff/workspaces" className="mt-6 text-sm underline underline-offset-4">Choose another workspace</a>}
        </section>
    );
}
