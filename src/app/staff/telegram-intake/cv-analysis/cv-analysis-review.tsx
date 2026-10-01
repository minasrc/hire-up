'use client';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/staff-ui/badge';
import { Button } from '@/components/staff-ui/button';
import { fieldLabels, type IntakeDraft } from '../intake-model';
import { analysisAction, analysisEndpoint, analysisRequest, AnalysisError, type AnalysisSnapshot } from './analysis-api';
import { analysisActive, analysisGuidance, analysisIssue, analysisStatus } from './analysis-model';
import { AnalysisText, CvQuote } from './analysis-text';
const showValue = (value: unknown) => value == null || value === '' ? 'Not provided' : Array.isArray(value) ? value.join(', ') : String(value);
export function CvAnalysisReview({ draft, dirty, busy, conflict, onDraft, onBusyChange, onConflict }: { draft: IntakeDraft; dirty: boolean; busy: boolean; conflict: boolean; onDraft: (draft: IntakeDraft) => void; onBusyChange: (busy: boolean) => void; onConflict: () => void }) {
    const [snapshot, setSnapshot] = useState<AnalysisSnapshot | null>(null);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [revision, setRevision] = useState(0);
    const [proposalCursors, setProposalCursors] = useState<string[]>(['']);
    const [historyCursors, setHistoryCursors] = useState<string[]>(['']);
    const [loading, setLoading] = useState(true);
    const mutation = useRef(false);
    const callbacks = useRef({ onDraft, busy, conflict });
    const operationIds = useRef<Record<number, string>>({});
    const read = useRef<AbortController | null>(null);
    const latestFingerprint = useRef('');
    const hasCv = !!draft.cv;
    const terminal = draft.status === 'approved' || draft.status === 'discarded';
    const after = historyCursors.at(-1)!; const proposalAfter = proposalCursors.at(-1)!;
    const current = snapshot?.current;
    useEffect(() => { callbacks.current = { onDraft, busy, conflict }; }, [onDraft, busy, conflict]);
    useEffect(() => {
        if (!hasCv && !terminal) return;
        let stopped = false; let timer: ReturnType<typeof setTimeout>;
        async function poll() {
            if (stopped || document.hidden || mutation.current) return;
            read.current?.abort(); const controller = new AbortController(); read.current = controller;
            try {
                const params = new URLSearchParams({ draftId: draft.id }); if (after) params.set('after', after); if (proposalAfter) params.set('proposalAfter', proposalAfter);
                const result: AnalysisSnapshot = await analysisRequest(`${analysisEndpoint}?${params}`, { signal: controller.signal });
                if (stopped || controller.signal.aborted) return;
                setSnapshot(result.documentRevision === draft.documentRevision ? result : null);
                const fingerprint = JSON.stringify([result.documentRevision, result.analysisReviewRequired, result.current, result.proposals.map(item => item.id)]);
                if (fingerprint !== latestFingerprint.current && !callbacks.current.busy && !callbacks.current.conflict) {
                    const response = await fetch(`/api/staff/telegram-intake/drafts/${draft.id}`, { cache: 'no-store', signal: controller.signal });
                    const body = await response.json(); if (!response.ok) throw new AnalysisError(response.status);
                    if (!stopped && !controller.signal.aborted && !callbacks.current.busy && !callbacks.current.conflict) { callbacks.current.onDraft(body.result ?? body); latestFingerprint.current = fingerprint; }
                }
            } catch (failure) { if (!stopped && !controller.signal.aborted) { setError(failure instanceof Error ? failure.message : 'Unable to load CV analysis.'); if (failure instanceof AnalysisError && [401, 403, 404].includes(failure.status)) setSnapshot(null); } }
            finally { if (!stopped && !controller.signal.aborted) setLoading(false); if (!stopped && !document.hidden) timer = setTimeout(() => void poll(), 4000); }
        }
        const visible = () => { clearTimeout(timer); if (document.hidden) read.current?.abort(); else void poll(); };
        void poll(); document.addEventListener('visibilitychange', visible);
        return () => { stopped = true; clearTimeout(timer); read.current?.abort(); document.removeEventListener('visibilitychange', visible); };
    }, [draft.id, draft.documentRevision, hasCv, terminal, revision, after, proposalAfter]);
    async function act(body: Record<string, unknown>) {
        if (busy || mutation.current || conflict) return;
        mutation.current = true; read.current?.abort(); onBusyChange(true); setError(''); setNotice('');
        try {
            const result = await analysisAction(body);
            if (result.draft) onDraft(result.draft);
            if (result.analysis) setSnapshot(value => value && result.analysis.documentRevision === value.documentRevision ? { ...value, current: result.analysis } : value);
            setNotice(body.action === 'analyze' ? 'Analysis requested. You can continue editing while your Mac works.' : body.action === 'cancel' ? 'Analysis skipped. Complete the profile manually.' : body.action === 'reviewText' ? 'Full text decision saved.' : body.action === 'resolve' ? 'CV suggestion reviewed.' : 'Analysis retry requested.');
            latestFingerprint.current = '';
        } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to update CV analysis.'); if (failure instanceof AnalysisError && [401, 403, 404].includes(failure.status)) setSnapshot(null); if (failure instanceof AnalysisError && failure.status === 409) onConflict(); }
        finally { mutation.current = false; onBusyChange(false); setRevision(value => value + 1); }
    }
    if (!draft.cv && !snapshot?.current && !snapshot?.jobs.length) return null;
    const disabled = busy || conflict || loading;
    return <section id="intake-cvAnalysis" aria-label="CV analysis and review" className="space-y-4 border-t border-border pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">CV analysis and review</h3><Button variant="ghost" size="sm" disabled={busy} onClick={() => { setError(''); setRevision(value => value + 1); }}>Refresh analysis</Button></div>
        <p className="text-xs text-muted-foreground">Review CV suggestions before approval. Image content is not extracted; review the original CV.</p>
        {error ? <p role="alert" className="text-sm">{error}</p> : null}{notice ? <p role="status" className="text-sm">{notice}</p> : null}
        {loading ? <p role="status" className="text-sm">Loading CV analysis…</p> : null}
        {!current && !terminal ? <Button variant="outline" size="sm" disabled={disabled || !snapshot?.canAnalyze} onClick={() => void act({ action: 'analyze', draftId: draft.id, expectedDocumentRevision: draft.documentRevision, operationId: operationIds.current[draft.documentRevision ?? 0] ??= crypto.randomUUID() })}>Analyze attached CV</Button> : null}
        {current ? <article className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="break-words text-sm font-medium">{current.filename}</p><Badge variant="secondary">{analysisStatus(current)}</Badge></div>
            {current.errorCode ? <p className="text-sm">{analysisGuidance(current.errorCode)}</p> : null}
            {current.status === 'waiting' ? <p className="text-xs text-muted-foreground">Next attempt: {new Date(current.availableAt).toLocaleString()}</p> : null}
            {analysisActive(current.status) ? <p className="text-xs text-muted-foreground">Keep the Mac worker running. Profile edits can be saved while analysis runs.</p> : null}
            {current.issues.map(issue => <p key={issue} className="text-sm">{analysisIssue(issue)}</p>)}
            {!terminal ? <div className="flex flex-wrap gap-2">{current.canRetry ? <Button variant="outline" size="sm" disabled={disabled} onClick={() => void act({ action: 'retry', analysisId: current.id, expectedAnalysisVersion: current.version })}>Retry CV analysis</Button> : null}{analysisActive(current.status) || current.status === 'failed' ? <Button variant="ghost" size="sm" disabled={disabled} onClick={() => void act({ action: 'cancel', analysisId: current.id, expectedAnalysisVersion: current.version })}>Skip CV analysis</Button> : null}</div> : null}
            {current.status === 'completed' && !terminal ? <AnalysisText key={`${current.id}:${current.documentRevision}`} analysis={current} disabled={disabled || terminal} onDecision={decision => act({ action: 'reviewText', analysisId: current.id, expectedAnalysisVersion: current.version, decision })} /> : null}
        </article> : null}
        {(snapshot?.proposals.length || current?.pendingProposalCount) ? <div className="space-y-4"><h4 className="text-sm font-medium">CV suggestions ({current?.pendingProposalCount ?? snapshot?.proposals.length})</h4>{dirty ? <p className="text-xs text-muted-foreground">Save your profile edits before applying or dismissing CV suggestions.</p> : null}{snapshot?.proposals.map(proposal => <article key={proposal.id} aria-label={`CV suggestion for ${fieldLabels[proposal.field] ?? proposal.field}`} className="space-y-3 rounded-lg border border-border p-3"><h5 className="text-sm font-medium">{fieldLabels[proposal.field] ?? proposal.field}</h5><p className="break-words text-sm">Current: {showValue(proposal.currentValue)}</p><p className="whitespace-pre-wrap break-words text-sm">Suggested: {showValue(proposal.suggestedValue)}</p>{proposal.evidence.map((evidence, index) => <CvQuote key={index} analysisId={proposal.analysisId} evidence={evidence} />)}<div className="flex flex-wrap gap-2">{!terminal ? <Button variant="outline" size="sm" disabled={disabled || dirty} onClick={() => void act({ action: 'resolve', analysisId: proposal.analysisId, proposalId: proposal.id, expectedDraftVersion: draft.version, decision: 'apply' })}>Apply CV suggestion</Button> : null}<Button variant="ghost" size="sm" disabled={disabled || dirty} onClick={() => void act({ action: 'resolve', analysisId: proposal.analysisId, proposalId: proposal.id, expectedDraftVersion: draft.version, decision: 'dismiss' })}>Dismiss CV suggestion</Button></div></article>)}<div className="flex gap-2">{proposalCursors.length > 1 ? <Button variant="outline" size="sm" disabled={busy} onClick={() => setProposalCursors(value => value.slice(0, -1))}>Previous CV suggestions</Button> : null}{snapshot?.nextProposalAfter ? <Button variant="outline" size="sm" disabled={busy} onClick={() => setProposalCursors(value => [...value, snapshot.nextProposalAfter!])}>More CV suggestions</Button> : null}</div></div> : null}
        {snapshot?.jobs.length ? <details className="space-y-3"><summary className="cursor-pointer text-xs font-medium">Analysis history</summary>{snapshot.jobs.map(job => <p key={job.id} className="break-words text-xs text-muted-foreground">{job.filename} · Document revision {job.documentRevision} · {analysisStatus(job)}</p>)}<div className="flex gap-2">{historyCursors.length > 1 ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => setHistoryCursors(value => value.slice(0, -1))}>Previous analyses</Button> : null}{snapshot.nextAfter ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => setHistoryCursors(value => [...value, snapshot.nextAfter!])}>Older analyses</Button> : null}</div></details> : null}
    </section>;
}
