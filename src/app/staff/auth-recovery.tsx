'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { useSession } from 'next-auth/react';
import { staffAuthRecovery } from '@/lib/staff-auth-recovery';
import { Button } from '@/components/staff-ui/button';

export function useStaffAuthRecovery() {
    return useSyncExternalStore(staffAuthRecovery.subscribe,
        staffAuthRecovery.getSnapshot, staffAuthRecovery.getServerSnapshot);
}

export function StaffAuthRecoveryLifecycle() {
    const { status } = useSession();
    const recovery = useStaffAuthRecovery();
    useEffect(() => {
        if (status === 'unauthenticated' && !recovery.required) staffAuthRecovery.require(401);
    }, [status, recovery.required]);
    return null;
}

export function StaffAuthRecoveryPrompt() {
    const recovery = useStaffAuthRecovery();
    const { update } = useSession();
    if (!recovery.required) return null;
    const busy = recovery.phase !== 'required';
    const retry = async () => {
        const epoch = staffAuthRecovery.beginRetry();
        if (epoch === null) return;
        try {
            // NextAuth's browser session may also have expired. This is not
            // sufficient proof of MFA; subsequent staff reads still check it.
            const session = await update();
            if (!session) { staffAuthRecovery.require(401, epoch, recovery.source); return; }
            staffAuthRecovery.retryReady(epoch);
        } catch { staffAuthRecovery.retryFailed(epoch); }
    };
    return <div className="space-y-3">
        <p role="alert" className="text-sm">
            {recovery.mfa ? 'Authenticator verification is required to continue.' : 'Sign in again to continue.'}
            {recovery.source === 'save' ? ' Your changes have not been saved.' : ''}
            {' Keep this tab open to preserve your edits. Complete verification in another tab, then retry.'}
            {recovery.error ? ` ${recovery.error}` : ''}
        </p>
        <div className="flex flex-wrap items-center gap-3">
            <a className="text-sm underline" target="_blank" rel="noopener noreferrer"
                href={recovery.mfa ? '/staff/mfa/verify' : '/staff/sign-in'}>
                {recovery.mfa ? 'Verify authenticator' : 'Sign in again'}
            </a>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void retry()}>
                {busy ? 'Checking access…' : 'Retry access'}
            </Button>
        </div>
    </div>;
}
