'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function MemberMfaResetForm({ membershipId, version, displayName }: {
    membershipId: string; version: string; displayName: string;
}) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [code, setCode] = useState('');
    const [reason, setReason] = useState('lost_authenticator');
    const [confirmed, setConfirmed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState(false);
    if (done) return <p role="status" className="text-sm">Authenticator reset. Ask this member to open the staff workspace and set up their authenticator again.</p>;
    if (!open) return <button type="button" className="ml-3 text-sm underline" onClick={() => setOpen(true)}>Reset authenticator</button>;
    return <form className="mt-3 flex max-w-sm flex-col gap-3 rounded-md border p-3 text-sm" onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true); setError(null);
        try {
            const response = await fetch('/api/staff/members/mfa-reset', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ membershipId, version: Number(version), reason, code }),
            });
            const body = await response.json().catch(() => null);
            if (response.ok) { setDone(true); router.refresh(); return; }
            if (response.status === 429) {
                const seconds = Number(response.headers.get('retry-after'));
                const minutes = seconds > 0 ? Math.ceil(seconds / 60) : 10;
                setError(`Too many attempts. Wait ${minutes} minute${minutes === 1 ? '' : 's'} and try again.`);
            } else if (response.status === 409) setError('This member changed. Reload the page before trying again.');
            else if (response.status === 401) setError(body?.error ?? 'Sign in again before continuing.');
            else if (response.status === 428) setError('Your two-factor session expired. Open the staff workspace in another tab to verify again.');
            else if (response.status === 403) setError('You cannot reset this member’s authenticator. Staff-management permission is required, and self-reset is not allowed.');
            else if (response.status === 422) setError('Reset was rejected. Reload the page and try with a fresh code; this member may have no authenticator to reset.');
            else setError('Recovery is temporarily unavailable. Please try again.');
        } catch { setError('Could not connect. Check your connection and try again.'); }
        finally { setBusy(false); setCode(''); }
    }}>
        <p className="font-medium">Reset authenticator for {displayName}?</p>
        <p>Their current authenticator, backup codes and verified sessions will stop working. Their Google account and membership remain active. Verify their identity outside this application first.</p>
        <label>Reason
            <select className="mt-1 w-full rounded border bg-background p-2" value={reason} onChange={(event) => setReason(event.target.value)}>
                <option value="lost_authenticator">Lost authenticator</option>
                <option value="compromised_device">Compromised device</option>
            </select>
        </label>
        <label>Your fresh authenticator code
            <input className="mt-1 w-full rounded border bg-background p-2" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} />
        </label>
        <label className="flex gap-2"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />I verified this member’s identity.</label>
        {error && <p role="alert" className="text-destructive">{error}</p>}
        <div className="flex gap-3">
            <button type="button" disabled={busy} onClick={() => { setOpen(false); setCode(''); setConfirmed(false); setError(null); }}>Cancel</button>
            <button type="submit" className="rounded bg-destructive px-3 py-2 text-destructive-foreground disabled:opacity-40"
                disabled={busy || !confirmed || code.length !== 6}>{busy ? 'Resetting…' : 'Confirm reset'}</button>
        </div>
    </form>;
}
