'use client';

import { staffWorkspaceFetch } from '@/lib/staff-workspace-fetch';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import QRCode from 'qrcode';
import { CheckCircle2, Laptop, RefreshCw } from 'lucide-react';
import { PageHeader } from '@/components/staff-preview/shared';
import { Badge } from '@/components/staff-ui/badge';
import { Button } from '@/components/staff-ui/button';
import { Card } from '@/components/staff-ui/card';
import { Input } from '@/components/staff-ui/input';
import { Label } from '@/components/staff-ui/label';
import { HostedConnectionPanel } from './hosted-connection-panel';
import { hostedConnectionError } from './hosted-connection-model';
import { WorkerPairingPanel } from './worker-pairing-panel';
import { connectionError, encryptTelegramPassword, pollingDelay, requiresWorkerDisconnect, usableQr } from './connection-model';

type Worker = { id: string; name: string; publicKeySpki: string; online: boolean; lastSeenAt: string | null };
type Connection = {
    id: string; workerId: string; generation: number; status: string; challengeId: string;
    qrLoginUrl: string | null; qrExpiresAt: string | null; passwordHint: string | null;
    retirementReason?: string | null; passwordPending: boolean; errorCode: string | null; cancelledBeforeStart?: boolean; workerPinned?: boolean;
    profile: { telegramUserId: string; username: string | null; displayName: string } | null;
};
type Snapshot = { workers: Worker[]; connection: Connection | null };
const endpoint = '/api/staff/telegram-connection';

class ConnectionRequestError extends Error {
    constructor(public status: number) {
        super(status === 403 || status === 401 || status === 428 ? 'You do not have access to this connection. Sign in again or contact your workspace administrator.'
            : status === 409 ? 'The connection changed. Its current status has been refreshed; try again.'
                : status === 404 ? 'Telegram connections are not available in this workspace yet.'
                    : 'Unable to reach the connection service. Retry when your connection is restored.');
    }
}
async function request(init?: RequestInit): Promise<Snapshot> {
    const response = await staffWorkspaceFetch(endpoint, { cache: 'no-store', ...init });
    if (!response.ok) throw new ConnectionRequestError(response.status);
    return response.json();
}

export function TelegramConnectionBrowser({ workspaceId, hostedEnabled = false }: { workspaceId: string; hostedEnabled?: boolean }) {
    // Changing workspace or connection mode discards pending requests and secrets.
    return <ConnectionBrowser key={`${workspaceId}:${hostedEnabled}`} workspaceId={workspaceId} hostedEnabled={hostedEnabled} />;
}

