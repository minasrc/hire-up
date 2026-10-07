import { redirect } from 'next/navigation';
import QRCode from 'qrcode';
import { staffGate } from '@/lib/staff-gate.server';
import { enrollTotp } from '@/lib/staff-mfa.server';
import { totpUri } from '@/lib/totp';
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
    if (gate.stage === 'unresolved') {
        redirect('/staff/no-access');
    }
    if (gate.totp?.status === 'active') {
        redirect('/staff');
    }

    let secret = gate.totp?.secret;
    if (!secret) {
        const enrollment = await enrollTotp(gate.pool, gate.identity, gate.organizationId);
        secret = enrollment.secret;
    }
    const uri = totpUri({
        secret,
        accountName: gate.session?.user?.email ?? gate.identity.subject,
    });
    const qrDataUrl = await QRCode.toDataURL(uri, { margin: 1, width: 256 });

    return (
        <section className="mx-auto flex max-w-md flex-col items-center px-6 py-24 text-center">
            <p className="text-sm uppercase tracking-widest text-foreground/50">Agora staff</p>
            <h1 className="mt-3 text-2xl font-semibold">Set up two-factor authentication</h1>
            <p className="mt-4 text-sm leading-6 text-foreground/60">
                Scan this code with your authenticator app, then enter the
                six-digit code to finish setup.
            </p>
            <MfaEnrollForm qrDataUrl={qrDataUrl} secret={secret} />
        </section>
    );
}
