'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/staff-ui/badge';
import { Button } from '@/components/staff-ui/button';
import type { IntakeDraft } from '../intake-model';
import { activeCvStatus, cvGuidance, cvStatusLabel } from './cv-model';
import { cvEndpoint, cvRequest, CvRequestError } from './cv-api';

type Attachment = { extractionJobId: string; messageId: string; attachmentIndex: number; filename: string | null; mimeType: string | null; sizeBytes: number | null; eligible: boolean; reason: string | null };
type Job = { id: string; status: string; errorCode: string | null; attempts: number; availableAt: string; source: { filename: string }; completion: { draftVersion: number } | null; canRetry: boolean };
type Snapshot = { documentRevision: number; cv: { filename: string; status: string } | null; canRetrieve: boolean; connectionIssue: string | null; attachments: Attachment[]; jobs: Job[]; nextAfter: string | null };

export function CvRetrieval({ draft, busy: parentBusy, conflict, onDraft }: {
    draft: IntakeDraft; busy: boolean; conflict: boolean; onDraft: (draft: IntakeDraft) => void;
}) {
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
    const [updatedDraft, setUpdatedDraft] = useState<IntakeDraft | null>(null);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState<{ message: string; jobId: string; status: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(true);
    const [revision, setRevision] = useState(0);
    const [cursors, setCursors] = useState<string[]>(['']);
    const [denied, setDenied] = useState(false);
    const mutation = useRef(false);
    const stickyError = useRef(false);
    const read = useRef<AbortController | null>(null);
    const after = cursors[cursors.length - 1];
    const terminal = draft.status === 'approved' || draft.status === 'discarded';
    const active = snapshot?.jobs.find(job => activeCvStatus(job.status));
    const delay = active ? 2500 : 15000;
    useEffect(() => {
        if (updatedDraft && !parentBusy && !conflict) onDraft(updatedDraft);
    }, [updatedDraft, parentBusy, conflict, onDraft]);
    useEffect(() => {
        if (denied || terminal) return;
        let stopped = false; let timer: ReturnType<typeof setTimeout>; let cycle = 0;
        async function poll(version = cycle) {
            if (stopped || document.hidden || mutation.current) return;
            read.current?.abort(); const controller = new AbortController(); read.current = controller;
            try {
                const params = new URLSearchParams({ draftId: draft.id }); if (after) params.set('after', after);
                const result: Snapshot = await cvRequest(`${cvEndpoint}?${params}`, { signal: controller.signal });
                if (stopped || controller.signal.aborted) return;
                setSnapshot(result); if (!stickyError.current) setError('');
                if (result.documentRevision > (draft.documentRevision ?? 0) || result.jobs.some(job => (job.completion?.draftVersion ?? 0) > draft.version) || result.attachments.some(item => item.reason === 'DRAFT_CLOSED')) {
                    const body = await cvRequest(`/api/staff/telegram-intake/drafts/${encodeURIComponent(draft.id)}`, { signal: controller.signal });
                    if (!stopped && !controller.signal.aborted) setUpdatedDraft(body.result);
                }
            } catch (failure) {
                if (stopped || controller.signal.aborted) return;
                setError(failure instanceof Error ? failure.message : 'Unable to load CV retrieval status.');
                if (failure instanceof CvRequestError && [401, 403, 404].includes(failure.status)) { setDenied(true); setSnapshot(null); }
            } finally {
                if (!stopped && !controller.signal.aborted) setLoading(false);
                if (!stopped && version === cycle && !document.hidden) timer = setTimeout(() => void poll(version), delay);
            }
        }
        const visibility = () => { cycle += 1; clearTimeout(timer); if (document.hidden) read.current?.abort(); else void poll(); };
        void poll(); document.addEventListener('visibilitychange', visibility);
        return () => { stopped = true; clearTimeout(timer); read.current?.abort(); document.removeEventListener('visibilitychange', visibility); };
    }, [draft.id, draft.version, draft.documentRevision, terminal, after, revision, delay, denied]);
    function refresh() { stickyError.current = false; setDenied(false); setLoading(true); setRevision(value => value + 1); }
    async function act(body: Record<string, unknown>) {
        if (busy || parentBusy || terminal || (conflict && body.action !== 'cancel')) return;
        mutation.current = true; read.current?.abort(); stickyError.current = false;
        setBusy(true); setError(''); setNotice(null);
        try {
            const result = await cvRequest(cvEndpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
            setNotice({ jobId: result.job.id, status: result.job.status, message: body.action === 'cancel' ? 'Retrieval cancelled. This job can no longer attach a CV.' : body.action === 'retry' ? 'Retry requested for the same attachment.' : 'Retrieval requested. You can continue editing the profile while your Mac retrieves and validates the file.' });
        } catch (failure) { stickyError.current = true; setError(failure instanceof Error ? failure.message : 'Unable to update CV retrieval.'); }
        finally { mutation.current = false; setBusy(false); setLoading(true); setRevision(value => value + 1); }
    }
    if (terminal) return null;
    return <section aria-label="Retrieve CV from Telegram" className="space-y-4 border-t border-border pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-medium">Retrieve from Telegram</h4><Button variant="ghost" size="sm" disabled={busy} onClick={refresh}>Refresh retrieval</Button></div>
        <p className="text-xs text-muted-foreground">Choose the correct PDF or DOCX below. An attachment reference alone does not satisfy the CV requirement; retrieval and validation must finish first. Your Mac must be connected to the account that imported the conversation. You can also upload a CV manually above.</p>
        {error ? <p role="alert" className="text-sm">{error}</p> : null}
        {loading ? <p role="status" className="text-xs text-muted-foreground">Loading retrieval status…</p> : null}
        {snapshot?.cv ? <p className="text-sm">A CV is attached. Telegram retrieval will not replace it.</p> : snapshot?.connectionIssue && (snapshot.attachments.length > 0 || snapshot.jobs.length > 0) ? <p className="text-sm">{cvGuidance(snapshot.connectionIssue)} <Link className="underline underline-offset-4" href="/staff/telegram-intake/connect">Manage Telegram connection</Link></p> : null}
        {active ? <p className="text-xs text-muted-foreground">One file is being retrieved. Cancel it before choosing a different attachment.</p> : null}
        {snapshot?.attachments.map(item => <article key={`${item.extractionJobId}-${item.messageId}-${item.attachmentIndex}`} aria-label={`Telegram attachment ${item.filename || item.messageId}`} className="space-y-2 rounded-lg border border-border p-3">
            <p className="break-words text-sm font-medium">{item.filename || 'Unnamed attachment'} <Badge variant="outline">Attachment reference</Badge></p>
            <p className="text-xs text-muted-foreground">Message {item.messageId}{item.sizeBytes != null ? ` · ${item.sizeBytes.toLocaleString()} bytes` : ' · Size checked during retrieval'}{item.mimeType ? ` · ${item.mimeType}` : ''}</p>
            {item.reason ? <p className="text-xs text-muted-foreground">{cvGuidance(item.reason)}</p> : null}
            <Button variant="outline" size="sm" aria-label={`Retrieve CV: ${item.filename || 'Unnamed attachment'}`} disabled={busy || parentBusy || conflict || loading || denied || !!active || !snapshot.canRetrieve || !item.eligible} onClick={() => void act({ action: 'retrieve', draftId: draft.id, expectedDocumentRevision: snapshot.documentRevision, extractionJobId: item.extractionJobId, messageId: item.messageId, attachmentIndex: item.attachmentIndex })}>Retrieve CV</Button>
        </article>)}
        {snapshot && !snapshot.attachments.length && !loading ? <p className="text-xs text-muted-foreground">No referenced attachments on this page. You can upload the CV manually.</p> : null}
        {snapshot && (cursors.length > 1 || snapshot.nextAfter) ? <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-muted-foreground">Attachment page {cursors.length} · Up to 50 references</p><div className="flex gap-2"><Button variant="outline" size="sm" disabled={busy || loading || cursors.length === 1} onClick={() => { setCursors(stack => stack.slice(0, -1)); setLoading(true); }}>Previous attachments</Button><Button variant="outline" size="sm" disabled={busy || loading || !snapshot.nextAfter} onClick={() => { setCursors(stack => [...stack, snapshot.nextAfter!]); setLoading(true); }}>Next attachments</Button></div></div> : null}
        {snapshot?.jobs.length ? <div className="space-y-3"><h4 className="text-xs font-medium">Recent retrievals · Latest 20</h4>{snapshot.jobs.map(job => <article key={job.id} aria-label={`CV retrieval ${job.source.filename}`} className="space-y-2 border-t border-border pt-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="break-words text-sm">{job.source.filename}</p><Badge variant="secondary">{cvStatusLabel(job.status)}</Badge></div>{job.errorCode ? <p className="text-xs text-muted-foreground">{cvGuidance(job.errorCode)}</p> : null}{job.status === 'waiting' ? <p className="text-xs text-muted-foreground">Next attempt: {new Date(job.availableAt).toLocaleString()}</p> : null}{activeCvStatus(job.status) ? <Button variant="ghost" size="sm" disabled={busy || parentBusy} onClick={() => void act({ action: 'cancel', jobId: job.id })}>Cancel retrieval</Button> : job.canRetry ? <Button variant="outline" size="sm" disabled={busy || parentBusy || conflict || !!active || !!snapshot.cv} onClick={() => void act({ action: 'retry', jobId: job.id })}>Retry retrieval</Button> : null}</article>)}</div> : null}
        {notice && snapshot?.jobs.some(job => job.id === notice.jobId && job.status === notice.status) ? <p role="status" className="text-sm">{notice.message}</p> : null}
    </section>;
}
