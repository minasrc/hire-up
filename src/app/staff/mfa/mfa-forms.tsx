"use client";

import { useState } from 'react';

type MfaError = { message: string; returnToStaff?: boolean };
type MfaResult = { error?: MfaError; backupCodes?: string[] };

async function postCode(url: string, code: string, backup = false): Promise<MfaResult> {
    const response = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(backup ? { code, method: 'backup' } : { code }),
    });
    const body = await response.json().catch(() => null);
    if (response.ok) return { backupCodes: body?.backupCodes };
    if (response.status === 429) {
        const seconds = Number(response.headers.get('retry-after'));
        const minutes = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / 60) : 10;
        return { error: { message: `Too many attempts. Wait ${minutes} minute${minutes === 1 ? '' : 's'} before trying again.` } };
    }
    if (response.status === 409) {
        return { error: {
            message: 'Your two-factor setup has changed or is already complete. Continue to the staff page.',
            returnToStaff: true,
        } };
    }
    if (response.status === 401 && body?.error === 'invalid backup code') {
        return { error: { message: 'This backup code is invalid or has already been used. Try another saved code.' } };
    }
    if (response.status === 401 && body?.error === 'invalid code') {
        return { error: { message: 'Invalid code — wait for a new code in your authenticator app and try again.' } };
    }
    if (response.status === 401) {
        return { error: { message: 'Your session could not be verified. Return to the staff page to sign in again.', returnToStaff: true } };
    }
    return { error: { message: 'Two-factor authentication is temporarily unavailable. Please try again.' } };
}

function CodeForm({ onSubmit, label, backup = false, onComplete }: {
    onSubmit: (code: string) => Promise<MfaResult>;
    label: string;
    backup?: boolean;
    onComplete?: (result: MfaResult) => void;
}) {
    const [code, setCode] = useState('');
    const [error, setError] = useState<MfaError | null>(null);
    const [busy, setBusy] = useState(false);
    const submit = async () => {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            const result = await onSubmit(code);
            if (result.error) setError(result.error);
            else if (onComplete) onComplete(result);
            else window.location.assign('/staff');
        } catch {
            setError({ message: 'Could not connect. Check your connection and try again.' });
        } finally { setBusy(false); }
    };
    const valid = backup ? /^[a-f0-9]{32}$/i.test(code.replace(/[\s-]/g, '')) : code.length === 6;
    return (
        <form className="mt-6 flex flex-col items-center gap-4" onSubmit={(event) => {
            event.preventDefault(); void submit();
        }}>
            <label className="text-sm" htmlFor={backup ? 'backup-code' : 'authenticator-code'}>
                {backup ? 'Backup code' : 'Authenticator code'}
            </label>
            <input id={backup ? 'backup-code' : 'authenticator-code'}
                inputMode={backup ? 'text' : 'numeric'} autoComplete={backup ? 'off' : 'one-time-code'}
                spellCheck={false} autoCapitalize="none" maxLength={backup ? 64 : 6}
                value={code} onChange={(event) => setCode(backup ? event.target.value : event.target.value.replace(/\D/g, ''))}
                placeholder={backup ? 'XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX' : '000000'}
                className={`${backup ? 'w-full max-w-md text-xs' : 'w-40 text-lg tracking-[0.4em]'} rounded-md border border-foreground/20 bg-transparent px-3 py-2 text-center font-mono outline-none focus:border-foreground/50`} />
            {error && <div role="alert" className="text-sm text-destructive">
                <p>{error.message}</p>
                {error.returnToStaff && <a href="/staff" className="mt-2 inline-block text-foreground underline">Continue to staff</a>}
            </div>}
            <button type="submit" disabled={busy || !valid}
                className="rounded-md bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-80 disabled:opacity-40">
                {busy ? 'Checking…' : label}
            </button>
        </form>
    );
}

