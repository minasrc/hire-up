'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { RefreshCw } from 'lucide-react';
import { PageHeader } from '@/components/staff-preview/shared';
import { Badge } from '@/components/staff-ui/badge';
import { Button } from '@/components/staff-ui/button';
import { Card } from '@/components/staff-ui/card';
import { ExtractionError, extractionAccessLost, extractionEndpoint, extractionRequest } from './extraction-api';
import { staffAuthRecovery } from '@/lib/staff-auth-recovery';
import { StaffAuthRecoveryPrompt } from '../../auth-recovery';
import { createPrivateSnapshotGuard } from './private-snapshot-guard';
import { BatchSource, type SourceRetention } from './batch-source';
import { extractionGuidance, extractionStatus } from './extraction-model';
import { StaffDate } from '../../staff-date';

type Job = { schemaVersion?: string; id: string; chatId: string; chatTitle: string; status: string; messageCount: number; attempts: number; errorCode: string | null; availableAt: string; createdAt: string; completedAt: string | null; reviewedAt: string | null; draftIds: string[]; extractionEnabled: boolean; sourceRetention: SourceRetention };
type Snapshot = { contextEnabled?: boolean; counts: { queued: number; leased: number; waiting: number; failed: number; completed: number; needsReview: number; contextKept: number; releasePending: number; purged: number }; jobs: Job[]; nextAfter: string | null };
const dateLabel = (date: string) => <StaffDate value={date} kind="timestamp" />;

