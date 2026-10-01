'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/staff-ui/button';
import { cvEndpoint, cvRequest } from '../cv/cv-api';
import { cvGuidance } from '../cv/cv-model';
type Attachment = { messageId: string; attachmentIndex: number; filename: string | null; sizeBytes: number | null; eligible: boolean; reason: string | null; existingDraftIds: string[] };
type Snapshot = { sourceVersion: number; sourceAvailable: boolean; connectionIssue: string | null; attachments: Attachment[]; nextAfter: string | null };
export function BatchCvActions({ jobId, disabled }: { jobId: string; disabled: boolean }) {
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
    const [cursors, setCursors] = useState<string[]>(['']);
    const [revision, setRevision] = useState(0);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [created, setCreated] = useState<{ draftId: string; candidateId?: string } | null>(null);
    const operations = useRef<Record<string, string>>({});
    const after = cursors.at(-1)!;
    useEffect(() => {
        const controller = new AbortController();
        const params = new URLSearchParams({ extractionJobId: jobId }); if (after) params.set('after', after);
        cvRequest(`${cvEndpoint}?${params}`, { signal: controller.signal }).then(body => { if (!controller.signal.aborted) { setSnapshot(body.result ?? body); setError(''); } }).catch(failure => { if (!controller.signal.aborted) { setError(failure.message); setSnapshot(null); setCreated(null); } });
        return () => controller.abort();
    }, [jobId, after, revision]);
    async function create(item: Attachment) {
        if (!snapshot || busy || disabled || !item.eligible) return;
        setBusy(true); setError('');
        const key = `${item.messageId}:${item.attachmentIndex}:${snapshot.sourceVersion}`;
        try {
            const body = await cvRequest(cvEndpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'createDraft', extractionJobId: jobId, messageId: item.messageId, attachmentIndex: item.attachmentIndex, expectedSourceVersion: snapshot.sourceVersion, operationId: operations.current[key] ??= crypto.randomUUID() }) });
            setCreated(body.result ?? body); setRevision(value => value + 1);
        } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to create the draft. Refresh and try again.'); }
        finally { setBusy(false); }
    }
    return <section aria-label="Create draft from batch CV" className="space-y-3 border-t border-border pt-4">
        <h4 className="text-sm font-medium">Create a draft from a CV</h4>
        <p className="text-xs text-muted-foreground">Choose a CV to retrieve and analyze privately. Review the resulting profile before approval. The sender is not assumed to be the candidate.</p>
        {error ? <p role="alert" className="text-sm">{error}</p> : null}
        {snapshot?.connectionIssue ? <p className="text-xs">{cvGuidance(snapshot.connectionIssue)} <Link href="/staff/telegram-intake/connect" className="underline">Manage connection</Link></p> : null}
        {!snapshot && !error ? <p role="status" className="text-sm">Checking CV attachments…</p> : null}
        {snapshot && !snapshot.sourceAvailable ? <p className="text-xs">This batch’s source is no longer available.</p> : null}
        {snapshot?.attachments.map(item => <article key={`${item.messageId}:${item.attachmentIndex}`} className="space-y-2 rounded-lg border border-border p-3">
            <p className="break-words text-sm font-medium">{item.filename || 'Unnamed attachment'}</p><p className="text-xs text-muted-foreground">Message {item.messageId}{item.sizeBytes != null ? ` · ${item.sizeBytes.toLocaleString()} bytes` : ''}</p>
            {item.existingDraftIds.length ? <div className="flex flex-wrap gap-3">{item.existingDraftIds.map((id, index) => <Link key={id} className="text-sm underline" href={`/staff/telegram-intake?draft=${id}`}>Open linked draft{item.existingDraftIds.length > 1 ? ` ${index + 1}` : ''}</Link>)}</div> : <><p className="text-xs text-muted-foreground">{item.reason ? cvGuidance(item.reason) : 'The file must pass validation before it is attached.'}</p><Button variant="outline" size="sm" disabled={busy || disabled || !item.eligible} onClick={() => void create(item)}>Create candidate draft from this CV</Button></>}
        </article>)}
        {snapshot?.sourceAvailable && !snapshot.attachments.length ? <p className="text-xs text-muted-foreground">No CV attachments on this page.</p> : null}
        {created ? <p role="status" className="text-sm">Draft created. <Link className="underline" href={`/staff/telegram-intake?draft=${created.draftId}`}>Review draft and retrieval</Link>{created.candidateId ? <> · <Link className="underline" href={`/staff/candidates/${created.candidateId}`}>Open approved candidate</Link></> : null}</p> : null}
        <div className="flex flex-wrap gap-2"><Button variant="ghost" size="sm" disabled={busy} onClick={() => setRevision(value => value + 1)}>Refresh CV attachments</Button>{cursors.length > 1 ? <Button variant="outline" size="sm" disabled={busy} onClick={() => { setSnapshot(null); setCursors(value => value.slice(0, -1)); }}>Previous CV attachments</Button> : null}{snapshot?.nextAfter ? <Button variant="outline" size="sm" disabled={busy} onClick={() => { setCursors(value => [...value, snapshot.nextAfter!]); setSnapshot(null); }}>More CV attachments</Button> : null}</div>
    </section>;
}
