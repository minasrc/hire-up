'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/staff-ui/button';
import { Card } from '@/components/staff-ui/card';
import { Input } from '@/components/staff-ui/input';
import { Label } from '@/components/staff-ui/label';
import { Badge } from '@/components/staff-ui/badge';
import { canRenewDevice, createInvitation, deviceStatus, pairingCommand, pairingError } from './pairing-model';

type Device = { id: string; name: string; createdAt: string; expiresAt: string; revokedAt: string | null; lastSeenAt: string | null; connectorLastSeenAt: string | null; compatibleSearchLastSeenAt: string | null };
type Pairing = { pairingId: string; status: string; name: string; deviceName: string | null; expiresAt: string; deviceFingerprint: string | null; worker?: { id: string; name: string; expiresAt: string } | null };
type Organization = { id: string; name: string };
type Listing = { devices: Device[]; pairings: Pairing[]; nextAfter: string | null; organization?: Organization };
type Invitation = Awaited<ReturnType<typeof createInvitation>> & { name: string; pairingId?: string };
const endpoint = '/api/staff/worker-devices';
const date = (value: string | null) => value ? new Date(value).toLocaleString() : 'No activity recorded';
class PairingFailure extends Error {
    constructor(public status: number, public code: string, public retryAfterSeconds?: number) { super(pairingError(code, retryAfterSeconds)); }
}
async function request(url: string, init?: RequestInit) {
    const response = await fetch(url, { cache: 'no-store', ...init });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new PairingFailure(response.status, body.code ?? (response.status === 401 ? 'UNAUTHORIZED' : response.status === 403 ? 'FORBIDDEN' : ''), body.retryAfterSeconds);
    return body;
}
export function WorkerPairingPanel({ workspaceId, onDeviceChange }: { workspaceId: string; onDeviceChange: () => void }) {
    const [listing, setListing] = useState<Listing | null>(null);
    const [pairing, setPairing] = useState<Pairing | null>(null);
    const [selected, setSelected] = useState('');
    const [name, setName] = useState('My Mac');
    const [invitation, setInvitation] = useState<Invitation | null>(null);
    const [cursors, setCursors] = useState(['']);
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(true);
    const [denied, setDenied] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [revision, setRevision] = useState(0);
    const [confirmed, setConfirmed] = useState('');
    const [revoke, setRevoke] = useState('');
    const [command, setCommand] = useState<string | null>(null);
    const [now, setNow] = useState(Date.now);
    const read = useRef<AbortController | null>(null);
    const epoch = useRef(0);
    const mutation = useRef(false);
    const creating = useRef(false);
    const operation = useRef<{ key: string; id: string } | null>(null);
    const secret = useRef<Invitation | null>(null);
    const after = cursors[cursors.length - 1];
    function clearSecret() { secret.current = null; setInvitation(null); }
    const fail = useCallback((failure: unknown) => {
        setError(failure instanceof PairingFailure ? failure.message : 'Unable to reach the pairing service. Try again.');
        if (failure instanceof PairingFailure && [401, 403].includes(failure.status)) { setDenied(true); setListing(null); setPairing(null); secret.current = null; setInvitation(null); }
    }, []);
    const load = useCallback(async () => {
        if (document.hidden || mutation.current) return;
        read.current?.abort(); const controller = new AbortController(); read.current = controller; const generation = ++epoch.current;
        try {
            const [devices, current] = await Promise.all([request(`${endpoint}${after ? `?after=${encodeURIComponent(after)}` : ''}`, { signal: controller.signal }), selected ? request(`${endpoint}?pairingId=${selected}`, { signal: controller.signal }) : null]);
            if (controller.signal.aborted || generation !== epoch.current) return;
            setListing(devices); setPairing(current); setNow(Date.now());
            if (current && (current.status !== 'invited' || Date.parse(current.expiresAt) <= Date.now())) { secret.current = null; setInvitation(null); }
        } catch (failure) {
            if (controller.signal.aborted || generation !== epoch.current) return;
            fail(failure);
            if (failure instanceof PairingFailure && failure.status === 404 && selected) { setSelected(''); setPairing(null); secret.current = null; setInvitation(null); }
        } finally { if (!controller.signal.aborted && generation === epoch.current) setLoading(false); }
    }, [after, selected, fail]);
    useEffect(() => {
        // This command contains only the public origin; invitations never enter it.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setCommand(pairingCommand(window.location.origin));
        return () => { secret.current = null; read.current?.abort(); epoch.current += 1; };
    }, []);
    useEffect(() => {
        if (denied) return;
        let stopped = false; let timer: ReturnType<typeof setTimeout>; let cycle = 0;
        async function poll(version = cycle) { await load(); if (!stopped && version === cycle && !document.hidden) timer = setTimeout(() => void poll(version), selected ? 5000 : 15000); }
        const visibility = () => { cycle += 1; clearTimeout(timer); if (document.hidden) read.current?.abort(); else void poll(); };
        void poll(); document.addEventListener('visibilitychange', visibility);
        return () => { stopped = true; clearTimeout(timer); read.current?.abort(); document.removeEventListener('visibilitychange', visibility); };
    }, [load, selected, revision, denied]);
    const pairingExpiresAt = pairing?.expiresAt;
    const pairingStatus = pairing?.status;
    useEffect(() => {
        if (!pairingExpiresAt || !pairingStatus || !['invited', 'claimed'].includes(pairingStatus)) return;
        const timer = setTimeout(() => { secret.current = null; setInvitation(null); setNow(Date.now()); }, Math.max(0, Date.parse(pairingExpiresAt) - Date.now()));
        return () => clearTimeout(timer);
    }, [pairingExpiresAt, pairingStatus]);
    function refresh() { setDenied(false); setError(''); setLoading(true); setRevision(value => value + 1); }
    async function mutate(body: Record<string, unknown>, method = 'POST', url = endpoint) {
        if (mutation.current) return;
        mutation.current = true; read.current?.abort(); epoch.current += 1; setBusy(true); setError(''); setNotice('');
        const key = JSON.stringify({ url, body });
        if (operation.current?.key !== key) operation.current = { key, id: crypto.randomUUID() };
        try {
            const result = await request(url, { method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId: operation.current.id, ...body }) } : {}) });
            operation.current = null;
            if (body.action === 'invite') { const next = { ...secret.current!, pairingId: result.pairingId }; secret.current = next; setInvitation(next); setSelected(result.pairingId); setPairing(result); }
            if (body.action === 'approve') { clearSecret(); setPairing(current => current ? { ...current, ...result } : result); setNotice('Mac paired. Start its Telegram connector to sign in below. Pairing alone does not start Telegram or other services.'); onDeviceChange(); }
            if (body.action === 'cancel') { clearSecret(); setPairing(current => current ? { ...current, ...result } : result); setNotice('Invitation cancelled.'); }
            if (body.action === 'renew') { setNotice('Device access renewed for 30 days. Its existing credential and saved work are preserved.'); onDeviceChange(); }
            if (method === 'DELETE') { setRevoke(''); setNotice('Device access revoked. Telegram logout and deletion of local files are not confirmed.'); onDeviceChange(); }
        } catch (failure) { fail(failure); if (failure instanceof PairingFailure && failure.status === 409) operation.current = null; }
        finally { mutation.current = false; setBusy(false); setRevision(value => value + 1); }
    }
    async function invite() {
        if (busy || creating.current || !name.trim()) return;
        creating.current = true; setBusy(true);
        try {
            if (!secret.current) { const next = { ...await createInvitation(), name: name.trim() }; secret.current = next; setInvitation(next); }
            const pending = secret.current;
            await mutate({ action: 'invite', operationId: pending.operationId, invitationSha256: pending.invitationSha256, name: pending.name });
        } catch (failure) { fail(failure); }
        finally { creating.current = false; setBusy(false); }
    }
    function resume(item: Pairing) { read.current?.abort(); epoch.current += 1; setSelected(item.pairingId); setPairing(item); setConfirmed(''); setError(''); if (secret.current?.pairingId !== item.pairingId) clearSecret(); }
    async function copyInvitation() {
        if (!invitation?.pairingId || pairing?.status !== 'invited' || Date.parse(pairing.expiresAt) <= Date.now()) return;
        try { await navigator.clipboard.writeText(`${invitation.pairingId}.${invitation.secret}`); setNotice('Invitation copied. Paste it only at the pairing command’s hidden prompt.'); }
        catch { setError('Clipboard access failed. Select and copy the invitation below.'); }
    }
    const live = pairing && ['invited', 'claimed'].includes(pairing.status) && Date.parse(pairing.expiresAt) > now;
    const fingerprint = pairing?.status === 'claimed' ? pairing.deviceFingerprint : null;
    return <Card className="space-y-5 p-6" aria-label="Mac device pairing">
        <div><h2 className="font-semibold">Pair your Mac</h2><p className="mt-1 text-sm text-muted-foreground">Give your Mac access to this workspace, then start the Telegram connector. Pairing does not set up Telegram, parsing or search services.</p></div>
        <p className="break-words text-sm">Workspace: <strong>{listing?.organization?.name || workspaceId}</strong></p>
        {error ? <p role="alert" className="text-sm">{error}</p> : null}{notice ? <p role="status" className="text-sm">{notice}</p> : null}
        <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={busy || loading} onClick={refresh}>Refresh devices</Button>{loading ? <span className="text-xs text-muted-foreground">Loading devices…</span> : null}</div>
        {!denied ? <>
            {!live && !invitation?.pairingId ? <div className="space-y-2"><Label htmlFor="pairing-device-name">Device name</Label><Input id="pairing-device-name" value={name} maxLength={80} disabled={busy || !!invitation} onChange={event => setName(event.target.value)} /><Button disabled={busy || !name.trim()} onClick={() => void invite()}>{busy ? 'Working…' : invitation ? 'Retry invitation' : 'Pair this Mac'}</Button></div> : null}
            {listing?.pairings.filter(item => item.pairingId !== selected).map(item => <div key={item.pairingId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3"><span className="text-sm">{item.name} · {item.status === 'claimed' ? 'Awaiting confirmation' : 'Invitation pending'}</span><Button size="sm" variant="outline" disabled={busy} onClick={() => resume(item)}>Resume pairing</Button></div>)}
            {pairing ? <div className="space-y-3 rounded-lg border border-border p-4">
                <div className="flex flex-wrap items-center gap-2"><h3 className="font-medium">{pairing.name}</h3><Badge variant="secondary">{!live && ['invited', 'claimed'].includes(pairing.status) ? 'expired' : pairing.status}</Badge></div>
                {live ? <p className="text-xs text-muted-foreground">Invitation expires {date(pairing.expiresAt)}.</p> : null}
                {live && pairing.status === 'invited' ? <>
                    {invitation?.pairingId === pairing.pairingId ? <><p className="text-sm">In the app’s checked-out folder on your Mac, run this command. Replace the directory with your private, absolute folder path.</p>{command ? <code className="block break-all rounded-lg bg-muted p-3 text-xs">{command}</code> : null}<p className="text-sm">Paste the invitation only when the command asks for it. It expires in ten minutes and disappears from this browser on refresh.</p><Label htmlFor="pairing-invitation">One-time invitation</Label><Input id="pairing-invitation" readOnly autoComplete="off" value={`${invitation.pairingId}.${invitation.secret}`} className="font-mono text-xs" /><Button size="sm" variant="outline" onClick={() => void copyInvitation()}>Copy invitation</Button></>
                        : <p className="text-sm">The invitation secret is no longer available in this browser. If your Mac already received it, continue there. Otherwise cancel this invitation and create a new one.</p>}
                </> : null}
                {live && fingerprint ? <><h4 className="font-medium">Check this device before confirming</h4><p className="text-sm">Requested name: {pairing.name}<br />Mac name: {pairing.deviceName}<br />Workspace: {listing?.organization?.name || workspaceId}</p><p className="break-all rounded-lg bg-muted p-3 font-mono text-lg" aria-label="Device fingerprint">{fingerprint}</p><label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={confirmed === fingerprint} onChange={event => setConfirmed(event.target.checked ? fingerprint : '')} />This fingerprint matches the one shown by the pairing command on my Mac.</label><Button disabled={busy || confirmed !== fingerprint} onClick={() => void mutate({ action: 'approve', pairingId: pairing.pairingId, deviceFingerprint: fingerprint })}>Confirm device</Button></> : null}
                {pairing.status === 'approved' ? <p className="text-sm">Mac paired. Keep the local pairing command running until it confirms the credential was saved, then start your connector.</p> : null}
                {pairing.status === 'cancelled' || !live && ['invited', 'claimed', 'expired'].includes(pairing.status) ? <p className="text-sm">This invitation can no longer be used. Create a new pairing to continue.</p> : null}
                {live ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void mutate({ action: 'cancel', pairingId: pairing.pairingId })}>Cancel invitation</Button> : null}
            </div> : null}
            <details><summary className="cursor-pointer text-sm font-medium">Your devices{listing ? ` (${listing.devices.length}${listing.nextAfter ? '+' : ''})` : ''}</summary><div className="mt-3 space-y-3">
                {listing?.devices.length === 0 ? <p className="text-sm text-muted-foreground">No devices on this page.</p> : null}
                {listing?.devices.map(device => <div key={device.id} className="space-y-3 rounded-lg border border-border p-4"><div className="flex flex-wrap items-center gap-2"><h3 className="font-medium">{device.name}</h3><Badge variant="secondary">{deviceStatus(device, now)}</Badge></div><p className="text-xs text-muted-foreground">Access expires {date(device.expiresAt)}.</p><dl className="space-y-1 text-xs text-muted-foreground"><div>Last activity: {date(device.lastSeenAt)}</div><div>Telegram connector activity: {date(device.connectorLastSeenAt)}</div><div>Compatible search worker activity: {date(device.compatibleSearchLastSeenAt)}</div></dl><p className="text-xs text-muted-foreground">Activity timestamps do not confirm that all services are ready.</p><div className="flex flex-wrap gap-2">{canRenewDevice(device, now) ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void mutate({ action: 'renew', workerId: device.id, expectedExpiresAt: device.expiresAt })}>Renew access for 30 days</Button> : null}{!device.revokedAt ? <Button size="sm" variant="outline" disabled={busy} onClick={() => setRevoke(device.id)}>Revoke access</Button> : null}</div>{!device.revokedAt && Date.parse(device.expiresAt) < now - 7 * 86400000 ? <p className="text-sm">This device expired more than seven days ago. Pair it again; preserve old local files until you choose to clean them up.</p> : null}{revoke === device.id ? <div className="space-y-2"><p className="text-sm">Revoke host access immediately? For normal removal, disconnect Telegram above and wait for logout confirmation first. Revoking does not log out Telegram or delete files on your Mac.</p><div className="flex gap-2"><Button size="sm" disabled={busy} onClick={() => void mutate({}, 'DELETE', `/api/staff/telegram-intake/workers/${device.id}`)}>Confirm revoke</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => setRevoke('')}>Keep access</Button></div></div> : null}</div>)}
                <div className="flex gap-2"><Button variant="outline" size="sm" disabled={busy || loading || cursors.length === 1} onClick={() => setCursors(current => current.slice(0, -1))}>Previous devices</Button><Button variant="outline" size="sm" disabled={busy || loading || !listing?.nextAfter} onClick={() => setCursors(current => [...current, listing!.nextAfter!])}>Next devices</Button></div>
            </div></details>
        </> : null}
    </Card>;
}
