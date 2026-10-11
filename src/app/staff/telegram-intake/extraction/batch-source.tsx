'use client';

import { useCallback, useEffect, useState } from 'react';
import { BatchCvActions } from '../cv-analysis/batch-cv-actions';
import { Button } from '@/components/staff-ui/button';
import { extractionAccessLost, extractionEndpoint, extractionRequest } from './extraction-api';
import { staffAuthRecovery } from '@/lib/staff-auth-recovery';
import { StaffDate } from '../../staff-date';
import { StaffAuthRecoveryPrompt } from '../../auth-recovery';
import { createPrivateSnapshotGuard } from './private-snapshot-guard';
import { BatchSnapshot, BatchMessage, batchAuthor, primaryHasAttachments } from './batch-source-model';
import { canReleaseContext, retentionHolds, retentionLabel } from './retention-model';

export type SourceRetention = { version: number; state: 'kept' | 'release_pending' | 'purged'; requestedAt: string | null; purgedAt: string | null; holds: { openDrafts: number; pendingProposals: number; activeCv: number }; canRelease: boolean; canKeep: boolean };


export function BatchSource({ jobId, retention, disabled = false, onChanged }: { jobId: string; retention: SourceRetention; disabled?: boolean; onChanged: () => void }) {
    const [open, setOpen] = useState(false);
    const [source, setSource] = useState<BatchSnapshot | null>(null);
    const [updatedRetention, setUpdatedRetention] = useState<SourceRetention | null>(null);
    const [acknowledged, setAcknowledged] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [blocked, setBlocked] = useState(false);
    const [guard] = useState(() => createPrivateSnapshotGuard(staffAuthRecovery.requestEpoch));
    const [revision, setRevision] = useState(0);
    const current = updatedRetention && updatedRetention.version > retention.version ? updatedRetention : retention;
    const purged = current.state === 'purged';
    const loading = open && !purged && !source && !error;
    const clearPrivate = useCallback(() => {
        guard.invalidate(); setBlocked(true); setOpen(false); setSource(null); setUpdatedRetention(null);
        setAcknowledged(false); setBusy(false); setError(''); setNotice('');
    }, [guard]);
    useEffect(() => {
        const invalidate = () => clearPrivate();
        const retry = () => { guard.retry(); setBlocked(false); setOpen(true); setRevision(value => value + 1); };
        window.addEventListener('staff-session-invalidated', invalidate); window.addEventListener('staff-auth-retry', retry);
        return () => { guard.dispose(); window.removeEventListener('staff-session-invalidated', invalidate); window.removeEventListener('staff-auth-retry', retry); };
    }, [guard, clearPrivate]);
    useEffect(() => {
        if (!open || purged || blocked || document.hidden) return;
        const ticket = guard.begin('source'); if (!ticket) return;
        extractionRequest(`${extractionEndpoint}?jobId=${encodeURIComponent(jobId)}`, { signal: ticket.controller.signal })
            .then(result => { if (guard.accepts(ticket)) { setSource(result.source); setUpdatedRetention(result.sourceRetention); setError(''); staffAuthRecovery.accepted(ticket.epoch); } })
            .catch(failure => {
                if (!guard.accepts(ticket)) return;
                if (extractionAccessLost(failure, ticket.epoch)) { clearPrivate(); setError(failure instanceof Error ? failure.message : 'Private extraction access is unavailable.'); return; }
                setSource(null); setError(failure instanceof Error ? failure.message : 'Unable to load source messages.');
            });
        return () => ticket.controller.abort();
    }, [open, jobId, revision, purged, blocked, guard, clearPrivate]);
    useEffect(() => {
        const visible = () => { if (!document.hidden && open) setRevision(value => value + 1); };
        document.addEventListener('visibilitychange', visible);
        return () => document.removeEventListener('visibilitychange', visible);
    }, [open]);
    async function decide(mode: 'keep' | 'release_after_review') {
        if (busy || disabled || purged || blocked) return;
        if (mode === 'release_after_review' && !canReleaseContext({ retention: current, sourceLoaded: !!source, acknowledged, busy: loading })) return;
        const ticket = guard.begin('action'); if (!ticket) return;
        setBusy(true); setError(''); setNotice('');
        try {
            const result = await extractionRequest(extractionEndpoint, { method: 'POST', signal: ticket.controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'sourceRetention', jobId, expectedSourceVersion: current.version, mode }) });
            if (!guard.accepts(ticket)) return;
            setUpdatedRetention(result.sourceRetention); setAcknowledged(false);
            setNotice(mode === 'keep' ? 'Context will be kept.' : 'Release requested. Source messages stay until review holds are resolved and cleanup runs.');
        } catch (failure) {
            if (!guard.accepts(ticket)) return;
            if (extractionAccessLost(failure, ticket.epoch)) { clearPrivate(); setError(failure instanceof Error ? failure.message : 'Private extraction access is unavailable.'); return; }
            setAcknowledged(false); setError(failure instanceof Error ? failure.message : 'Unable to update source retention.');
        } finally { if (guard.accepts(ticket)) { setBusy(false); onChanged(); } }
    }
    function messageView(message: BatchMessage) {
        return <article key={message.messageId} className="space-y-2 border-t border-border pt-3">
            <p className="break-words text-xs text-muted-foreground">{batchAuthor(message)} · Message {message.messageId}{message.sentAt ? <> · <StaffDate value={message.sentAt} kind="timestamp" /></> : null}</p>
            {message.forwardedFrom ? <p className="text-xs text-muted-foreground">Forwarded from: {message.forwardedFrom.displayName || 'Original source unavailable'}</p> : null}
            <p className="whitespace-pre-wrap break-words text-sm">{message.kind === 'unavailable' ? 'This message is unavailable. This does not confirm a Telegram deletion.' : message.text || 'No text in this message.'}</p>
            {message.attachments.length ? <ul className="space-y-1 text-xs text-muted-foreground">{message.attachments.map((item, index) => <li key={index} className="break-words">{item.filename || item.kind} · Metadata only</li>)}</ul> : null}
        </article>;
    }
    const holds = retentionHolds(current.holds);
    return <div className="space-y-3">
        <StaffAuthRecoveryPrompt />
        <p className="text-sm font-medium">{retentionLabel(current)}</p>
        {current.state === 'release_pending' ? <p className="text-xs text-muted-foreground">{holds ? `Waiting for: ${holds}.` : 'Review holds are resolved. Waiting for scheduled cleanup.'}</p> : null}
        {purged ? <p className="text-xs text-muted-foreground">You chose to release this batch after review. Its private source messages and quotes have been deleted; reviewed profiles and CV files are retained.</p> : <Button variant="ghost" size="sm" aria-expanded={open} disabled={busy || blocked} onClick={() => { setError(''); setOpen(value => !value); setSource(null); setAcknowledged(false); }}>{open ? 'Hide source messages' : 'Review source messages'}</Button>}
        {open && !purged ? <section aria-label="Private batch source" className="space-y-4 rounded-lg border border-border p-4">
            <p className="text-xs text-muted-foreground">Review the entire batch, including candidate, job, client and lead information. Attachments here are metadata only; their files were not read.</p>
            {loading ? <p role="status" className="text-sm">Loading source messages…</p> : null}
            {source ? <h3 className="text-sm font-medium">Primary source messages</h3> : null}
            {source?.messages.map(messageView)}
            {source?.contextOnly?.length ? <section aria-label="Background conversation context" className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
                <h3 className="text-sm font-medium">Background conversation context</h3>
                <p className="text-xs text-muted-foreground">These earlier messages keep their original authors and only help clarify replies. They cannot supply standalone candidate facts, candidate identities, evidence quotes or CV attachments. Verify candidate facts against the primary messages above.</p>
                {source.contextOnly.map(messageView)}
            </section> : null}
            {source && !source.messages.length ? <p className="text-sm">No messages are available in this batch snapshot.</p> : null}
            {primaryHasAttachments(source) ? <BatchCvActions jobId={jobId} disabled={busy || disabled} /> : null}
            {current.canRelease || current.canKeep ? <div className="space-y-3 border-t border-border pt-4">
                <p className="text-sm">Keep context unless you have reviewed all of it and no longer need the remaining information.</p>
                {holds ? <p className="text-xs text-muted-foreground">Review holds: {holds}. A release request waits for these to finish.</p> : null}
                {current.canRelease ? <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={acknowledged} disabled={busy || disabled || loading || !source} onChange={event => setAcknowledged(event.target.checked)} className="mt-1" />I reviewed the entire batch and no longer need its remaining context.</label> : null}
                <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={busy || disabled || !current.canKeep || current.state === 'kept'} onClick={() => void decide('keep')}>Keep context</Button>{current.canRelease ? <Button variant="outline" size="sm" disabled={!canReleaseContext({ retention: current, sourceLoaded: !!source, acknowledged, busy: busy || disabled || loading })} onClick={() => void decide('release_after_review')}>Release after candidate review</Button> : null}</div>
                <p className="text-xs text-muted-foreground">Release deletes this batch’s private messages and source quotes after review holds finish and cleanup runs. Reviewed profiles and CV files stay. Keep context can withdraw a pending release; deleted messages cannot be restored here.</p>
            </div> : null}
        </section> : null}
        {error ? <div role="alert" className="space-y-2 text-sm"><p>{error}</p><Button variant="outline" size="sm" disabled={busy || blocked} onClick={() => { setSource(null); setError(''); setRevision(value => value + 1); onChanged(); }}>Refresh source status</Button></div> : null}
        {notice ? <p role="status" className="text-xs">{notice}</p> : null}
    </div>;
}
