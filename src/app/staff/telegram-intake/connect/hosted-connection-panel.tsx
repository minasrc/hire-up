'use client';

import { staffWorkspaceFetch } from '@/lib/staff-workspace-fetch';

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import Link from 'next/link';
import { Cloud, RefreshCw } from 'lucide-react';
import { Button } from '@/components/staff-ui/button';
import { Card } from '@/components/staff-ui/card';
import { hostedStatus, prepareHostedConnection, hostedRequestError, hostedEmergencyLogout, hostedRetirementInput, retirementMessage } from './hosted-connection-model';

type Enrollment = { requestId: string; workerId: string | null; retirementMode: 'safe' | 'external_revocation_required' };
type Status = { enrollment?: Enrollment | null; serviceOnline: boolean; state: string; workerId: string | null; workerOnline: boolean; errorCode: string | null };
const endpoint = '/api/staff/telegram-hosted';

function waitForPoll(signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const cleanup = () => { clearTimeout(timer); document.removeEventListener('visibilitychange', visible); signal.removeEventListener('abort', aborted); };
        const aborted = () => { cleanup(); reject(signal.reason); };
        const visible = () => {
            clearTimeout(timer);
            if (!document.hidden) timer = setTimeout(() => { cleanup(); resolve(); }, 2000);
        };
        signal.addEventListener('abort', aborted, { once: true });
        document.addEventListener('visibilitychange', visible);
        if (signal.aborted) aborted();
        else visible();
    });
}

