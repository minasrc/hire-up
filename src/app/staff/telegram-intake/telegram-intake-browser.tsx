'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { FileText, Inbox, RefreshCw, Search } from 'lucide-react';
import { PageHeader } from '@/components/staff-preview/shared';
import { Badge } from '@/components/staff-ui/badge';
import { Button } from '@/components/staff-ui/button';
import { Card } from '@/components/staff-ui/card';
import { Input } from '@/components/staff-ui/input';
import { Label } from '@/components/staff-ui/label';
import { Textarea } from '@/components/staff-ui/textarea';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/staff-ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/staff-ui/table';
import { DraftSuggestions } from './extraction/draft-suggestions';
import { draftName, draftStatus, editableFields, errorFields, fieldLabels, fieldsForSave, viewLabels } from './intake-model';
import type { IntakeDraft, IntakeResult, IntakeView, MissingField } from './intake-model';

const endpoint = '/api/staff/telegram-intake/drafts';
const emptyResult: IntakeResult = { drafts: [], counts: { ready: 0, needs_information: 0, snoozed: 0, duplicates: 0, all: 0 }, page: 1, hasMore: false };
const dateLabel = (value: string) => value ? new Date(value).toLocaleString() : 'Unknown date';

class IntakeError extends Error {
    constructor(message: string, public status: number, public fields: unknown, public result?: Partial<IntakeDraft>) { super(message); }
}

async function request(url: string, init?: RequestInit) {
    const response = await fetch(url, { cache: 'no-store', ...init });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new IntakeError(typeof body.error === 'string' ? body.error : 'This request could not be completed. Please retry.', response.status, body.fields ?? body.fieldErrors, body.result);
    return body.result;
}

