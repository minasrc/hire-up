'use client';

import { staffWorkspaceFetch } from '@/lib/staff-workspace-fetch';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Check, FileText, Inbox, Pencil, RefreshCw, Search, X } from 'lucide-react';
import { Badge } from '@/components/staff-ui/badge';
import { Button } from '@/components/staff-ui/button';
import { Input } from '@/components/staff-ui/input';
import { Label } from '@/components/staff-ui/label';
import { Textarea } from '@/components/staff-ui/textarea';
import { ProcessingStatus } from './processing-status';
import { CvAnalysisReview } from './cv-analysis/cv-analysis-review';
import { mergeAnalysisDraft } from './cv-analysis/analysis-model';
import { CvRetrieval } from './cv/cv-retrieval';
import { classifyCvDraftRefresh } from './cv/cv-model';
import { DraftSuggestions } from './extraction/draft-suggestions';
import { draftName, editableFields, errorFields, fieldLabels, reviewLabels, fieldsForSave, viewLabels } from './intake-model';
import type { IntakeDraft, IntakeResult, IntakeView, MissingField } from './intake-model';
import { StaffDate } from '../staff-date';

const endpoint = '/api/staff/telegram-intake/drafts';
const emptyResult: IntakeResult = { drafts: [], counts: { ready: 0, needs_information: 0, snoozed: 0, duplicates: 0, all: 0 }, page: 1, hasMore: false };
const reviewFields = (draft: IntakeDraft) => draft.proposedFields ?? draft.fields;
const dateLabel = (value: string) => value ? <StaffDate value={value} kind="timestamp" /> : 'Unknown date';

class IntakeError extends Error {
    constructor(message: string, public status: number, public fields: unknown, public result?: Partial<IntakeDraft>) { super(message); }
}

async function request(url: string, init?: RequestInit) {
    const response = await staffWorkspaceFetch(url, { cache: 'no-store', ...init });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new IntakeError(typeof body.error === 'string' ? body.error : 'This request could not be completed. Please retry.', response.status, body.fields ?? body.fieldErrors, body.result);
    return body.result;
}

