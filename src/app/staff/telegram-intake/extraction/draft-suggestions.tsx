'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/staff-ui/badge';
import { Button } from '@/components/staff-ui/button';
import { fieldLabels } from '../intake-model';
import type { IntakeDraft } from '../intake-model';
import { canResolveSuggestion, suggestionValue } from './extraction-model';
import { ExtractionError, extractionAction, extractionEndpoint, extractionRequest } from './extraction-api';

type Proposal = { id: string; field: string; currentValue: unknown; suggestedValue: unknown; status: string; evidence: { messageId: string; quote: string }[] };
type Attachment = { jobId: string; messageId: string; attachmentIndex: number; filename: string | null; mimeType: string | null; sizeBytes: number | null; kind: string };
type Review = { proposals: Proposal[]; attachments: Attachment[]; humanFields: string[]; pendingCount: number; nextAfter: string | null };

export function DraftSuggestions({ draft, dirty, busy: parentBusy, conflict, onUpdate, onConflict, onBusyChange }: {
    draft: IntakeDraft; dirty: boolean; busy: boolean; conflict: boolean;
    onUpdate: (draft: IntakeDraft) => void; onConflict: () => void; onBusyChange: (busy: boolean) => void;
}) {
    const [storedReview, setReview] = useState<(Review & { forVersion: number; forAfter: string }) | null>(null);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState(false);
    const [revision, setRevision] = useState(0);
    const [cursors, setCursors] = useState<string[]>(['']);
    const after = cursors[cursors.length - 1];
    const review = storedReview?.forVersion === draft.version && storedReview.forAfter === after ? storedReview : null;
    const terminal = draft.status === 'approved' || draft.status === 'discarded';
    useEffect(() => {
        const controller = new AbortController();
        extractionRequest(`${extractionEndpoint}?draftId=${encodeURIComponent(draft.id)}${after ? `&after=${encodeURIComponent(after)}` : ''}`, { signal: controller.signal })
            .then(result => { if (!controller.signal.aborted) { setReview({ ...result, forVersion: draft.version, forAfter: after }); setError(''); } })
            .catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Unable to load suggestions.'); });
        return () => controller.abort();
    }, [draft.id, draft.version, revision, after]);
    const state = { dirty, busy: busy || parentBusy || !review, conflict, terminal };
    const pending = review?.proposals.filter(proposal => proposal.status === 'pending') ?? [];
    async function resolve(proposal: Proposal, decision: 'apply' | 'dismiss') {
        if (!canResolveSuggestion(state, decision)) return;
        setBusy(true); onBusyChange(true); setError(''); setNotice('');
        try {
            const result = await extractionAction({ action: 'resolve', proposalId: proposal.id, decision, expectedDraftVersion: draft.version });
            onUpdate(result.draft); setRevision(value => value + 1);
            setNotice(decision === 'apply' ? 'Suggestion applied. This field is now protected as your reviewed value.' : 'Suggestion dismissed. Your current value is retained and protected.');
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : 'Unable to resolve this suggestion.');
            if (failure instanceof ExtractionError && failure.status === 409) onConflict();
        } finally { setBusy(false); onBusyChange(false); }
    }
    return <section id="intake-proposals" aria-labelledby="intake-proposals-title" className="space-y-4 rounded-lg border border-border p-4" aria-busy={busy}>
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 id="intake-proposals-title" className="text-sm font-semibold">Extracted suggestions</h3><Button variant="ghost" size="sm" disabled={busy || parentBusy} onClick={() => setRevision(value => value + 1)}>Refresh suggestions</Button></div>
        {error ? <p role="alert" className="text-sm">{error}</p> : null}
        {!review && !error ? <p role="status" className="text-sm text-muted-foreground">Loading private suggestions…</p> : null}
        {review?.pendingCount ? <p className="text-sm">{terminal ? 'New information arrived after this draft was closed. The approved candidate remains unchanged. Review and dismiss these suggestions here.' : `${review.pendingCount} suggestions must be resolved before approval. Your existing values are preserved until you choose to apply a suggestion.`}</p> : review ? <p className="text-sm text-muted-foreground">No pending suggestions.</p> : null}
        {dirty && review?.pendingCount ? <p role="status" className="text-sm font-medium">Save your profile edits before applying or dismissing suggestions.</p> : null}
        {review?.humanFields.length ? <p className="text-xs text-muted-foreground">Fields you edited or reviewed are protected, including values you cleared: {review.humanFields.map(field => fieldLabels[field] ?? field).join(', ')}.</p> : null}
        {pending.map(proposal => <section key={proposal.id} aria-label={`${fieldLabels[proposal.field] ?? proposal.field} suggestion`} className="space-y-3 border-t border-border pt-4">
            <h4 className="text-sm font-medium">{fieldLabels[proposal.field] ?? proposal.field} <Badge variant="outline">Suggested change</Badge></h4>
            <dl className="grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-xs text-muted-foreground">Current value</dt><dd className="mt-1 whitespace-pre-wrap break-words">{suggestionValue(proposal.currentValue)}</dd></div><div><dt className="text-xs text-muted-foreground">Suggested value</dt><dd className="mt-1 whitespace-pre-wrap break-words">{suggestionValue(proposal.suggestedValue)}</dd></div></dl>
            <details><summary className="cursor-pointer text-xs font-medium">View message references ({proposal.evidence.length})</summary><p className="mt-2 text-xs text-muted-foreground">Check the meaning of these quotes before accepting the suggestion. A source reference does not guarantee the interpretation is correct.</p>{proposal.evidence.map((item, index) => <blockquote key={`${item.messageId}-${index}`} className="mt-3 border-l-2 border-border pl-3"><p className="text-xs text-muted-foreground">Message {item.messageId}</p><p className="mt-1 whitespace-pre-wrap break-words text-sm">{item.quote}</p></blockquote>)}</details>
            <div className="flex flex-wrap gap-2">{!terminal ? <Button variant="outline" size="sm" disabled={!canResolveSuggestion(state, 'apply')} onClick={() => void resolve(proposal, 'apply')}>Apply suggestion</Button> : null}<Button variant="ghost" size="sm" disabled={!canResolveSuggestion(state, 'dismiss')} onClick={() => void resolve(proposal, 'dismiss')}>Dismiss suggestion</Button></div>
        </section>)}
        {review && (cursors.length > 1 || review.nextAfter) ? <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">Suggestion page {cursors.length}</p><div className="flex gap-2"><Button variant="outline" size="sm" disabled={busy || parentBusy || cursors.length === 1} onClick={() => setCursors(stack => stack.slice(0, -1))}>Previous suggestions</Button><Button variant="outline" size="sm" disabled={busy || parentBusy || !review.nextAfter} onClick={() => setCursors(stack => [...stack, review.nextAfter!])}>Next suggestions</Button></div></div> : null}
        {review?.attachments.length ? <details className="border-t border-border pt-3"><summary className="cursor-pointer text-sm font-medium">Referenced attachments ({review.attachments.length})</summary><p className="mt-2 text-xs text-muted-foreground">These are attachment details from Telegram, not downloaded or validated CV files. {terminal ? 'This draft is closed; these references do not change the approved profile.' : 'Choose Retrieve CV below to fetch a supported file, or upload the CV manually before approval.'} Up to 50 references are shown.</p><ul className="mt-3 space-y-2 text-sm">{review.attachments.map(item => <li key={`${item.jobId}-${item.messageId}-${item.attachmentIndex}`}><p className="break-words">{item.filename || `${item.kind} attachment`} <Badge variant="outline">Metadata only</Badge></p><p className="mt-1 text-xs text-muted-foreground">Message {item.messageId}{item.mimeType ? ` · ${item.mimeType}` : ''}{item.sizeBytes != null ? ` · ${item.sizeBytes.toLocaleString()} bytes` : ''}</p></li>)}</ul></details> : null}
        {notice ? <p role="status" className="text-sm">{notice}</p> : null}
    </section>;
}
