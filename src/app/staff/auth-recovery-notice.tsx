'use client';

import { useEffect } from 'react';
import { staffAuthRecovery } from '@/lib/staff-auth-recovery';
import { StaffAuthRecoveryPrompt, useStaffAuthRecovery } from './auth-recovery';

export function AuthRecoveryNotice() {
    const recovery = useStaffAuthRecovery();
    useEffect(() => {
        // Retain compatibility with forms that already report this event.
        const listener = (event: Event) => {
            const detail = (event as CustomEvent).detail;
            staffAuthRecovery.require(detail?.mfa ? 428 : 401, detail?.epoch, 'save');
        };
        window.addEventListener('staff-auth-required', listener);
        return () => window.removeEventListener('staff-auth-required', listener);
    }, []);
    if (!recovery.required) return null;
    return (
        <aside aria-label="Access recovery" className="fixed bottom-4 right-4 z-50 max-w-sm rounded-lg border bg-background p-4 shadow-lg">
            <StaffAuthRecoveryPrompt />
        </aside>
    );
}