export function TelegramIntakeBrowser({ initialResult, initialDraftId }: { initialResult?: IntakeResult; initialDraftId?: string }) {
    const [result, setResult] = useState(initialResult ?? emptyResult);
    const [view, setView] = useState<IntakeView>('ready');
    const [missing, setMissing] = useState<MissingField>('');
    const [search, setSearch] = useState('');
    const [query, setQuery] = useState('');
    const [page, setPage] = useState(1);
    const [revision, setRevision] = useState(0);
    const [loading, setLoading] = useState(!initialResult);
    const [listError, setListError] = useState('');
    const [selected, setSelected] = useState<string | null>(initialDraftId ?? null);
    const [notice, setNotice] = useState('');
    const firstLoad = useRef(true);

    useEffect(() => {
        // Cleanup is best effort and must never delay the inbox or expose private keys.
        void fetch('/api/staff/telegram-intake/uploads/cleanup', { method: 'POST', cache: 'no-store' }).catch(() => {});
    }, []);

    useEffect(() => {
        if (firstLoad.current && initialResult) { firstLoad.current = false; return; }
        firstLoad.current = false;
        const controller = new AbortController();
        setLoading(true);
        setListError('');
        const params = new URLSearchParams({ view, q: query, page: String(page) });
        if (missing) params.set('missing', missing);
        request(`${endpoint}?${params}`, { signal: controller.signal })
            .then(data => { if (!controller.signal.aborted) setResult(data); })
            .catch(error => { if (!controller.signal.aborted) setListError(error.message); })
            .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [view, missing, query, page, revision, initialResult]);

    function updateRow(row: IntakeDraft) {
        // Never put private message evidence into the list's state.
        const listRow = { ...row };
        delete listRow.evidence;
        setResult(current => ({ ...current, drafts: current.drafts.map(draft => draft.id === row.id ? listRow : draft) }));
        setRevision(value => value + 1);
    }

    return (
        <section className="mx-auto flex w-full max-w-7xl flex-col gap-6">
            <PageHeader eyebrow="Private workspace" title="Telegram intake" description="Review private drafts, complete missing details, and approve candidates into your workspace."
                actions={<div className="flex flex-wrap gap-2"><Button asChild variant="outline"><Link href="/staff/telegram-intake/extraction">Extraction progress</Link></Button><Button asChild variant="outline"><Link href="/staff/telegram-intake/chats">Telegram chats</Link></Button><Button variant="outline" onClick={() => setRevision(value => value + 1)} disabled={loading}><RefreshCw />Refresh inbox</Button></div>} />
            <nav aria-label="Draft views" className="flex flex-wrap gap-2">
                {(Object.keys(viewLabels) as IntakeView[]).map(key => <Button key={key} variant={view === key ? 'secondary' : 'ghost'} aria-pressed={view === key}
                    onClick={() => { setView(key); setPage(1); }}>
                    {viewLabels[key]} <Badge variant="outline">{result.counts[key]}</Badge>
                </Button>)}
            </nav>
            <Card className="overflow-hidden">
                <div className="flex flex-col gap-4 border-b border-border p-4 sm:flex-row sm:items-end">
                    <form className="flex flex-1 items-end gap-2" onSubmit={event => { event.preventDefault(); setQuery(search.trim()); setPage(1); }}>
                        <div className="flex-1 space-y-2"><Label htmlFor="draft-search">Search drafts</Label><Input id="draft-search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Name, email or Telegram username" /></div>
                        <Button variant="outline" type="submit"><Search /><span className="sr-only sm:not-sr-only">Search</span></Button>
                    </form>
                    <div className="space-y-2"><Label htmlFor="draft-missing">Missing information</Label>
                        <select id="draft-missing" className="h-9 w-full rounded-lg border border-input bg-card px-3 text-sm sm:w-48" value={missing}
                            onChange={event => { setMissing(event.target.value as MissingField); setPage(1); }}>
                            <option value="">Any</option><option value="cv">CV</option><option value="firstName">First name</option><option value="lastName">Last name</option><option value="primaryEmail">Primary email</option>
                        </select>
                    </div>
                </div>
                {listError ? <div role="alert" className="p-5 text-sm"><p>{listError}</p><Button variant="outline" className="mt-3" onClick={() => setRevision(value => value + 1)}>Retry loading drafts</Button></div> : null}
                <div aria-busy={loading}>
                    {loading ? <p role="status" className="border-b border-border px-5 py-3 text-sm text-muted-foreground">Loading drafts…</p> : null}
                    {!loading && !listError && !result.drafts.length ? <div className="flex flex-col items-center gap-2 px-5 py-14 text-center"><Inbox className="h-7 w-7 text-muted-foreground" /><h2 className="font-medium">No drafts in this view</h2><p className="text-sm text-muted-foreground">Try another view or adjust the search and missing-information filter.</p></div> : null}
                    {result.drafts.length > 0 ? <Table><TableHeader><TableRow><TableHead>Draft</TableHead><TableHead>Status</TableHead><TableHead>Missing</TableHead><TableHead>Source</TableHead><TableHead>Updated</TableHead></TableRow></TableHeader><TableBody>
                        {result.drafts.map(draft => <TableRow key={draft.id}>
                            <TableCell><button type="button" className="rounded text-left font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setSelected(draft.id)}>{draftName(draft)}</button><p className="mt-1 text-xs text-muted-foreground">{draft.fields.primaryEmail || 'No primary email'}</p></TableCell>
                            <TableCell><Badge variant="secondary">{draftStatus(draft)}</Badge></TableCell>
                            <TableCell className="text-xs text-muted-foreground">{draft.missingFields.map(key => key === 'proposals' ? 'Suggestions' : fieldLabels[key] ?? key).join(', ') || 'Complete'}</TableCell>
                            <TableCell className="text-sm">{draft.sourceTitle || '—'}</TableCell><TableCell className="whitespace-nowrap text-xs text-muted-foreground">{dateLabel(draft.updatedAt)}</TableCell>
                        </TableRow>)}
                    </TableBody></Table> : null}
                </div>
                <div className="flex items-center justify-between border-t border-border px-4 py-3"><p className="text-xs text-muted-foreground">Page {result.page}</p><div className="flex gap-2"><Button variant="outline" size="sm" disabled={loading || page <= 1} onClick={() => setPage(value => value - 1)}>Previous</Button><Button variant="outline" size="sm" disabled={loading || !result.hasMore} onClick={() => setPage(value => value + 1)}>Next</Button></div></div>
            </Card>
            {notice ? <p role="status" className="text-sm">{notice}</p> : null}
            <p className="text-xs text-muted-foreground">Only approved candidate records are shared. Drafts and source messages stay private.</p>
            <Sheet open={Boolean(selected)} onOpenChange={open => { if (!open) setSelected(null); }}>
                <SheetContent className="w-full max-w-2xl gap-0 overflow-y-auto p-0 sm:w-full">
                    <SheetHeader className="border-b border-border p-6 pr-12"><SheetTitle>Review draft</SheetTitle><SheetDescription>Check the profile and CV before approving. Source evidence is private.</SheetDescription></SheetHeader>
                    {selected ? <DraftEditor key={selected} id={selected} onUpdate={updateRow} onNotice={setNotice} /> : null}
                </SheetContent>
            </Sheet>
        </section>
    );
}

function DraftEditor({ id, onUpdate, onNotice }: { id: string; onUpdate: (row: IntakeDraft) => void; onNotice: (message: string) => void }) {
    const [draft, setDraft] = useState<IntakeDraft | null>(null);
    const [fields, setFields] = useState<Record<string, string>>({});
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [message, setMessage] = useState('');
    const [conflict, setConflict] = useState(false);
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(true);
    const [reload, setReload] = useState(0);
    const [candidateId, setCandidateId] = useState<string | null>(null);
    const [file, setFile] = useState<File | null>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const operationIds = useRef<Record<string, string>>({});
    const url = `${endpoint}/${encodeURIComponent(id)}`;

    useEffect(() => {
        const controller = new AbortController();
        request(url, { signal: controller.signal }).then(row => {
            if (controller.signal.aborted) return;
            setDraft(row); setFields(editableFields(row.fields)); setErrors({}); setMessage(''); setConflict(false); setCandidateId(row.candidateId ?? null);
        }).catch(error => { if (!controller.signal.aborted) setMessage(error.message); })
            .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [url, reload]);

    const dirty = draft && JSON.stringify(fields) !== JSON.stringify(editableFields(draft.fields));
    const terminal = draft?.status === 'approved' || draft?.status === 'discarded';

    function refreshDraft() {
        setLoading(true);
        setReload(value => value + 1);
    }

    function accept(row: IntakeDraft, resetFields = true) {
        setDraft(current => ({ ...row, evidence: row.status === 'approved' || row.status === 'discarded' ? [] : row.evidence ?? current?.evidence }));
        if (resetFields) setFields(editableFields(row.fields));
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
            const row = await request(`${url}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, expectedVersion: current.version, operationId }) });
            setErrors({});
            if (row.status === 'approved') {
                setCandidateId(row.candidateId);
                accept({ ...current, status: 'approved', candidateId: row.candidateId });
                setMessage('Candidate approved.'); onNotice(`${draftName(current)} was approved into the candidate workspace.`);
            } else { accept(row, !dirty); setMessage(action === 'snooze' ? 'Draft snoozed.' : action === 'reopen' ? 'Draft reopened.' : 'Draft discarded.'); }
        } catch (error) { fail(error); } finally { setBusy(false); }
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

    return <div className="flex flex-col gap-6 p-6" aria-busy={busy}>
        <div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold">{terminal ? draft.status === 'approved' ? 'Approved candidate draft' : 'Discarded draft' : draftName(draft)}</h2><p className="mt-1 text-xs text-muted-foreground">{draft.sourceTitle || 'Private draft'} · {dateLabel(draft.updatedAt)}</p></div><Badge variant="secondary">{draftStatus(draft)}</Badge></div>
        {message ? <div role={conflict || Object.keys(errors).length ? 'alert' : 'status'} className="space-y-3 rounded-lg border border-border bg-muted/30 p-3 text-sm"><p>{message}</p>{conflict ? <Button variant="outline" size="sm" onClick={refreshDraft}>Refresh draft{dirty ? ' (replace my edits)' : ''}</Button> : null}</div> : null}
        {candidateId ? <Link className="text-sm font-medium underline underline-offset-4" href={`/staff/candidates/${encodeURIComponent(candidateId)}`}>Open {draft.status === 'duplicate' ? 'existing' : 'approved'} candidate</Link> : null}
        {Object.keys(errors).length ? <div role="alert" className="rounded-lg border border-border p-3 text-sm"><p className="font-medium">Resolve these issues before approval:</p><ul className="mt-2 list-disc space-y-1 pl-5">{Object.entries(errors).map(([key, error]) => <li key={key}><a className="underline underline-offset-4" href={`#intake-${key}`}>{key === 'proposals' ? 'Suggestions' : fieldLabels[key] ?? key}: {error}</a></li>)}</ul></div> : null}
        {!terminal && draft.missingFields.length ? <p className="text-sm text-muted-foreground">Still needed: {draft.missingFields.map(key => key === 'proposals' ? 'Suggestions' : fieldLabels[key] ?? key).join(', ')}.</p> : null}
        <DraftSuggestions draft={draft} dirty={Boolean(dirty)} busy={busy} conflict={conflict} onUpdate={row => { accept(row); setErrors(current => { const next = { ...current }; delete next.proposals; return next; }); setMessage(''); }} onBusyChange={setBusy} onConflict={() => fail(new IntakeError('Draft changed', 409, {}))} />
        {!terminal ? <form className="space-y-5" onSubmit={event => { event.preventDefault(); void run('save'); }} noValidate>
            <fieldset disabled={busy || terminal || conflict} className="grid gap-4 sm:grid-cols-2">
                {Object.entries(fieldLabels).filter(([key]) => key !== 'cv').map(([key, label]) => <div key={key} className={['professionalSummary', 'secondaryEmails', 'compensationPreference'].includes(key) ? 'space-y-2 sm:col-span-2' : 'space-y-2'}>
                    <Label htmlFor={`intake-${key}`}>{label}{['firstName', 'lastName', 'primaryEmail'].includes(key) ? ' *' : ''}</Label>
                    {['professionalSummary', 'secondaryEmails'].includes(key) ? <Textarea id={`intake-${key}`} value={fields[key] ?? ''} rows={key === 'professionalSummary' ? 4 : 2} onChange={event => setFields(current => ({ ...current, [key]: event.target.value }))} aria-invalid={Boolean(errors[key])} aria-describedby={errors[key] ? `intake-error-${key}` : key === 'secondaryEmails' ? 'secondary-emails-help' : undefined} /> : <Input id={`intake-${key}`} value={fields[key] ?? ''} type={key === 'primaryEmail' ? 'email' : key === 'professionalUrl' ? 'url' : 'text'} onChange={event => setFields(current => ({ ...current, [key]: event.target.value }))} aria-invalid={Boolean(errors[key])} aria-describedby={errors[key] ? `intake-error-${key}` : undefined} />}
                    {key === 'secondaryEmails' ? <p id="secondary-emails-help" className="text-xs text-muted-foreground">One address per line, or separated by commas.</p> : null}
                    {errors[key] ? <p id={`intake-error-${key}`} className="text-xs font-medium">{errors[key]}</p> : null}
                </div>)}
            </fieldset>
            <div><p className="text-xs font-medium">Telegram user ID</p><p className="mt-1 break-all text-sm text-muted-foreground">{draft.fields.telegramUserId || 'Not provided'}</p></div>
            {!terminal ? <div className="flex items-center gap-3"><Button type="submit" variant="outline" disabled={busy || conflict || !dirty}>Save changes</Button><span className="text-xs text-muted-foreground">{dirty ? 'Unsaved changes' : 'Changes saved'}</span></div> : null}
        </form> : null}
        <section className="space-y-3 rounded-lg border border-border p-4" aria-labelledby="intake-cv-label">
            <h3 id="intake-cv-label" className="flex items-center gap-2 text-sm font-medium"><FileText className="h-4 w-4" />CV</h3>
            <p className="break-all text-sm text-muted-foreground">{draft.cv ? `${draft.cv.filename} · ${draft.cv.status}` : terminal ? draft.status === 'approved' ? 'The CV is available on the approved candidate profile.' : 'No CV is retained on this closed draft.' : 'No CV attached'}</p>
            {draft.cv && !terminal ? <a className="inline-block text-sm font-medium underline underline-offset-4" href={`${url}/cv`} target="_blank" rel="noopener noreferrer">Open CV</a> : null}
            {!terminal ? <><Label htmlFor="intake-cv">{draft.cv ? 'Replace CV' : 'Upload CV'}</Label><Input ref={fileInput} id="intake-cv" type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="h-auto py-2" disabled={busy || conflict} onChange={event => setFile(event.target.files?.[0] ?? null)} aria-describedby="intake-cv-help" aria-invalid={Boolean(errors.cv)} /><p id="intake-cv-help" className="text-xs text-muted-foreground">PDF or DOCX, up to 4 MB.</p>{errors.cv ? <p className="text-xs font-medium">{errors.cv}</p> : null}<Button variant="outline" size="sm" disabled={!file || busy || conflict} onClick={() => void upload()}>Upload selected CV</Button></> : null}
        </section>
        {!terminal ? <details className="rounded-lg border border-border p-4"><summary className="cursor-pointer text-sm font-medium">Private source evidence ({draft.evidenceCount ?? draft.evidence?.length ?? 0})</summary><p className="mt-3 text-xs text-muted-foreground">Source messages are for intake review only and are not added to the candidate profile.</p>{draft.evidenceTruncated ? <p className="mt-2 text-xs text-muted-foreground">Showing the latest 100 source quotes. Earlier quotes remain private; pending suggestions include their own evidence.</p> : null}<div className="mt-4 space-y-4">{draft.evidence?.length ? draft.evidence.map(item => <article key={item.id} className="border-t border-border pt-3"><p className="text-xs text-muted-foreground">{item.senderName || 'Unknown sender'} · {dateLabel(item.sentAt)}</p><p className="mt-2 whitespace-pre-wrap break-words text-sm">{item.text}</p></article>) : <p className="text-sm text-muted-foreground">No source evidence attached.</p>}</div></details> : null}
        {!terminal ? <div className="space-y-3 border-t border-border pt-5"><p className="text-xs text-muted-foreground">Approval requires a first name, last name, primary email, and validated CV. Edited profile fields are saved when you approve.</p><div className="flex flex-wrap gap-2">
            <Button disabled={busy || conflict || draft.status !== 'pending'} onClick={() => void run('approve')}>{busy ? 'Working…' : 'Approve candidate'}</Button>
            {draft.status === 'pending' ? <Button variant="outline" disabled={busy || conflict} onClick={() => void run('snooze')}>Snooze</Button> : <Button variant="outline" disabled={busy || conflict} onClick={() => void run('reopen')}>Reopen</Button>}
            <Button variant="ghost" disabled={busy || conflict} onClick={() => void run('discard')}>Discard</Button>
        </div></div> : null}
    </div>;
}