export function HostedConnectionPanel({ connection, loaded, disabled, attemptRef, onDenied, onConnect, onReset }: {
    connection: { workerId: string; status: string } | null;
    loaded: boolean;
    disabled: boolean;
    attemptRef: MutableRefObject<AbortController | null>;
    onDenied: () => void;
    onReset: () => void;
    onConnect: (workerId: string, signal: AbortSignal) => Promise<void>;
}) {
    const [status, setStatus] = useState<Status | null>(null);
    const [error, setError] = useState('');
    const [phase, setPhase] = useState<'idle' | 'preparing' | 'starting' | 'retiring'>('idle');
    const [revoked, setRevoked] = useState(false);
    const [resetNotice, setResetNotice] = useState('');
    const retirementAttempt = useRef<ReturnType<typeof hostedRetirementInput> | null>(null);
    const [refresh, setRefresh] = useState(0);
    const statusRead = useRef<AbortController | null>(null);
    const mounted = useRef(true);
    const actionError = useRef(false);
    const busy = phase !== 'idle';
    const active = connection && !['failed', 'disconnected'].includes(connection.status);
    const blocked = connection && connection.status !== 'disconnected' && connection.workerId !== status?.workerId;

    const request = useCallback(async (signal: AbortSignal, prepare = false) => {
        const response = await staffWorkspaceFetch(endpoint, { cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
            ...(prepare ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'prepare' }) } : {}),
        });
        signal.throwIfAborted();
        if (!response.ok) {
            if ([401, 403, 404, 428].includes(response.status)) onDenied();
            throw new Error(hostedRequestError(response.status, await response.json().catch(() => null)));
        }
        return hostedStatus(await response.json());
    }, [onDenied]);

    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; attemptRef.current?.abort(); statusRead.current?.abort(); };
    }, [attemptRef]);
    useEffect(() => {
        if (disabled || busy) return;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout>;
        let cycle = 0;
        const poll = async (version = cycle) => {
            if (document.hidden) return;
            statusRead.current?.abort();
            const controller = new AbortController();
            statusRead.current = controller;
            try {
                const result = await request(controller.signal);
                if (!stopped && !controller.signal.aborted && version === cycle) { setStatus(result); if (!actionError.current || (result.state === 'ready' && result.serviceOnline && result.workerOnline)) { actionError.current = false; setError(''); } }
            } catch (failure) {
                if (!stopped && !controller.signal.aborted && version === cycle) {
                    setStatus(null);
                    setError(failure instanceof Error ? failure.message : 'Telegram service status is unavailable. Retry shortly.');
                }
            }
            if (!stopped && version === cycle && !document.hidden) timer = setTimeout(() => void poll(version), 10000);
        };
        const visibility = () => { cycle += 1; clearTimeout(timer); statusRead.current?.abort(); if (!document.hidden) void poll(); };
        void poll();
        document.addEventListener('visibilitychange', visibility);
        return () => { stopped = true; clearTimeout(timer); statusRead.current?.abort(); document.removeEventListener('visibilitychange', visibility); };
    }, [disabled, busy, refresh, request]);

    async function connect() {
        if (attemptRef.current || disabled || active || blocked || !loaded) return;
        statusRead.current?.abort();
        const controller = new AbortController();
        attemptRef.current = controller;
        setPhase('preparing'); actionError.current = false; setError('');
        try {
            await prepareHostedConnection({
                signal: controller.signal, visible: () => !document.hidden,
                prepare: signal => request(signal, true), read: signal => request(signal), wait: waitForPoll,
                onStatus: next => { if (mounted.current && !controller.signal.aborted) setStatus(next); },
                start: async (workerId, signal) => {
                    signal.throwIfAborted();
                    setPhase('starting');
                    await onConnect(workerId, signal);
                },
            });
        } catch (failure) {
            if (mounted.current && !controller.signal.aborted) { actionError.current = true; setError(failure instanceof Error ? failure.message : 'Telegram setup could not be completed. Retry shortly.'); }
        } finally {
            if (attemptRef.current === controller) attemptRef.current = null;
            if (mounted.current) setPhase('idle');
        }
    }

    async function retire() {
        if (disabled || busy || attemptRef.current || !status?.enrollment) return;
        const enrollment = status.enrollment;
        const previous = retirementAttempt.current;
        let input;
        try {
            input = hostedRetirementInput(enrollment, revoked, previous?.requestId === enrollment.requestId
                && previous?.expectedWorkerId === enrollment.workerId && previous?.telegramRevoked === revoked
                ? previous.operationId : crypto.randomUUID());
        } catch (failure) { setError(failure instanceof Error ? failure.message : 'Reset is unavailable.'); return; }
        retirementAttempt.current = input;
        const controller = new AbortController(); attemptRef.current = controller;
        statusRead.current?.abort(); setPhase('retiring'); setError(''); setResetNotice(''); actionError.current = false;
        try {
            const response = await staffWorkspaceFetch(endpoint, { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
            const result = await response.json().catch(() => null); controller.signal.throwIfAborted();
            if (!response.ok) { if ([401,403,428].includes(response.status)) onDenied(); throw new Error(hostedRequestError(response.status, result)); }
            if (result?.ok !== true || result.retiredRequestId !== enrollment.requestId
                || !['never_registered','cancelled_before_start','remote_logout','external_revocation_attested'].includes(result.retirementReason)) throw new Error('Reset acknowledgement is unavailable. Refresh the service status before retrying.');
            if (mounted.current) { setResetNotice(retirementMessage(result.retirementReason)); setRevoked(false); setStatus(null); retirementAttempt.current = null; onReset(); setRefresh(value => value + 1); }
        } catch (failure) {
            if (mounted.current && !controller.signal.aborted) { actionError.current = true; setError(failure instanceof Error ? failure.message : 'Registration reset could not be completed.'); }
        } finally { if (attemptRef.current === controller) attemptRef.current = null; if (mounted.current) setPhase('idle'); }
    }

    return <Card className="space-y-4 p-6" aria-busy={busy}>
        <div className="flex items-start gap-3"><Cloud className="mt-1 h-5 w-5 shrink-0" /><div><h2 className="font-semibold">Hosted Telegram connection</h2><p className="mt-1 text-sm text-muted-foreground">Connect here, then scan the sign-in code with Telegram on your phone. The service keeps your connection running.</p></div></div>
        {!status && !error ? <p role="status">Checking Telegram service…</p> : null}
        {status && (!status.serviceOnline || status.state === 'unavailable') ? <p role="status">The Telegram service is temporarily offline or unavailable. Your imported history remains available.</p> : null}
        {status?.serviceOnline && status.state !== 'unavailable' ? <p role="status">{busy ? phase === 'starting' ? 'Starting Telegram sign-in…' : 'Preparing your Telegram connection…' : status.workerOnline && status.state === 'ready' ? 'Telegram service available.' : active ? 'Your Telegram connection is waiting for the service. Your imported history remains available.' : status.state === 'pending' ? 'Telegram setup is pending. Click Connect Telegram to continue when you are ready.' : 'Telegram service available. Click Connect Telegram to begin.'}</p> : null}
        {hostedEmergencyLogout(connection, status) ? <p role="status" className="text-sm text-muted-foreground">To revoke access immediately, open Telegram on your phone → Settings → Devices and terminate this session. Imported history stays in your private workspace.</p> : null}
        {blocked ? <p role="status">This account has an existing connection. Disconnect it below and wait for logout confirmation before starting a hosted connection.</p> : null}
        {!active ? <Button onClick={() => void connect()} disabled={disabled || busy || !loaded || Boolean(blocked) || !status?.serviceOnline || status.state === 'unavailable'}>{busy ? 'Preparing…' : connection ? 'Connect again' : 'Connect Telegram'}</Button> : null}
        {phase === 'preparing' ? <Button variant="outline" onClick={() => { attemptRef.current?.abort(); actionError.current = true; setError('Setup cancelled. Click Connect Telegram when you are ready.'); }}>Cancel setup</Button> : null}
        {status?.enrollment ? <details className="space-y-3 rounded-md border p-3">
            <summary className="cursor-pointer text-sm font-medium">Reset a lost or revoked connection registration</summary>
            <p className="text-sm text-muted-foreground">Reset retires this registration and frees its connection slot. Your imported history stays available. A replacement starts only when you click Connect Telegram.</p>
            {status.enrollment.retirementMode === 'external_revocation_required' ? <>
                <p className="text-sm">First open Telegram → Settings → Devices. Terminate the old service session, or verify that it is already gone. The website cannot confirm this step for a lost connection.</p>
                <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={revoked} onChange={event => setRevoked(event.target.checked)} disabled={busy || disabled} /><span>I revoked the old session, or verified it is absent, in Telegram Settings → Devices.</span></label>
            </> : <p className="text-sm text-muted-foreground">This registration has no issued worker credential or the server has recorded logout/cancellation. No external revocation confirmation is required.</p>}
            <Button variant="outline" disabled={disabled || busy || (status.enrollment.retirementMode === 'external_revocation_required' && !revoked)} onClick={() => void retire()}>{phase === 'retiring' ? 'Resetting registration…' : 'Reset registration'}</Button>
        </details> : null}
        {resetNotice ? <p role="status" className="text-sm">{resetNotice}</p> : null}
        {error ? <p role="alert" className="text-sm">{error}</p> : null}
        <div className="flex flex-wrap gap-3"><Button variant="outline" disabled={busy || disabled} onClick={() => setRefresh(value => value + 1)}><RefreshCw />Retry service status</Button><Button asChild variant="outline"><Link href="/staff/telegram-intake/context">Search imported conversations</Link></Button></div>
    </Card>;
}