export function TelegramIntakeBrowser({ initialResult, initialDraftId }: { initialResult?: IntakeResult; initialDraftId?: string }) {
    const [result, setResult] = useState(initialResult ?? emptyResult);
    const [view, setView] = useState<IntakeView>('all');
    const missing: MissingField = '';
    const [search, setSearch] = useState('');
    const [query, setQuery] = useState('');
    const [page, setPage] = useState(1);
    const [revision, setRevision] = useState(0);
    const [loading, setLoading] = useState(!initialResult);
    const [listError, setListError] = useState('');
    const [selected, setSelected] = useState<string | null>(initialDraftId ?? null);
    const [notice, setNotice] = useState('');
    const reviewState = useRef({ dirty: false, busy: false });
    const onReviewState = useCallback((dirty: boolean, busy: boolean) => { reviewState.current = { dirty, busy }; }, []);
    function chooseProposal(id: string) {
        if (reviewState.current.busy || id === selected) return;
        if (reviewState.current.dirty && !window.confirm('Discard unsaved edits?')) return;
        setSelected(id);
    }

    useEffect(() => {
        // Cleanup is best effort and must never delay the inbox or expose private keys.
        void staffWorkspaceFetch('/api/staff/telegram-intake/uploads/cleanup', { method: 'POST', cache: 'no-store' }).catch(() => {});
    }, []);

    useEffect(() => {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout>;
        let controller: AbortController;
        const params = new URLSearchParams({ view, q: query, page: String(page) });
        if (missing) params.set('missing', missing);
        async function poll() {
            if (document.hidden || stopped) return;
            controller?.abort(); controller = new AbortController();
            try {
                const data = await request(`${endpoint}?${params}`, { signal: controller.signal });
                if (!stopped && !controller.signal.aborted) {
                    setResult(data); setListError(''); setSelected(current => current ?? data.drafts[0]?.id ?? null);
                }
            } catch (error) { if (!stopped && !controller.signal.aborted) setListError(error instanceof Error ? error.message : 'Unable to load proposals.'); }
            finally { if (!stopped && !controller.signal.aborted) { setLoading(false); timer = setTimeout(() => void poll(), 3000); } }
        }
        const visibility = () => { clearTimeout(timer); controller?.abort(); if (!document.hidden) void poll(); };
        void poll(); document.addEventListener('visibilitychange', visibility);
        return () => { stopped = true; clearTimeout(timer); controller?.abort(); document.removeEventListener('visibilitychange', visibility); };
    }, [view, missing, query, page, revision]);

    function updateRow(row: IntakeDraft) {
        // Never put private message evidence into the list's state.
        const listRow = { ...row };
        delete listRow.evidence;
        setResult(current => ({ ...current, drafts: current.drafts.map(draft => draft.id === row.id ? listRow : draft) }));
        setRevision(value => value + 1);
    }

    function nextProposal(id: string) {
        const next = result.drafts.find(row => row.id !== id && row.status !== 'approved' && row.status !== 'discarded');
        setSelected(next?.id ?? null);
        setResult(current => ({ ...current, drafts: current.drafts.filter(row => row.id !== id) }));
        setRevision(value => value + 1);
    }
    return <section className="flex w-full min-w-0 flex-col gap-3">
        <header className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-3"><h1 className="text-lg font-semibold">Candidate proposals</h1><Badge variant="secondary" aria-live="polite">{result.counts.all}</Badge></div><div className="flex gap-2"><Button asChild size="sm" variant="outline"><Link href="/staff/telegram-intake/chats">Choose chats</Link></Button><Button asChild size="sm" variant="outline"><Link href="/staff/candidates/search">Search candidates</Link></Button></div></header>
        <ProcessingStatus reviewLink={false} />
        {notice ? <p role="status" className="text-xs text-muted-foreground">{notice}</p> : null}
        {listError ? <p role="alert" className="text-sm">{listError}</p> : null}
        <div className="grid min-h-[420px] grid-cols-1 overflow-hidden rounded-xl border border-border bg-card shadow-sm md:h-[calc(100dvh-12rem)] md:min-h-[480px] md:grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)]">
            <aside aria-label="Candidate proposals" className="flex min-h-0 flex-col border-b border-border bg-muted/40 md:border-b-0 md:border-r">
                <form className="flex gap-2 border-b p-3" onSubmit={event => { event.preventDefault(); setQuery(search.trim()); setPage(1); }}><Label htmlFor="draft-search" className="sr-only">Find a proposal</Label><Input id="draft-search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Find a candidate…" /><Button type="submit" variant="ghost" size="icon" aria-label="Find proposal"><Search /></Button></form>
                <div className="flex items-center justify-between border-b px-3 py-2"><Label htmlFor="proposal-view" className="sr-only">Proposal filter</Label><select id="proposal-view" className="h-7 max-w-48 rounded bg-card text-xs" value={view} onChange={event => { setView(event.target.value as IntakeView); setPage(1); }}>{Object.entries(viewLabels).filter(([key]) => ['all', 'snoozed', 'duplicates'].includes(key)).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Refresh proposals" disabled={loading} onClick={() => setRevision(value => value + 1)}><RefreshCw className="h-3.5 w-3.5" /></Button></div>
                <div className="max-h-64 min-h-0 flex-1 space-y-1 overflow-y-auto p-2 md:max-h-none" aria-busy={loading}>
                    {!result.drafts.length ? <div className="flex flex-col items-center gap-2 p-8 text-center"><Inbox className="h-6 w-6 text-muted-foreground" /><p role="status" className="text-sm">{loading ? 'Loading…' : 'You’re all caught up'}</p></div> : result.drafts.map(draft => <button key={draft.id} type="button" aria-pressed={selected === draft.id} onClick={() => chooseProposal(draft.id)} className={`flex w-full items-start gap-3 rounded-lg p-3 text-left hover:bg-foreground/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${selected === draft.id ? 'bg-foreground/[0.06]' : ''}`}>
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">{draftName(draft).slice(0, 1)}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{draftName(draft)}</span><span className="mt-0.5 block truncate text-xs text-muted-foreground">{draft.fields.headline || draft.fields.primaryEmail || 'Candidate profile'}</span><span className="mt-1 block text-[11px] text-muted-foreground">{draft.existingCandidate ? 'Profile update' : 'New candidate'}</span></span>
                    </button>)}
                </div>
                {result.hasMore || page > 1 ? <div className="flex justify-between border-t p-2"><Button variant="ghost" size="sm" disabled={loading || page <= 1} onClick={() => setPage(value => value - 1)}>Previous</Button><Button variant="ghost" size="sm" disabled={loading || !result.hasMore} onClick={() => setPage(value => value + 1)}>Next</Button></div> : null}
            </aside>
            <section aria-label="Candidate information" className="min-h-0 min-w-0 overflow-y-auto" tabIndex={0}>{selected ? <DraftEditor key={selected} id={selected} onUpdate={updateRow} onNotice={setNotice} onDone={() => nextProposal(selected)} onReviewState={onReviewState} /> : <div className="flex h-full min-h-60 items-center justify-center p-8 text-sm text-muted-foreground">Select a proposal to review</div>}</section>
        </div>
    </section>;
}

function DraftEditor({ id, onUpdate, onNotice, onDone, onReviewState }: { id: string; onUpdate: (row: IntakeDraft) => void; onNotice: (message: string) => void; onDone: () => void; onReviewState: (dirty: boolean, busy: boolean) => void }) {
    const [draft, setDraft] = useState<IntakeDraft | null>(null);
    const [fields, setFields] = useState<Record<string, string>>({});
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [message, setMessage] = useState('');
    const [conflict, setConflict] = useState(false);
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(true);
    const [reload, setReload] = useState(0);
    const [matchQuery, setMatchQuery] = useState('');
    const [matches, setMatches] = useState<{ id: string; name: string; email: string | null }[] | null>(null);
    const [editing, setEditing] = useState(false);
    const [closedEdits, setClosedEdits] = useState<Record<string, string> | null>(null);
    const [candidateId, setCandidateId] = useState<string | null>(null);
    const [file, setFile] = useState<File | null>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const operationIds = useRef<Record<string, string>>({});
    const url = `${endpoint}/${encodeURIComponent(id)}`;

    useEffect(() => {
        const controller = new AbortController();
        request(url, { signal: controller.signal }).then(row => {
            if (controller.signal.aborted) return;
            setDraft(row); setFields(editableFields(reviewFields(row))); setErrors({}); setMessage(''); setConflict(false); setCandidateId(row.candidateId ?? null);
        }).catch(error => { if (!controller.signal.aborted) setMessage(error.message); })
            .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [url, reload]);

    const dirty = draft && JSON.stringify(fields) !== JSON.stringify(editableFields(reviewFields(draft)));
    const terminal = draft?.status === 'approved' || draft?.status === 'discarded';
    useEffect(() => { onReviewState(Boolean(dirty), busy); return () => onReviewState(false, false); }, [dirty, busy, onReviewState]);

    function refreshDraft() {
        if (draft?.existingCandidate && conflict) {
            setBusy(true);
            request(`${url}/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: draft.version }) })
                .then(row => { accept(row); setConflict(false); setMessage('Profile refreshed. Review the changes again.'); })
                .catch(fail).finally(() => setBusy(false));
        } else { setLoading(true); setReload(value => value + 1); }
    }

    function accept(row: IntakeDraft, resetFields = true) {
        setDraft(current => ({ ...row, evidence: row.status === 'approved' || row.status === 'discarded' ? [] : row.evidence ?? current?.evidence }));
        if (resetFields) setFields(editableFields(reviewFields(row)));
        onUpdate(row);
    }

    function fail(error: unknown) {
        if (error instanceof IntakeError) {
            setErrors(current => ({ ...current, ...errorFields(error.fields) }));
            if (error.status === 409) {
                if (error.result?.status === 'duplicate') {
                    setCandidateId(error.result.candidateId ?? null);
                    setDraft(current => ({ ...current!, status: 'duplicate' }));
                    onUpdate({ ...draft!, status: 'duplicate' });
                }
                setConflict(true);
                setMessage(error.result?.status === 'duplicate' ? 'An existing candidate matches this draft. Review that profile before continuing.' : 'This draft changed since you opened it. Your edits are preserved. Refresh the draft to load the latest version.');
                return;
            }
        }
        setMessage(error instanceof Error ? error.message : 'Unable to complete this request. Please retry.');
    }

    function refreshRetrievedDraft(row: IntakeDraft) {
        if (!draft || busy || conflict) return;
        if (row.documentRevision === draft.documentRevision && row.version <= draft.version) return;
        if (row.documentRevision === draft.documentRevision && row.status !== 'approved' && row.status !== 'discarded') { refreshAnalysisDraft(row); return; }
        const mode = classifyCvDraftRefresh({ current: draft, incoming: row, baselineFields: editableFields(reviewFields(draft)), localFields: fields, nextFields: editableFields(reviewFields(row)) });
        if (mode === 'ignore') return;
        if (mode === 'conflict') { fail(new IntakeError('Draft changed', 409, {})); return; }
        accept(row, mode === 'replace_fields');
        setCandidateId(row.candidateId ?? null);
        if (mode === 'closed') {
            setErrors({});
            const baseline = editableFields(reviewFields(draft));
            const unsaved = Object.fromEntries(Object.entries(fields).filter(([key, value]) => value !== baseline[key]));
            setClosedEdits(Object.keys(unsaved).length ? unsaved : null);
            setMessage(`This draft was ${row.status} in another session.${Object.keys(unsaved).length ? ' Your unsaved changes were not saved. Copy them below if needed.' : ''}`);
            return;
        }
        if (row.cv?.status === 'validated') {
            setErrors(current => { const next = { ...current }; delete next.cv; return next; });
            setMessage('CV validated and attached. Your profile edits are preserved.');
        }
    }

    function refreshAnalysisDraft(row: IntakeDraft) {
        if (!draft || busy || conflict) return;
        const merged = mergeAnalysisDraft({ current: draft, incoming: row, baselineFields: editableFields(reviewFields(draft)), localFields: fields, nextFields: editableFields(reviewFields(row)) });
        if (merged.mode === 'ignore') return;
        if (merged.mode === 'conflict') {
            fail(new IntakeError('Draft changed', 409, {}));
            if (row.status === 'approved' || row.status === 'discarded') {
                const baseline = editableFields(reviewFields(draft));
                const unsaved = Object.fromEntries(Object.entries(fields).filter(([key, value]) => value !== baseline[key]));
                setClosedEdits(Object.keys(unsaved).length ? unsaved : null);
                setMessage(`This draft was ${row.status} in another session.${Object.keys(unsaved).length ? ' Your unsaved edits were not saved. Copy them below before refreshing.' : ' Refresh to see its latest state.'}`);
            }
            return;
        }
        accept(row, false); setFields(merged.fields as Record<string, string>);
        setErrors(current => { const next = { ...current }; if (!row.missingFields.includes('cvAnalysis')) delete next.cvAnalysis; if (!row.missingFields.includes('proposals')) delete next.proposals; return next; });
    }

    async function save() {
        const row = await request(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: draft!.version, fields: fieldsForSave(fields) }) });
        accept(row); setErrors({});
        return row as IntakeDraft;
    }

    async function run(action: 'save' | 'approve' | 'discard' | 'snooze' | 'reopen') {
        if (!draft || busy || conflict) return;
        setBusy(true); setMessage('');
        try {
            let current = draft;
            if (action === 'save' || (action === 'approve' && dirty)) current = await save();
            if (action === 'save') { setMessage('Draft saved.'); return; }
            const key = `${action}:${current.version}`;
            const operationId = operationIds.current[key] ??= crypto.randomUUID();
            const row = await request(`${url}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, expectedVersion: current.version, operationId, reviewFlow: true, reviewedFields: fieldsForSave(fields) }) });
            setErrors({});
            if (row.status === 'approved') {
                setCandidateId(row.candidateId);
                accept({ ...current, status: 'approved', candidateId: row.candidateId });
                setMessage('Candidate saved.'); onNotice(`${draftName(current)} saved.`); onDone();
            } else { accept(row, !dirty); setMessage(action === 'snooze' ? 'Proposal snoozed.' : action === 'reopen' ? 'Proposal reopened.' : 'Proposal rejected.'); if (action === 'discard') { onNotice('Proposal rejected.'); onDone(); } }
        } catch (error) { fail(error); } finally { setBusy(false); }
    }

    async function findCandidates(event: React.FormEvent) {
        event.preventDefault(); if (busy || !matchQuery.trim()) return;
        setBusy(true); setMessage('');
        try { setMatches(await request(`${url}/matches?q=${encodeURIComponent(matchQuery.trim())}`)); }
        catch (error) { fail(error); } finally { setBusy(false); }
    }
    async function chooseCandidate(candidate: string) {
        if (!draft || busy || dirty || conflict) return;
        setBusy(true); setMessage('');
        try { accept(await request(`${url}/match`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ candidateId: candidate, expectedVersion: draft.version }) })); setMatches(null); }
        catch (error) { fail(error); } finally { setBusy(false); }
    }

    async function upload() {
        if (!file || !draft || busy || conflict) return;
        if (!/\.(pdf|docx)$/i.test(file.name) || file.size > 4 * 1024 * 1024 || file.size === 0) { setErrors(current => ({ ...current, cv: 'Choose a non-empty PDF or DOCX file of 4 MB or less.' })); return; }
        setBusy(true); setMessage('');
        try {
            const data = new FormData(); data.set('expectedVersion', String(draft.version)); data.set('cvFile', file);
            const row = await request(`${url}/cv`, { method: 'POST', body: data });
            accept(row, false); setFile(null); if (fileInput.current) fileInput.current.value = '';
            setErrors(current => { const next = { ...current }; delete next.cv; return next; }); setMessage('CV uploaded.');
        } catch (error) { fail(error); } finally { setBusy(false); }
    }

    if (loading) return <p className="p-6 text-sm" role="status">Loading private draft…</p>;
    if (!draft) return <div className="space-y-3 p-6"><p role="alert">{message || 'Draft could not be loaded.'}</p><Button variant="outline" onClick={refreshDraft}>Retry</Button></div>;

    return <div className="flex min-h-full flex-col gap-4 p-5" aria-busy={busy}>
        <div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold">{terminal ? draft.status === 'approved' ? 'Approved candidate' : 'Rejected proposal' : [fields.firstName, fields.lastName].filter(Boolean).join(' ') || draftName(draft)}</h2><p className="mt-1 text-xs text-muted-foreground">{fields.primaryEmail || draft.sourceTitle}</p></div><Badge variant="secondary">{draft.existingCandidate ? 'Profile update' : 'New candidate'}</Badge></div>
        {message ? <div role={conflict || Object.keys(errors).length ? 'alert' : 'status'} className="space-y-3 rounded-lg border border-border bg-muted/30 p-3 text-sm"><p>{message}</p>{conflict ? <Button variant="outline" size="sm" onClick={refreshDraft}>Refresh draft{dirty ? ' (replace my edits)' : ''}</Button> : null}</div> : null}
        {closedEdits ? <div className="space-y-2"><Label htmlFor="closed-draft-edits">Your unsaved changes</Label><Textarea id="closed-draft-edits" readOnly rows={6} value={Object.entries(closedEdits).map(([key, value]) => `${fieldLabels[key] ?? key}: ${value || '(cleared)'}`).join('\n')} /><p className="text-xs text-muted-foreground">These values are available to copy in this open review only. They were not added to the closed draft or candidate profile.</p></div> : null}
        {candidateId ? <Link className="text-sm font-medium underline underline-offset-4" href={`/staff/candidates/${encodeURIComponent(candidateId)}`}>Open {draft.status === 'duplicate' ? 'existing' : 'approved'} candidate</Link> : null}
        {Object.keys(errors).length ? <div role="alert" className="rounded-lg border border-border p-3 text-sm"><p className="font-medium">Resolve these issues before approval:</p><ul className="mt-2 list-disc space-y-1 pl-5">{Object.entries(errors).map(([key, error]) => <li key={key}><a className="underline underline-offset-4" href={`#intake-${key}`}>{reviewLabels[key] ?? key}: {error}</a></li>)}</ul></div> : null}

        <details className="rounded-lg bg-muted/50 px-3 py-2"><summary className="cursor-pointer text-xs text-muted-foreground">Review options</summary><div className="mt-3 space-y-3">        {!terminal ? <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm">{draft.existingCandidate ? 'Choose a different candidate' : 'Already in the database?'}</summary><form onSubmit={findCandidates} className="mt-3 flex gap-2"><Label htmlFor="match-candidate" className="sr-only">Find existing candidate</Label><Input id="match-candidate" value={matchQuery} maxLength={100} onChange={event => setMatchQuery(event.target.value)} placeholder="Name or email…" /><Button type="submit" variant="outline" disabled={busy || !matchQuery.trim()}><Search /><span className="sr-only">Find candidate</span></Button></form>{dirty ? <p className="mt-2 text-xs text-muted-foreground">Save your edits before choosing another profile.</p> : null}{matches?.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">No matching candidates.</p> : null}<div className="mt-2 divide-y">{matches?.map(item => <button key={item.id} type="button" disabled={busy || Boolean(dirty) || conflict} onClick={() => void chooseCandidate(item.id)} className="block w-full rounded p-3 text-left text-sm hover:bg-muted disabled:opacity-50"><span className="font-medium">{item.name}</span><span className="block text-xs text-muted-foreground">{item.email}</span></button>)}</div></details> : null}
        <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm">Review individual suggestions</summary><div className="mt-3"><DraftSuggestions draft={draft} dirty={Boolean(dirty)} busy={busy} conflict={conflict} onUpdate={row => { accept(row); setErrors(current => { const next = { ...current }; delete next.proposals; return next; }); setMessage(''); }} onBusyChange={setBusy} onConflict={() => fail(new IntakeError('Draft changed', 409, {}))} /></div></details>
