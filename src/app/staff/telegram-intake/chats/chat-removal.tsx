'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/staff-ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/staff-ui/dialog';
import { removalError, removalPending, removalStatus, removalPayload, removalOperation } from './removal-model';

type State = 'none' | 'pending' | 'device_pending' | 'completed';
export type RemovalReceipt = {
    id: string;
    state: State;
    totalMessages: number;
    removedMessages: number;
    serverPurged: boolean;
    deviceCleanupPending: boolean;
    storageCleanupPending: boolean;
};
type Preview = {
    chatId: string;
    title: string;
    version: number;
    state: State;
    messages: number;
    bytes: number;
    unapprovedDrafts: number;
    approvedCandidates: number;
};
const endpoint = '/api/staff/telegram-removal';

export function ChatRemoval({ chatId, title, state = 'none', receipt, disabled, accessBlocked, connected, onChanged, onDenied }: {
    chatId: string;
    title: string;
    state?: State;
    receipt?: RemovalReceipt | null;
    disabled: boolean;
    accessBlocked: boolean;
    connected: boolean;
    onChanged: () => void;
    onDenied: () => void;
}) {
    const [open, setOpen] = useState(false);
    const [mode, setMode] = useState<'request' | 'reimport'>('request');
    const [preview, setPreview] = useState<Preview | null>(null);
    const [acknowledged, setAcknowledged] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const operation = useRef<{ intent: string; operationId: string } | null>(null);
    const read = useRef<AbortController | null>(null);
    const revision = useRef(0);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        const invalidate = () => {
            revision.current += 1;
            read.current?.abort();
            setPreview(null);
            setOpen(false);
            setAcknowledged(false);
        };
        window.addEventListener('staff-session-invalidated', invalidate);
        return () => {
            mounted.current = false;
            read.current?.abort();
            window.removeEventListener('staff-session-invalidated', invalidate);
        };
    }, []);
    useEffect(() => {
        if (accessBlocked) {
            revision.current += 1;
            read.current?.abort();
            // Discard private preview content immediately when workspace access is lost.
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setPreview(null);
            setOpen(false);
        }
    }, [accessBlocked]);
    async function request(payload: Record<string, unknown>, signal: AbortSignal) {
        const response = await fetch(endpoint, {
            method: 'POST',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            signal,
        });
        if (!response.ok) {
            if ([401, 403, 428].includes(response.status)) onDenied();
            throw new Error(removalError(response.status));
        }
        return response.json();
    }
    async function loadPreview(nextMode = mode) {
        if (accessBlocked || busy) return;
        read.current?.abort();
        const controller = new AbortController();
        read.current = controller;
        const version = ++revision.current;
        setMode(nextMode);
        setOpen(true);
        setPreview(null);
        setAcknowledged(false);
        setBusy(true);
        setError('');
        try {
            const data = await request({ action: 'preview', chatId }, controller.signal);
            if (mounted.current && version === revision.current && !controller.signal.aborted) {
                operation.current = removalOperation(operation.current, nextMode, data);
                setPreview(data);
            }
        } catch (failure) {
            if (mounted.current && version === revision.current && !controller.signal.aborted) {
                setError(failure instanceof Error ? failure.message : 'Unable to load removal details.');
            }
        } finally {
            if (mounted.current && version === revision.current) setBusy(false);
        }
    }
    async function confirm() {
        if (!preview || !acknowledged || busy || disabled || accessBlocked || removalPending(preview.state) || (mode === 'reimport' && (!connected || preview.state !== 'completed'))) return;
        const controller = new AbortController();
        read.current = controller;
        const version = ++revision.current;
        operation.current = removalOperation(operation.current, mode, preview);
        setBusy(true);
        setError('');
        try {
            await request(removalPayload({
                mode, preview, acknowledged, connected, operationId: operation.current.operationId,
            }), controller.signal);
            if (mounted.current && version === revision.current && !controller.signal.aborted) {
                operation.current = null;
                setOpen(false);
                setPreview(null);
                onChanged();
            }
        } catch (failure) {
            if (mounted.current && version === revision.current && !controller.signal.aborted) {
                setError(failure instanceof Error ? failure.message : 'Unable to confirm this action.');
                onChanged();
            }
        } finally {
            if (mounted.current && version === revision.current) setBusy(false);
        }
    }
    const status = removalStatus(state, receipt);
    const confirmDisabled = busy || disabled || accessBlocked || !acknowledged || !preview
        || removalPending(preview.state)
        || (mode === 'reimport' && (!connected || preview.state !== 'completed'))
        || (mode === 'request' && preview.state === 'completed');

    function changeOpen(next: boolean) {
        if (busy) return;
        setOpen(next);
        if (!next) {
            read.current?.abort();
            setPreview(null);
            setAcknowledged(false);
        }
    }

    return <div className="space-y-2">
        {status ? <p role="status" className="max-w-sm text-xs text-muted-foreground">
            {status}
            {removalPending(state) && receipt
                ? ` ${receipt.removedMessages.toLocaleString()} of ${receipt.totalMessages.toLocaleString()} messages removed.`
                : ''}
        </p> : null}
        {state === 'completed' ? <>
            <Button size="sm" variant="outline" disabled={disabled || accessBlocked || !connected || busy}
                onClick={() => void loadPreview('reimport')}>
                Import history again
            </Button>
            {!connected ? <p className="text-xs text-muted-foreground">
                Reconnect the same Telegram account to import this chat again.
            </p> : null}
        </> : <Button size="sm" variant="ghost"
            disabled={disabled || accessBlocked || busy || removalPending(state)}
            onClick={() => void loadPreview('request')}>
            Remove imported history
        </Button>}
        <Dialog open={open} onOpenChange={changeOpen}>
            <DialogContent className="max-h-[90dvh] overflow-y-auto">
                <DialogTitle>{mode === 'reimport' ? 'Import history again' : 'Remove imported history'}</DialogTitle>
                <DialogDescription>
                    {title || 'Untitled chat'}. {mode === 'reimport'
                        ? 'Import this chat’s available history again and resume ongoing sync.'
                        : 'Review what will be removed from your private workspace.'}
                </DialogDescription>
                {busy ? <p role="status">{preview ? 'Submitting your request…' : 'Loading removal details…'}</p> : null}
                {error ? <p role="alert" className="text-sm">{error}</p> : null}
                {preview ? <div className="space-y-3 text-sm">
                    {mode === 'request' ? <>
                        <p>{preview.messages.toLocaleString()} imported messages and {preview.unapprovedDrafts.toLocaleString()} unapproved drafts will be removed, together with their copied source context and private analysis.</p>
                        <p>{preview.approvedCandidates.toLocaleString()} approved candidate profiles, reviewed CV text and documents are kept and managed separately. Messages in Telegram stay unchanged.</p>
                        <p>Imports and sync stop immediately. Removal completes after server, connector and private file cleanup are confirmed. You can request a fresh import after removal completes.</p>
                    </> : <p>A fresh import requires the same account to be connected. New history and private drafts will use your workspace storage again.</p>}
                    {removalPending(preview.state)
                        ? <p role="status">Removal is already in progress. Close this dialog to view its status.</p>
                        : <label className="flex items-start gap-2">
                            <input type="checkbox" checked={acknowledged}
                                onChange={event => setAcknowledged(event.target.checked)} disabled={busy}
                                className="mt-1 h-4 w-4 accent-primary" />
                            <span>{mode === 'reimport'
                                ? 'I want to import this chat again and resume sync.'
                                : 'I understand that this removes imported history and unapproved drafts from my workspace.'}</span>
                        </label>}
                    <Button disabled={confirmDisabled} onClick={() => void confirm()}>
                        {mode === 'reimport' ? 'Confirm fresh import' : 'Confirm removal'}
                    </Button>
                </div> : null}
                {!busy ? <Button variant="outline" onClick={() => void loadPreview()}>Refresh details</Button> : null}
            </DialogContent>
        </Dialog>
    </div>;
}
