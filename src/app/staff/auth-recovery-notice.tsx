'use client';

import { useEffect, useState } from 'react';

export function AuthRecoveryNotice() {
    const [required, setRequired] = useState<{ mfa: boolean } | null>(null);
    useEffect(() => {
        const listener = (event: Event) => setRequired((event as CustomEvent).detail);
        window.addEventListener('staff-auth-required', listener);
        return () => window.removeEventListener('staff-auth-required', listener);
    }, []);
    if (!required) return null;
    return (
        <aside role="alert" className="fixed bottom-4 right-4 z-50 max-w-sm rounded-lg border bg-background p-4 shadow-lg">
            <p className="text-sm">Keep this tab open to preserve your edits. Complete verification in another tab, then retry saving.</p>
            <a className="mt-3 inline-block text-sm underline" target="_blank" rel="noopener noreferrer"
                href={required.mfa ? '/staff/mfa/verify' : '/staff/sign-in'}>
                {required.mfa ? 'Verify authenticator' : 'Sign in again'}
            </a>
            <button type="button" className="ml-4 text-sm underline" onClick={() => setRequired(null)}>Dismiss</button>
        </aside>
    );
}