</div></details>
        {!terminal && !editing ? <dl className="grid gap-3 sm:grid-cols-2">{Object.entries(fieldLabels).filter(([key]) => key !== 'cv').map(([key, label]) => {
            const value = fields[key]; const before = draft.existingCandidate ? editableFields(draft.existingCandidate.fields)[key] : null;
            const changed = draft.existingCandidate && value !== before;
            if ((!value || ['firstName', 'lastName', 'primaryEmail'].includes(key)) && !changed) return null;
            return <div key={key} className={changed ? 'rounded-xl border border-border bg-muted/70 p-3 sm:col-span-2' : key === 'professionalSummary' ? 'sm:col-span-2' : ''}><dt className="text-xs text-muted-foreground">{label}{changed ? <span className="ml-2 font-medium text-primary">Changed</span> : null}</dt><dd className="mt-1 whitespace-pre-wrap break-words text-sm">{changed ? <><span className="text-muted-foreground line-through">{before || 'Not set'}</span><ArrowRight className="mx-2 inline h-3 w-3" /></> : null}{value || 'Removed'}</dd></div>;
        })}</dl> : null}
        {!terminal && editing ? <form className="space-y-5" onSubmit={event => { event.preventDefault(); void run('save'); }} noValidate>
            <fieldset disabled={busy || terminal || conflict} className="grid gap-4 sm:grid-cols-2">
                {Object.entries(fieldLabels).filter(([key]) => key !== 'cv').map(([key, label]) => <div key={key} className={['professionalSummary', 'secondaryEmails', 'compensationPreference'].includes(key) ? 'space-y-2 sm:col-span-2' : 'space-y-2'}>
                    <Label htmlFor={`intake-${key}`}>{label}</Label>
                    {['professionalSummary', 'secondaryEmails'].includes(key) ? <Textarea id={`intake-${key}`} value={fields[key] ?? ''} rows={key === 'professionalSummary' ? 4 : 2} onChange={event => setFields(current => ({ ...current, [key]: event.target.value }))} aria-invalid={Boolean(errors[key])} aria-describedby={errors[key] ? `intake-error-${key}` : key === 'secondaryEmails' ? 'secondary-emails-help' : undefined} /> : <Input id={`intake-${key}`} value={fields[key] ?? ''} type={key === 'primaryEmail' ? 'email' : key === 'professionalUrl' ? 'url' : 'text'} onChange={event => setFields(current => ({ ...current, [key]: event.target.value }))} aria-invalid={Boolean(errors[key])} aria-describedby={errors[key] ? `intake-error-${key}` : undefined} />}
                    {key === 'secondaryEmails' ? <p id="secondary-emails-help" className="text-xs text-muted-foreground">One address per line, or separated by commas.</p> : null}
                    {errors[key] ? <p id={`intake-error-${key}`} className="text-xs font-medium">{errors[key]}</p> : null}
                </div>)}
            </fieldset>
            <div><p className="text-xs font-medium">Telegram user ID</p><p className="mt-1 break-all text-sm text-muted-foreground">{draft.fields.telegramUserId || 'Not provided'}</p></div>
            {!terminal ? <div className="flex items-center gap-3"><Button type="submit" variant="outline" disabled={busy || conflict || !dirty}>Save changes</Button><span className="text-xs text-muted-foreground">{dirty ? 'Unsaved changes' : 'Changes saved'}</span></div> : null}
        </form> : null}
        <details className="space-y-3 rounded-lg bg-muted/40 p-3"><summary className="cursor-pointer text-sm font-medium"><FileText className="mr-2 inline h-4 w-4" />CV {draft.cv ? 'attached' : '(optional)'}</summary>
            <p className="break-all text-sm text-muted-foreground">{draft.cv ? `${draft.cv.filename} · ${draft.cv.status}` : terminal ? draft.status === 'approved' ? 'The CV is available on the approved candidate profile.' : 'No CV is retained on this closed draft.' : 'No CV attached'}</p>
            {draft.cv && !terminal ? <a className="block text-sm font-medium underline underline-offset-4" href={`${url}/cv`} target="_blank" rel="noopener noreferrer">Open CV</a> : null}
            {!terminal ? <><Label className="block" htmlFor="intake-cv">{draft.cv ? 'Replace CV' : 'Upload CV'}</Label><Input ref={fileInput} id="intake-cv" type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="h-auto py-2" disabled={busy || conflict} onChange={event => setFile(event.target.files?.[0] ?? null)} aria-describedby="intake-cv-help" aria-invalid={Boolean(errors.cv)} /><p id="intake-cv-help" className="text-xs text-muted-foreground">PDF or DOCX, up to 4 MB.</p>{errors.cv ? <p className="text-xs font-medium">{errors.cv}</p> : null}<Button variant="outline" size="sm" disabled={!file || busy || conflict} onClick={() => void upload()}>Upload selected CV</Button></> : null}
            <CvAnalysisReview key={`${draft.id}:${draft.documentRevision}:${terminal}`} draft={draft} dirty={Boolean(dirty)} busy={busy} conflict={conflict} onDraft={refreshAnalysisDraft} onBusyChange={setBusy} onConflict={() => fail(new IntakeError('Draft changed', 409, {}))} />
            <CvRetrieval draft={draft} busy={busy} conflict={conflict} onDraft={refreshRetrievedDraft} />
        </details>
        {!terminal ? <details className="rounded-lg bg-muted/40 p-3"><summary className="cursor-pointer text-sm font-medium">View source ({draft.evidenceCount ?? draft.evidence?.length ?? 0})</summary><p className="mt-3 text-xs text-muted-foreground">Source messages are for intake review only and are not added to the candidate profile.</p>{draft.evidenceTruncated ? <p className="mt-2 text-xs text-muted-foreground">Showing the latest 100 source quotes. Earlier quotes remain private; pending suggestions include their own evidence.</p> : null}<div className="mt-4 space-y-4">{draft.evidence?.length ? draft.evidence.map(item => <article key={item.id} className="border-t border-border pt-3"><p className="text-xs text-muted-foreground">{item.senderName || 'Unknown sender'} · {dateLabel(item.sentAt)}</p><p className="mt-2 whitespace-pre-wrap break-words text-sm">{item.text}</p></article>) : <p className="text-sm text-muted-foreground">No source evidence attached.</p>}</div></details> : null}
        {!terminal ? <div className="sticky bottom-0 z-10 -mx-5 -mb-5 mt-auto flex flex-wrap items-center gap-2 border-t bg-card p-4 shadow-sm">
            <Button disabled={busy || conflict || draft.status === 'snoozed'} onClick={() => void run('approve')}><Check />{busy ? 'Saving…' : editing ? 'Save and approve' : 'Approve'}</Button>
            <Button variant="outline" disabled={busy || conflict} onClick={() => setEditing(value => !value)}><Pencil />{editing ? 'Preview' : 'Edit'}</Button>
            <Button variant="ghost" disabled={busy || conflict} onClick={() => void run('discard')}><X />Reject</Button>
            {draft.status === 'snoozed' ? <Button variant="outline" disabled={busy || conflict} onClick={() => void run('reopen')}>Reopen</Button> : null}
        </div> : null}
    </div>;
}
