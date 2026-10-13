import { redirect } from 'next/navigation';
import QRCode from 'qrcode';
import { staffGate } from '@/lib/staff-gate.server';
import { multiWorkspaceEnabled } from '@/lib/staff-workspace-context.server';
import { enrollTotp } from '@/lib/staff-mfa.server';
import { totpUri } from '@/lib/totp';
import { mfaEnrollmentLabel } from '@/lib/staff-mfa-label';
import { MfaEnrollForm } from '../mfa-forms';

export const dynamic = 'force-dynamic';

export const metadata = {
    title: 'Set up two-factor · Agora staff',
};

export default async function StaffMfaEnrollPage() {
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
    if (gate.totp?.status === 'active') {
        redirect('/staff');
    }

    const enrollment = await enrollTotp(gate.pool, gate.identity, gate.organizationId);
    if (enrollment.status === 'active') redirect('/staff');
    const secret = enrollment.secret;
    const uri = totpUri({
        secret,
        accountName: mfaEnrollmentLabel(gate.session?.user?.email ?? gate.identity.subject, gate.principal?.workspace_name, multiWorkspaceEnabled()),
    });
    const qrDataUrl = await QRCode.toDataURL(uri, { margin: 1, width: 256 });

    const multiWorkspace = multiWorkspaceEnabled();
    const workspaceName = gate.principal?.workspace_name || 'Agora';

    return (
        <section className="mx-auto flex max-w-md flex-col items-center px-6 py-24 text-center">
            <p className="text-sm uppercase tracking-widest text-foreground/50">{multiWorkspace ? workspaceName : 'Agora staff'}</p>
            <h1 className="mt-3 text-2xl font-semibold">Set up two-factor authentication</h1>
            <p className="mt-4 text-sm leading-6 text-foreground/60">
                Scan this code with your authenticator app, then enter the
                six-digit code to finish setup.
            </p>
            <MfaEnrollForm qrDataUrl={qrDataUrl} secret={secret} />
            {multiWorkspace && <a href="/staff/workspaces" className="mt-6 text-sm underline underline-offset-4">Choose another workspace</a>}
        </section>
    );
}