export function ExtractionQueueBrowser() {
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
    const [view, setView] = useState('all');
    const [cursors, setCursors] = useState<string[]>(['']);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [denied, setDenied] = useState(false);
    const [revision, setRevision] = useState(0);
    const mutating = useRef(false);
    const stickyError = useRef(false);
    const mounted = useRef(true);
    const [guard] = useState(() => createPrivateSnapshotGuard(staffAuthRecovery.requestEpoch));
    const after = cursors[cursors.length - 1];
    const delay = snapshot && snapshot.counts.queued + snapshot.counts.leased + snapshot.counts.waiting > 0 ? 3000 : 15000;
    const clearPrivate = useCallback(() => {
        guard.invalidate(); setSnapshot(null); setNotice(''); setError(''); setCursors(['']); setDenied(true); setLoading(false); setBusy(false); mutating.current = false;
    }, [guard]);
    const load = useCallback(async () => {
        if (mutating.current || document.hidden) return;
        const ticket = guard.begin('read'); if (!ticket) return;
        try {
            const params = new URLSearchParams({ view }); if (after) params.set('after', after);
            const result = await extractionRequest(`${extractionEndpoint}?${params}`, { signal: ticket.controller.signal });
            if (!guard.accepts(ticket) || !mounted.current) return;
            setSnapshot(result); setLoading(false); if (!stickyError.current) setError(''); staffAuthRecovery.accepted(ticket.epoch);
        } catch (failure) {
            if (!guard.accepts(ticket) || !mounted.current) return;
            if (extractionAccessLost(failure, ticket.epoch)) { clearPrivate(); setError(failure instanceof Error ? failure.message : 'Private extraction access is unavailable.'); return; }
            setError(failure instanceof Error ? failure.message : 'Unable to load extraction progress.');
            if (failure instanceof ExtractionError && failure.status === 404) { setDenied(true); setSnapshot(null); }
        } finally { if (guard.accepts(ticket) && mounted.current) setLoading(false); }
    }, [view, after, guard, clearPrivate]);
    useEffect(() => {
        mounted.current = true;
        const invalidate = () => clearPrivate();
        const retry = () => { guard.retry(); stickyError.current = false; setDenied(false); setCursors(['']); setError(''); setLoading(true); setRevision(value => value + 1); };
        window.addEventListener('staff-session-invalidated', invalidate); window.addEventListener('staff-auth-retry', retry);
        return () => { mounted.current = false; guard.dispose(); window.removeEventListener('staff-session-invalidated', invalidate); window.removeEventListener('staff-auth-retry', retry); };
    }, [guard, clearPrivate]);
    useEffect(() => {
        if (denied) return;
        let timer: ReturnType<typeof setTimeout>; let stopped = false; let cycle = 0;
        const poll = async (version = cycle) => { await load(); if (!stopped && version === cycle && !document.hidden) timer = setTimeout(() => void poll(version), delay); };
        const visibility = () => { cycle += 1; clearTimeout(timer); if (document.hidden) guard.abort('read'); else void poll(); };
        void poll(); document.addEventListener('visibilitychange', visibility);
        return () => { stopped = true; clearTimeout(timer); guard.abort('read'); document.removeEventListener('visibilitychange', visibility); };
    }, [load, denied, delay, revision, guard]);
    function refresh() { if (denied) return; stickyError.current = false; setLoading(true); setRevision(value => value + 1); }
    async function act(job: Job, action: 'retry') {
        if (busy || denied) return;
        const ticket = guard.begin('action'); if (!ticket) return;
        mutating.current = true; guard.abort('read'); stickyError.current = false;
        setBusy(true); setError(''); setNotice('');
        try {
            await extractionRequest(extractionEndpoint, { method: 'POST', signal: ticket.controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, jobId: job.id }) });
            if (guard.accepts(ticket) && mounted.current) setNotice('Retry requested with the same source messages.');
        } catch (failure) {
            if (!guard.accepts(ticket) || !mounted.current) return;
            if (extractionAccessLost(failure, ticket.epoch)) { clearPrivate(); setError(failure instanceof Error ? failure.message : 'Private extraction access is unavailable.'); return; }
            stickyError.current = true; setError(failure instanceof Error ? failure.message : 'Unable to update this batch.');
        } finally { if (guard.accepts(ticket) && mounted.current) { mutating.current = false; setBusy(false); setLoading(true); setRevision(value => value + 1); } }
    }
    return <section className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <PageHeader eyebrow="Private workspace" title="Candidate extraction" description="Track evidence-backed candidate drafts from your imported Telegram messages."
            actions={<div className="flex flex-wrap gap-2"><Button asChild variant="outline"><Link href="/staff/telegram-intake/chats">Telegram chats</Link></Button><Button asChild variant="outline"><Link href="/staff/telegram-intake">Draft inbox</Link></Button><Button variant="outline" disabled={busy || loading || denied} onClick={refresh}><RefreshCw />Refresh progress</Button></div>} />
        <p className="text-sm text-muted-foreground">Start automatic extraction for selected chats. Keep your Mac extraction worker running; Telegram can be disconnected while imported text is processed.</p>
        <StaffAuthRecoveryPrompt />
        {snapshot ? <div className="grid gap-3 sm:grid-cols-3"><Card className="p-4"><p className="text-2xl font-semibold">{snapshot.counts.queued + snapshot.counts.leased + snapshot.counts.waiting}</p><p className="text-sm text-muted-foreground">Queued, running or waiting</p></Card><Card className="p-4"><p className="text-2xl font-semibold">{snapshot.counts.failed}</p><p className="text-sm text-muted-foreground">Need attention</p></Card><Card className="p-4"><p className="text-2xl font-semibold">{snapshot.counts.needsReview}</p><p className="text-sm text-muted-foreground">Batches awaiting your review</p></Card></div> : null}
        {snapshot ? <p className="text-xs text-muted-foreground">Context kept: {snapshot.counts.contextKept} · Release pending: {snapshot.counts.releasePending} · Sources deleted: {snapshot.counts.purged}</p> : null}
        <nav aria-label="Extraction views" className="flex gap-2">{[['all', 'All batches'], ['needs_review', 'Needs review']].map(([key, label]) => <Button key={key} variant={view === key ? 'secondary' : 'ghost'} aria-pressed={view === key} disabled={busy || denied} onClick={() => { setView(key); setCursors(['']); setLoading(true); setRevision(value => value + 1); }}>{label}</Button>)}</nav>
        {error ? <div role="alert" className="space-y-3 rounded-lg border border-border p-4 text-sm"><p>{error}</p><Button variant="outline" size="sm" disabled={busy || denied} onClick={refresh}>Retry status</Button></div> : null}
        {loading ? <p role="status" className="text-sm text-muted-foreground">Loading extraction progress…</p> : null}
        {snapshot && !loading && !snapshot.jobs.length ? <Card className="p-8 text-center"><h2 className="font-medium">No batches in this view</h2><p className="mt-2 text-sm text-muted-foreground">Start extraction from imported chats, or choose another view.</p></Card> : null}
        <div className="space-y-4" aria-busy={loading || busy}>{snapshot?.jobs.map(job => <Card key={job.id} className="space-y-4 p-5" aria-label={`Extraction batch from ${job.chatTitle}`}>
            <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-medium">{job.chatTitle}</h2><p className="mt-1 text-xs text-muted-foreground">{job.messageCount.toLocaleString()} source messages · Queued {dateLabel(job.createdAt)}</p></div><Badge variant="secondary">{extractionStatus(job)}</Badge></div>
            {snapshot.contextEnabled === false && job.schemaVersion === 'candidate-extraction-v2' && ['queued', 'waiting', 'failed'].includes(job.status) ? <p className="text-sm text-muted-foreground">Contextual extraction is paused by workspace configuration. Ask your administrator to resume it.</p> : null}
            {job.errorCode ? <p className="text-sm text-muted-foreground">{extractionGuidance(job.errorCode)}</p> : null}
            {job.status === 'waiting' ? <p className="text-xs text-muted-foreground">Next attempt: {dateLabel(job.availableAt)} · Attempt {job.attempts} of 5</p> : null}
            <p className="text-xs text-muted-foreground">Automatic extraction {job.extractionEnabled ? 'on' : 'paused'}</p>{job.messageCount > 0 ? <BatchSource key={`${job.id}-${job.sourceRetention.state === 'purged'}`} jobId={job.id} retention={job.sourceRetention} disabled={busy} onChanged={refresh} /> : <p className="text-xs text-muted-foreground">Source messages will be available when this batch starts.</p>}
            {job.status === 'completed' ? <><p className="text-sm">{job.sourceRetention.state === 'purged' ? (job.draftIds.length ? 'Reviewed candidate records remain available below.' : 'No candidate drafts were created from this batch.') : job.draftIds.length ? 'Review these drafts and any new suggestions, including suggestions for already approved candidates.' : 'The model suggested no candidates. Review the whole batch before deciding whether its remaining context can be released.'}</p><div className="flex flex-wrap gap-2">{job.draftIds.map((id, index) => <Button key={id} asChild variant="outline" size="sm"><Link href={`/staff/telegram-intake?draft=${encodeURIComponent(id)}`}>Review draft {index + 1}</Link></Button>)}</div></> : null}
            {job.status === 'failed' ? <Button variant="outline" size="sm" disabled={busy || loading} onClick={() => void act(job, 'retry')}>Retry extraction</Button> : null}
        </Card>)}</div>
        <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">Page {cursors.length} · Up to 50 batches per page</p><div className="flex gap-2"><Button variant="outline" size="sm" disabled={busy || loading || cursors.length === 1} onClick={() => { setCursors(stack => stack.slice(0, -1)); setLoading(true); }}>Previous</Button><Button variant="outline" size="sm" disabled={busy || loading || !snapshot?.nextAfter} onClick={() => { setCursors(stack => [...stack, snapshot!.nextAfter!]); setLoading(true); }}>Next</Button></div></div>
        {notice ? <p role="status" className="text-sm">{notice}</p> : null}
        <p className="text-xs text-muted-foreground">Extraction creates private drafts and suggestions; only approved candidate records are shared. Choose a referenced Telegram CV or upload one manually; it must pass validation before approval. Source context is kept by default. Release a batch only after reviewing all its information; cleanup waits for candidate decisions, suggestions and active CV retrievals.</p>
    </section>;
}