function ConnectionBrowser({ workspaceId, hostedEnabled }: { workspaceId: string; hostedEnabled: boolean }) {
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
    const [selectedWorker, setSelectedWorker] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [accessDenied, setAccessDenied] = useState(false);
    const [refresh, setRefresh] = useState(0);
    const [now, setNow] = useState(() => Date.now());
    const [qrError, setQrError] = useState(false);
    const canvas = useRef<HTMLCanvasElement>(null);
    const generation = useRef(0);
    const hostedAttempt = useRef<AbortController | null>(null);
    const currentRead = useRef<AbortController | null>(null);
    const currentMutation = useRef<AbortController | null>(null);
    const mutating = useRef(false);
    const mutationError = useRef(false);
    const mounted = useRef(true);
    const passwordInput = useRef<HTMLInputElement>(null);
    const connection = snapshot?.connection;
    const worker = snapshot?.workers.find(item => item.id === connection?.workerId);
    const active = connection && !['failed', 'disconnected'].includes(connection.status);
    const qrAvailable = usableQr(connection, now);
    const workerChangeBlocked = requiresWorkerDisconnect(connection, selectedWorker);

    const denyAccess = useCallback(() => {
        generation.current += 1;
        hostedAttempt.current?.abort();
        currentRead.current?.abort(); currentMutation.current?.abort();
        setAccessDenied(true); setSnapshot(null); setPassword('');
        if (passwordInput.current) passwordInput.current.value = '';
    }, []);

    const load = useCallback(async () => {
        if (mutating.current || document.hidden) return;
        currentRead.current?.abort();
        const controller = new AbortController();
        currentRead.current = controller;
        const revision = generation.current;
        try {
            const result = await request({ signal: controller.signal });
            if (!controller.signal.aborted && revision === generation.current && mounted.current) {
                setSnapshot(result);
                setSelectedWorker(current => result.workers.some(item => item.id === current) ? current
                    : result.connection?.workerPinned && result.workers.some(item => item.id === result.connection?.workerId) ? result.connection.workerId
                        : result.workers.find(item => item.online)?.id || result.workers[0]?.id || '');
                if (!mutationError.current) setError('');
            }
        } catch (failure) {
            if (controller.signal.aborted || revision !== generation.current || !mounted.current) return;
            setError(failure instanceof Error ? failure.message : 'Unable to refresh the connection.');
            if (failure instanceof ConnectionRequestError && [401, 403, 404, 428].includes(failure.status)) denyAccess();
        }
    }, [denyAccess]);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false; currentRead.current?.abort(); currentMutation.current?.abort();
            // This is a request controller, not a DOM ref; abort the latest attempt.
            // eslint-disable-next-line react-hooks/exhaustive-deps
            hostedAttempt.current?.abort();
        };
    }, []);
    useEffect(() => {
        const invalidate = () => denyAccess();
        window.addEventListener('staff-session-invalidated', invalidate);
        return () => window.removeEventListener('staff-session-invalidated', invalidate);
    }, [denyAccess]);
    useEffect(() => {
        if (accessDenied) return;
        let timer: ReturnType<typeof setTimeout>;
        let stopped = false;
        let cycle = 0;
        const poll = async (version = cycle) => {
            await load();
            if (!stopped && version === cycle && !document.hidden) timer = setTimeout(() => void poll(version), pollingDelay(connection?.status));
        };
        const visibility = () => {
            cycle += 1;
            clearTimeout(timer);
            if (document.hidden) currentRead.current?.abort();
            else void poll();
        };
        void poll();
        document.addEventListener('visibilitychange', visibility);
        return () => { stopped = true; clearTimeout(timer); currentRead.current?.abort(); document.removeEventListener('visibilitychange', visibility); };
    }, [load, connection?.status, refresh, accessDenied]);
    useEffect(() => {
        const timer = setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 1000);
        return () => clearInterval(timer);
    }, []);
    useEffect(() => {
        // Clear secret state immediately when the server replaces this challenge.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setPassword('');
        if (passwordInput.current) passwordInput.current.value = '';
    }, [connection?.id, connection?.generation, connection?.challengeId, connection?.status]);
    useEffect(() => {
        if (!qrAvailable || !canvas.current) return;
        let stale = false;
        setQrError(false);
        void QRCode.toCanvas(canvas.current, connection.qrLoginUrl!, { width: 256, margin: 3, errorCorrectionLevel: 'M' })
            .catch(() => { if (!stale) setQrError(true); });
        return () => { stale = true; };
    }, [connection?.qrLoginUrl, qrAvailable, refresh]);

    async function mutate(payload: Record<string, unknown>, signal?: AbortSignal) {
        if (mutating.current || signal?.aborted) return;
        const revision = ++generation.current;
        currentRead.current?.abort();
        const controller = new AbortController();
        currentMutation.current = controller;
        const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        mutating.current = true;
        mutationError.current = false;
        setBusy(true); setError('');
        try {
            const result = await request({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: requestSignal });
            if (mounted.current && revision === generation.current && !requestSignal.aborted) setSnapshot(result);
        } catch (failure) {
            if (mounted.current && revision === generation.current && !requestSignal.aborted) {
                mutationError.current = true;
                setError(failure instanceof Error ? failure.message : 'Unable to update the connection.');
                if (failure instanceof ConnectionRequestError && [401, 403, 404, 428].includes(failure.status)) denyAccess();
            }
        } finally {
            if (currentMutation.current === controller) currentMutation.current = null;
            mutating.current = false;
            if (mounted.current) { setBusy(false); setRefresh(value => value + 1); }
        }
    }

    async function submitPassword(event: React.FormEvent) {
        event.preventDefault();
        if (!connection || !worker || busy || connection.passwordPending) return;
        setBusy(true); setError('');
        const revision = generation.current;
        try {
            const ciphertext = await encryptTelegramPassword(password, worker.publicKeySpki, connection);
            setPassword('');
            if (passwordInput.current) passwordInput.current.value = '';
            if (!mounted.current || revision !== generation.current) { setBusy(false); return; }
            await mutate({ action: 'password', connectionId: connection.id, generation: connection.generation, challengeId: connection.challengeId, ciphertext });
        } catch (failure) {
            mutationError.current = true;
            setError(hostedEnabled ? 'Secure password delivery is unavailable. Refresh the connection and retry.' : failure instanceof Error ? failure.message : 'Secure password delivery failed.');
            setBusy(false);
        } finally {
            setPassword('');
            if (passwordInput.current) passwordInput.current.value = '';
        }
    }

    const displayedConnectionError = (code: string) => hostedEnabled ? hostedConnectionError(code) || connectionError(code) : connectionError(code);

    return <section className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <PageHeader eyebrow="Private workspace" title="Connect Telegram" description="Connect your account securely using Telegram on your phone."
            actions={<div className="flex flex-wrap gap-2"><Button asChild variant="outline"><Link href="/staff/telegram-intake/chats">Telegram chats</Link></Button><Button asChild variant="outline"><Link href="/staff/telegram-intake/context">Search conversations</Link></Button><Button asChild variant="outline"><Link href="/staff/telegram-intake">Back to draft inbox</Link></Button></div>} />
        {hostedEnabled ? <HostedConnectionPanel connection={connection ?? null} loaded={Boolean(snapshot)} disabled={busy || accessDenied} attemptRef={hostedAttempt} onDenied={denyAccess} onReset={() => setRefresh(value => value + 1)} onConnect={(workerId, signal) => mutate({ action: 'connect', workerId }, signal)} /> : <Card className="space-y-5 p-6">
            <div className="flex items-start gap-3"><Laptop className="mt-1 h-5 w-5 shrink-0" /><div><h2 className="font-semibold">Your Mac connector</h2><p className="mt-1 text-sm text-muted-foreground">Keep the registered connector running on your Mac during sign-in and while connected. Your Telegram session stays on that Mac.</p></div></div>
            {!snapshot && !error ? <p role="status">Loading connection…</p> : null}
            {snapshot && !active ? <div className="space-y-3">
                {snapshot.workers.length ? <><Label htmlFor="telegram-worker">Mac connector</Label><select id="telegram-worker" value={selectedWorker} onChange={event => setSelectedWorker(event.target.value)} disabled={busy || accessDenied} className="h-10 w-full rounded-lg border border-input bg-card px-3 text-sm">{snapshot.workers.map(item => <option key={item.id} value={item.id}>{item.name} — {item.online ? 'Online' : 'Offline'}</option>)}</select>
                    {!snapshot.workers.find(item => item.id === selectedWorker)?.online ? <p className="text-sm text-muted-foreground">This connector is offline. Start it on your Mac; this page will detect it automatically.</p> : null}
                    {workerChangeBlocked ? <p role="status" className="text-sm text-muted-foreground">Disconnect this account before choosing another Mac. Wait for logout confirmation, or select the original Mac to retry.</p> : null}
                    <Button onClick={() => { if (!workerChangeBlocked) void mutate({ action: 'connect', workerId: selectedWorker }); }} disabled={busy || accessDenied || workerChangeBlocked || !snapshot.workers.find(item => item.id === selectedWorker)?.online}>{busy ? 'Starting…' : connection ? 'Connect again' : 'Connect Telegram'}</Button></>
                    : <p className="text-sm text-muted-foreground">No Mac connector is available. Pair your Mac below, then start its Telegram connector.</p>}
            </div> : null}
            {active ? <div className="flex flex-wrap items-center gap-2 text-sm"><span>{worker?.name || 'Assigned Mac connector'}</span><Badge variant="secondary">{worker?.online ? 'Online' : 'Offline'}</Badge></div> : null}
            {active && !worker?.online ? <p role="status" className="text-sm text-muted-foreground">The Mac connector is offline. Keep it running to continue. If you need to revoke access now, use Telegram Settings → Devices.</p> : null}
        </Card>}
        {error ? <div role="alert" className="rounded-lg border border-border p-4 text-sm"><p>{error}</p><Button className="mt-3" variant="outline" disabled={busy} onClick={() => { mutationError.current = false; setAccessDenied(false); setRefresh(value => value + 1); }}><RefreshCw />Retry status</Button></div> : null}
        {connection ? <Card className="space-y-4 p-6" aria-busy={busy}>
            <div aria-live="polite">
                {connection.status === 'requested' ? <><h2 className="font-semibold">Preparing Telegram sign-in</h2><p className="mt-2 text-sm text-muted-foreground">{hostedEnabled ? 'The service is requesting a sign-in code. It will appear here automatically.' : 'Your Mac is requesting a sign-in code. It will appear here automatically.'}</p></> : null}
                {connection.status === 'qr_pending' ? <><h2 className="font-semibold">Scan with Telegram</h2><p className="mt-2 text-sm text-muted-foreground">On your phone, open Telegram → Settings → Devices → Link Desktop Device, then scan this code.</p></> : null}
                {connection.status === 'awaiting_password' ? <h2 className="font-semibold">Enter your Telegram password</h2> : null}
                {connection.status === 'connected' ? <><h2 className="flex items-center gap-2 font-semibold"><CheckCircle2 className="h-5 w-5" />Telegram connected</h2><p className="mt-2">{connection.profile?.displayName}</p>{connection.profile?.username ? <p className="text-sm text-muted-foreground">@{connection.profile.username}</p> : null}</> : null}
                {connection.status === 'disconnecting' ? <><h2 className="font-semibold">Waiting for Telegram to disconnect</h2><p className="mt-2 text-sm text-muted-foreground">{hostedEnabled ? 'Disconnect is pending until the connection service confirms Telegram logout and removes its saved session. If the service is offline, logout will continue when it returns.' : 'Disconnect is pending until your Mac confirms Telegram logout and removes its saved session. Keep the connector running.'}</p></> : null}
                {connection.status === 'disconnected' ? <><h2 className="font-semibold">{connection.retirementReason === 'external_revocation_attested' ? 'Telegram registration reset' : connection.cancelledBeforeStart ? 'Connection cancelled' : 'Telegram disconnected'}</h2><p className="mt-2 text-sm text-muted-foreground">{connection.retirementReason === 'external_revocation_attested' ? 'You confirmed the old session was revoked in Telegram Settings → Devices. The service registration has been retired; imported history remains available.' : connection.cancelledBeforeStart ? hostedEnabled ? 'Sign-in was cancelled before connecting.' : 'Sign-in was cancelled before your Mac started connecting.' : hostedEnabled ? 'The connection service confirmed logout and removed its saved session.' : 'Your Mac confirmed logout and removed its saved session.'}</p></> : null}
                {connection.status === 'failed' ? <h2 className="font-semibold">Telegram connection needs attention</h2> : null}
            </div>
            {connection.errorCode ? <p role="alert" className="text-sm">{displayedConnectionError(connection.errorCode)}</p> : null}
            {connection.status === 'qr_pending' ? <>{qrAvailable ? <canvas ref={canvas} role="img" aria-label="Telegram sign-in QR code" className="mx-auto rounded-lg" hidden={qrError} /> : null}{!qrAvailable || qrError ? <p role="status" className="text-sm text-muted-foreground">{qrError ? 'Unable to display the code. Refresh the status to try again.' : hostedEnabled ? 'This code expired. Waiting for a fresh sign-in code…' : 'This code expired. Waiting for a fresh code from your Mac…'}</p> : null}{qrError ? <Button variant="outline" onClick={() => setRefresh(value => value + 1)}>Refresh sign-in code</Button> : null}</> : null}
            {connection.status === 'awaiting_password' ? <form className="space-y-3" onSubmit={submitPassword}>
                <p className="text-sm text-muted-foreground">{hostedEnabled ? 'Telegram has two-step verification enabled. Your password is encrypted in this browser for your private Telegram connection.' : 'Telegram has two-step verification enabled. Your password is encrypted in this browser for your Mac connector.'}</p>
                {connection.passwordHint ? <p className="text-sm">Password hint: {connection.passwordHint}</p> : null}
                <Label htmlFor="telegram-password">Telegram two-step verification password</Label><Input ref={passwordInput} id="telegram-password" name="telegram-password" type="password" autoComplete="off" value={password} onChange={event => setPassword(event.target.value)} disabled={busy || accessDenied || connection.passwordPending || !worker?.online} required />
                <Button type="submit" disabled={busy || accessDenied || connection.passwordPending || !worker?.online || !password}>{busy || connection.passwordPending ? 'Checking password…' : 'Continue securely'}</Button>
            </form> : null}
            {(active || connection.status === 'failed') && connection.status !== 'disconnecting' ? <Button variant="outline" disabled={busy || accessDenied} onClick={() => { hostedAttempt.current?.abort(); setPassword(''); void mutate({ action: 'disconnect', connectionId: connection.id, generation: connection.generation }); }}>{['connected', 'failed'].includes(connection.status) ? 'Disconnect Telegram' : 'Cancel sign-in'}</Button> : null}
        </Card> : null}
        {connection?.status === 'connected' ? <Button asChild><Link href="/staff/telegram-intake/chats">Choose chats to import</Link></Button> : null}
        {!hostedEnabled ? <WorkerPairingPanel workspaceId={workspaceId} onDeviceChange={() => setRefresh(value => value + 1)} /> : null}
        <p className="text-sm text-muted-foreground">Connect your account, then choose chats to import their full available history. Drafts and source messages stay private; only approved candidate records become shared.</p>
    </section>;
}
