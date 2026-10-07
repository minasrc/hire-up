import { redirect } from 'next/navigation';
import { staffGate } from '@/lib/staff-gate.server';
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
    if (gate.stage === 'unresolved') {
        redirect('/staff/no-access');
    }
    if (gate.totp?.status !== 'active') {
        redirect('/staff/mfa/enroll');
    }

    return (
        <section className="mx-auto flex max-w-md flex-col items-center px-6 py-24 text-center">
            <p className="text-sm uppercase tracking-widest text-foreground/50">Agora staff</p>
            <h1 className="mt-3 text-2xl font-semibold">Two-factor verification</h1>
            <p className="mt-4 text-sm leading-6 text-foreground/60">
                Enter the six-digit code from your authenticator app.
            </p>
            <MfaVerifyForm />
        </section>
    );
}