export function BackupCodesPanel({ codes }: { codes: string[] }) {
    const [saved, setSaved] = useState(false);
    const download = () => {
        const url = URL.createObjectURL(new Blob([
            `Agora backup codes\nKeep these somewhere safe. Each code works once after Google sign-in.\n\n${codes.join('\n')}\n`,
        ], { type: 'text/plain' }));
        const anchor = document.createElement('a');
        anchor.href = url; anchor.download = 'agora-backup-codes.txt'; anchor.click();
        URL.revokeObjectURL(url);
    };
    return (
        <div className="mt-6 flex w-full flex-col items-center gap-4">
            <h2 className="text-xl font-semibold">Save your backup codes</h2>
            <p className="text-sm text-muted-foreground">Use a code if you lose access to your authenticator. Each works once, after Google sign-in. These codes are shown only now. Keep them in a password manager or another safe place.</p>
            <label className="sr-only" htmlFor="backup-codes-list">Your backup codes</label>
            <textarea id="backup-codes-list" readOnly rows={10} value={codes.join('\n')}
                onFocus={(event) => event.currentTarget.select()}
                className="w-full rounded-md border bg-background p-3 text-center font-mono text-xs" />
            <p className="text-xs text-muted-foreground">Select the codes to copy them, or download a text file.</p>
            <button type="button" className="text-sm underline" onClick={download}>Download backup codes</button>
            <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} />
                I saved my backup codes
            </label>
            <button type="button" disabled={!saved} onClick={() => window.location.assign('/staff')}
                className="rounded-md bg-foreground px-5 py-2.5 text-sm text-background disabled:opacity-40">Continue to workspace</button>
        </div>
    );
}

function useBackupCodesResult() {
    const [codes, setCodes] = useState<string[] | null>(null);
    const [missing, setMissing] = useState(false);
    const complete = (result: MfaResult) => {
        if (Array.isArray(result.backupCodes) && result.backupCodes.length === 10
            && result.backupCodes.every((code) => typeof code === 'string' && /^[A-F0-9]{8}(?:-[A-F0-9]{8}){3}$/.test(code))) {
            setCodes(result.backupCodes);
        } else setMissing(true);
    };
    return { codes, missing, complete };
}

function MissingCodesNotice() {
    return <p role="alert" className="mt-6 text-sm">Setup completed, but the backup codes could not be displayed. <a className="underline" href="/staff/mfa/backup-codes">Generate a new set</a> using a fresh authenticator code.</p>;
}

export function MfaEnrollForm({ qrDataUrl, secret }: { qrDataUrl: string; secret: string }) {
    const { codes, missing, complete } = useBackupCodesResult();
    if (codes) return <BackupCodesPanel codes={codes} />;
    if (missing) return <MissingCodesNotice />;
    return <>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={qrDataUrl} alt="Authenticator QR code" className="mt-8 h-48 w-48 rounded-md bg-white p-2" />
        <p className="mt-4 break-all font-mono text-xs text-foreground/50">{secret}</p>
        <CodeForm label="Enable two-factor" onSubmit={(code) => postCode('/api/staff/mfa/enroll', code)} onComplete={complete} />
    </>;
}

export function MfaVerifyForm() {
    const [backup, setBackup] = useState(false);
    return <>
        <CodeForm key={backup ? 'backup' : 'totp'} label={backup ? 'Use backup code' : 'Verify'} backup={backup}
            onSubmit={(code) => postCode('/api/staff/mfa/verify', code, backup)} />
        <button type="button" className="mt-6 text-sm underline" onClick={() => setBackup(!backup)}>
            {backup ? 'Use authenticator instead' : 'Use a backup code'}
        </button>
        {backup && <p className="mt-3 text-xs text-muted-foreground">Enter one of the codes you saved during setup. Each code works once.</p>}
        <p className="mt-3 text-xs text-muted-foreground">If you lost your authenticator and all saved backup codes, ask a staff administrator to verify your identity and reset your authenticator.</p>
    </>;
}

export function BackupCodesGenerateForm() {
    const { codes, missing, complete } = useBackupCodesResult();
    if (codes) return <BackupCodesPanel codes={codes} />;
    if (missing) return <MissingCodesNotice />;
    return <CodeForm label="Generate 10 new backup codes" onSubmit={(code) => postCode('/api/staff/mfa/backup-codes', code)} onComplete={complete} />;
}
