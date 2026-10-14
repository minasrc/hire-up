'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { RefreshCw, Search } from 'lucide-react';
import { PageHeader } from '@/components/staff-preview/shared';
import { Badge } from '@/components/staff-ui/badge';
import { Button } from '@/components/staff-ui/button';
import { Card } from '@/components/staff-ui/card';
import { Label } from '@/components/staff-ui/label';
import { Textarea } from '@/components/staff-ui/textarea';
import { searchInvalidated, safeSearchSnapshot, searchCvMode, hasIncompleteCoverage, searchGuidance, searchIsActive, searchScopeLabels, searchStatusLabel, validResultHref } from './search-model';
import { ProfileSearchError, searchAction, searchEndpoint, searchRequest } from './search-api';

type Scope = 'approved' | 'my_drafts' | 'all';
type CvCoverage = { attached: number; withoutRetainedText: number; eligible: number; indexed: number; pending: number; failed: number; retryable: number };
type Coverage = { eligible: number; indexed: number; fullyIndexed?: number; pending: number; failed: number; retryable: number; corpusChanged: boolean; cv?: CvCoverage | null };
type Capacity = { readyChunks: number; maxReadyChunks: number; withinLimit: boolean };
type Result = { sourceType: 'candidate' | 'draft'; sourceId: string; sourceRevision: string; displayName: string; headline: string | null; location: string | null; hasCv: boolean; missingFields: string[]; score: number; matchedComponent?: 'profile' | 'cv'; matchedDocument?: { id: string; filename: string } | null; matchedText: string; href: string };
type Snapshot = { includeCv?: boolean; cvAvailable?: boolean; capacity?: Capacity | null; coverage: Coverage; workerAvailable: boolean; queryId?: string; status?: string; query?: string; scope?: Scope; readyOnly?: boolean; results?: Result[]; nextAfter?: string | null; errorCode?: string | null; expiresAt?: string };
const missingLabels: Record<string, string> = { firstName: 'first name', lastName: 'last name', primaryEmail: 'primary email', cv: 'CV', proposals: 'suggestion review', cvAnalysis: 'CV analysis review' };

export function ProfileSearchBrowser({ initialScope = 'all', initialQueryId }: { initialScope?: Scope; initialQueryId?: string }) {
    const [query, setQuery] = useState('');
    const [scope, setScope] = useState<Scope>(initialScope);
    const [readyOnly, setReadyOnly] = useState(false);
    const [includeCv, setIncludeCv] = useState(false);
    const [cvAvailable, setCvAvailable] = useState<boolean | null>(null);
    const cvMode = searchCvMode(scope, includeCv);
    const modeInitialized = useRef(false);
    const [queryId, setQueryId] = useState(initialQueryId ?? '');
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
    const [cursors, setCursors] = useState<string[]>(['']);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(true);
    const [denied, setDenied] = useState(false);
    const [revision, setRevision] = useState(0);
    const mutating = useRef(false);
    const read = useRef<AbortController | null>(null);
    const epoch = useRef(0);
    const stickyError = useRef(false);
    const resume = useRef(initialQueryId ?? '');
    const operation = useRef<{ key: string; id: string } | null>(null);
    const after = cursors[cursors.length - 1];
    const active = searchIsActive(snapshot?.status) || (!!queryId && !snapshot?.status);
    const delay = active ? 2000 : 15000;
    const load = useCallback(async () => {
        if (mutating.current || document.hidden) return;
        read.current?.abort(); const controller = new AbortController(); read.current = controller;
        const version = ++epoch.current;
        try {
            const params = queryId ? new URLSearchParams({ queryId }) : new URLSearchParams({ scope, readyOnly: String(readyOnly), includeCv: String(cvMode) });
            if (queryId && after) params.set('after', after);
            const body = await searchRequest(`${searchEndpoint}?${params}`, { signal: controller.signal });
            if (controller.signal.aborted || version !== epoch.current) return;
            setCvAvailable(body.cvAvailable === true);
            if (!queryId && !modeInitialized.current) {
                modeInitialized.current = true;
                if (body.cvAvailable === true) { setIncludeCv(true); if (scope !== 'my_drafts') { setSnapshot(null); return; } }
            }
            const safeBody = safeSearchSnapshot(body);
            if (searchInvalidated(body.errorCode)) { operation.current = null; setCursors(current => current.length > 1 ? [''] : current); }
            setSnapshot(safeBody); if (!stickyError.current) setError('');
            if (resume.current && body.queryId === resume.current) {
                resume.current = ''; modeInitialized.current = true; setIncludeCv(body.includeCv === true); setQuery(body.query ?? ''); setScope(body.scope); setReadyOnly(body.readyOnly === true);
            }
        } catch (failure) {
            if (controller.signal.aborted || version !== epoch.current) return;
            setError(failure instanceof Error ? failure.message : 'Unable to load search status.');
            if (failure instanceof ProfileSearchError && [401, 403, 404].includes(failure.status)) { setSnapshot(null); setCursors(['']); setDenied(true); if (failure.status === 403 && cvMode) setCvAvailable(false); }
        } finally { if (!controller.signal.aborted && version === epoch.current) setLoading(false); }
    }, [queryId, scope, readyOnly, after, cvMode]);
    useEffect(() => {
        if (denied) return;
        let stopped = false; let timer: ReturnType<typeof setTimeout>; let cycle = 0;
        async function poll(version = cycle) { await load(); if (!stopped && version === cycle && !document.hidden) timer = setTimeout(() => void poll(version), delay); }
        const visibility = () => { cycle += 1; clearTimeout(timer); if (document.hidden) read.current?.abort(); else void poll(); };
        void poll(); document.addEventListener('visibilitychange', visibility);
        return () => { stopped = true; clearTimeout(timer); read.current?.abort(); document.removeEventListener('visibilitychange', visibility); };
    }, [load, delay, revision, denied]);
    function updateUrl(id: string, nextScope = scope) {
        const params = new URLSearchParams(id ? { queryId: id } : { scope: nextScope });
        window.history.replaceState(null, '', `/staff/candidates/search?${params}`);
    }
    function clearSearch(nextScope = scope, nextReady = readyOnly, nextCv = includeCv) {
        read.current?.abort(); epoch.current += 1; resume.current = ''; operation.current = null;
        setNotice(''); setQueryId(''); setSnapshot(null); setCursors(['']); setScope(nextScope); setReadyOnly(nextReady); setIncludeCv(nextCv); setError(''); setDenied(false); setLoading(true); updateUrl('', nextScope);
    }
    function refresh() { stickyError.current = false; setDenied(false); setLoading(true); setRevision(value => value + 1); }
    function clearRestrictedResults(failure: unknown, mode = cvMode) {
        if (failure instanceof ProfileSearchError && [401, 403, 404].includes(failure.status)) {
            setSnapshot(null); setCursors(['']); setQueryId(''); setDenied(true); operation.current = null; updateUrl('');
            if (mode && failure.status === 403) setCvAvailable(false);
        }
    }
    async function submit(mode = cvMode) {
        if (busy || active || !query.trim() || cvAvailable === null) return;
        mutating.current = true; read.current?.abort(); epoch.current += 1; stickyError.current = false;
        setBusy(true); setError(''); setNotice('');
        const body = { query: query.trim(), scope, readyOnly, includeCv: mode };
        setIncludeCv(mode);
        const key = JSON.stringify(body);
        if (operation.current?.key !== key) operation.current = { key, id: crypto.randomUUID() };
        try {
            const result = await searchAction({ action: 'search', operationId: operation.current.id, ...body });
            resume.current = ''; setDenied(false); setQueryId(result.queryId); setCursors(['']);
            setSnapshot(null);
            operation.current = null; updateUrl(result.queryId); setLoading(true); setRevision(value => value + 1);
        } catch (failure) { clearRestrictedResults(failure, mode); stickyError.current = true; setError(failure instanceof Error ? failure.message : 'Unable to start this search.'); }
        finally { mutating.current = false; setBusy(false); }
    }
    async function cancel() {
        if (busy || !queryId) return;
        mutating.current = true; read.current?.abort(); epoch.current += 1; stickyError.current = false; setBusy(true); setError('');
        try { await searchAction({ action: 'cancel', queryId }); }
        catch (failure) { stickyError.current = true; setError(failure instanceof Error ? failure.message : 'Unable to cancel this search.'); }
        finally { mutating.current = false; setBusy(false); setLoading(true); setRevision(value => value + 1); }
    }
    async function retryIndex() {
        if (busy || active || !snapshot?.coverage.retryable) return;
        mutating.current = true; read.current?.abort(); epoch.current += 1; stickyError.current = false;
        setBusy(true); setError(''); setNotice('');
        try {
            const result = await searchAction({ action: 'retryIndex', scope, readyOnly, includeCv: cvMode });
            clearSearch();
            setNotice(`${result.retried} ${cvMode ? 'indexing job' : 'profile'}${result.retried === 1 ? '' : 's'} queued for indexing.${result.remainingFailed > 0 ? ` ${result.remainingFailed} ${cvMode ? 'indexing jobs' : 'profiles'} still need a retry; use Retry failed indexing again.` : ''} Run the search again after indexing finishes for updated results.`);
        } catch (failure) { clearRestrictedResults(failure); stickyError.current = true; setError(failure instanceof Error ? failure.message : 'Unable to retry indexing.'); }
        finally { mutating.current = false; setBusy(false); setLoading(true); setRevision(value => value + 1); }
    }
    const invalidated = searchInvalidated(snapshot?.errorCode);
    const coverage = invalidated ? null : snapshot?.coverage;
    const showCv = snapshot?.includeCv === true && !!coverage?.cv;
    const overCapacity = snapshot?.errorCode === 'SEARCH_CAPACITY' || snapshot?.capacity?.withinLimit === false;
    const fallback = cvMode && (overCapacity || snapshot?.errorCode === 'CV_ACCESS_CHANGED' || cvAvailable === false);
    return <section className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        <PageHeader title="Search candidates"
            actions={<div className="flex flex-wrap gap-2"><Button asChild variant="outline"><Link href="/staff/candidates">Candidate directory</Link></Button><Button asChild variant="outline"><Link href="/staff/telegram-intake">Review proposals</Link></Button></div>} />
        <Card className="p-5"><form className="space-y-4" onSubmit={event => { event.preventDefault(); void submit(); }}>
            <div className="space-y-2"><Label htmlFor="profile-search-query">Who are you looking for?</Label><Textarea id="profile-search-query" value={query} rows={2} maxLength={2000} disabled={busy || active} onChange={event => setQuery(event.target.value)} placeholder="e.g. Solidity engineer, remote, Europe" /></div>
            <details className="text-sm"><summary className="cursor-pointer">Search options</summary><div className="mt-3 space-y-3">            <div className="flex flex-wrap items-end gap-4"><div className="space-y-2"><Label htmlFor="profile-search-scope">Search in</Label><select id="profile-search-scope" className="h-9 w-full rounded-lg border border-input bg-card px-3 text-sm" value={scope} disabled={busy || active} onChange={event => clearSearch(event.target.value as Scope)}>{Object.entries(searchScopeLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div><label className="flex items-center gap-2 py-2 text-sm"><input type="checkbox" checked={readyOnly} disabled={busy || active || scope === 'approved'} onChange={event => clearSearch(scope, event.target.checked)} />Ready drafts only</label></div>
            {scope !== 'my_drafts' && (cvAvailable || includeCv) ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={includeCv} disabled={busy || active || (!cvAvailable && !includeCv)} onChange={event => clearSearch(scope, readyOnly, event.target.checked)} />Include CVs</label> : null}

</div></details>
            <div className="flex flex-wrap gap-2"><Button type="submit" disabled={busy || active || !query.trim() || cvAvailable === null}><Search />{busy ? 'Searching…' : 'Search'}</Button>{active ? <Button type="button" variant="outline" disabled={busy} onClick={() => void cancel()}>Cancel search</Button> : null}{queryId ? <Button type="button" variant="ghost" size="icon" aria-label="Refresh search" disabled={busy || loading} onClick={refresh}><RefreshCw /></Button> : null}{denied && queryId ? <Button type="button" variant="outline" disabled={busy} onClick={() => clearSearch()}>Start a new search</Button> : null}</div>
        </form></Card>
        {fallback ? <div className="space-y-2 rounded-lg border border-border p-4 text-sm"><p>{overCapacity ? 'Too many CVs to search.' : snapshot?.errorCode === 'CV_ACCESS_CHANGED' ? 'CV access changed. Search again.' : 'CV search unavailable.'}</p><Button variant="outline" size="sm" disabled={busy || active || !query.trim()} onClick={() => void submit(false)}>Search profiles only</Button></div> : null}
        {error ? <div role="alert" className="space-y-3 rounded-lg border border-border p-4 text-sm"><p>{error}</p><Button variant="outline" size="sm" disabled={busy} onClick={refresh}>Retry</Button></div> : null}
        {notice ? <p role="status" className="text-sm">{notice}</p> : null}
        {loading ? <p role="status" className="text-xs text-muted-foreground">Loading search status…</p> : null}
        {coverage && (hasIncompleteCoverage(coverage) || !snapshot?.workerAvailable) ? <details className="rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
            <summary className="cursor-pointer">{!snapshot?.workerAvailable ? 'Search temporarily unavailable' : 'Some candidates are still processing'}</summary>
            <div className="mt-3 space-y-2">
                <p>{(showCv ? coverage.fullyIndexed ?? coverage.indexed : coverage.indexed).toLocaleString()} / {coverage.eligible.toLocaleString()} ready · {coverage.pending.toLocaleString()} processing · {coverage.failed.toLocaleString()} need attention</p>
                {showCv ? <p>CVs: {coverage.cv!.indexed.toLocaleString()} / {coverage.cv!.eligible.toLocaleString()} ready</p> : null}
                {coverage.retryable > 0 ? <Button variant="outline" size="sm" disabled={busy || loading || active} onClick={() => void retryIndex()}>Retry processing</Button> : null}
                {!snapshot?.workerAvailable ? <Link href="/staff/candidates" className="inline-block underline">Search by name or email</Link> : null}
            </div>
        </details> : null}
        {snapshot?.status && snapshot.status !== 'completed' ? <div role="status" className="space-y-2"><h2 className="font-medium">{searchStatusLabel(snapshot.status, snapshot.workerAvailable)}</h2>{snapshot.errorCode && !fallback ? <p className="text-sm text-muted-foreground">{searchGuidance(snapshot.errorCode)}</p> : null}{invalidated && (!cvMode || cvAvailable) ? <Button variant="outline" size="sm" disabled={busy || !query.trim()} onClick={() => void submit()}>Run a new search</Button> : null}</div> : null}
        {snapshot?.status === 'completed' ? <div className="space-y-4">
            <div className="space-y-2"><h2 className="font-medium">Results</h2>{coverage?.corpusChanged ? <p className="rounded-lg border border-border p-3 text-sm">Candidates changed. Search again for current results.</p> : null}</div>
            {!snapshot.results?.length ? <Card className="p-6"><h3 className="font-medium">{cursors.length > 1 ? 'No results on this page' : 'No matches yet'}</h3><p className="mt-2 text-sm text-muted-foreground">{coverage && hasIncompleteCoverage(coverage) ? 'Still processing. Try again shortly.' : 'Try another description.'}</p></Card> : snapshot.results.map(result => <Card key={`${result.sourceType}-${result.sourceId}`} className="space-y-3 p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-medium">{validResultHref(result) ? <a href={validResultHref(result)!} className="underline-offset-4 hover:underline">{result.displayName || 'Unnamed profile'}</a> : result.displayName || 'Unnamed profile'}</h3>{result.headline ? <p className="mt-1 text-sm text-muted-foreground">{result.headline}</p> : null}</div><Badge variant="secondary">{result.sourceType === 'draft' ? 'Draft' : 'Candidate'}</Badge></div><p className="text-xs text-muted-foreground">{result.location || 'Location unknown'} · {result.hasCv ? 'CV' : 'No CV'}</p>{result.sourceType === 'draft' ? <p className="text-xs text-muted-foreground">{result.missingFields.length ? `Still needed: ${result.missingFields.map(field => missingLabels[field] ?? field).join(', ')}` : 'Required details present'}</p> : null}<blockquote className="border-l-2 border-border pl-3"><p className="break-words text-xs font-medium">{result.matchedComponent === 'cv' ? `CV excerpt${result.matchedDocument?.filename ? ` · ${result.matchedDocument.filename}` : ''}` : 'Profile excerpt'}</p><p className="mt-1 whitespace-pre-wrap break-words text-sm">{result.matchedText}</p></blockquote></Card>)}
            <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">Page {cursors.length}</p><div className="flex gap-2"><Button variant="outline" size="sm" disabled={loading || busy || cursors.length === 1} onClick={() => { setCursors(stack => stack.slice(0, -1)); setLoading(true); }}>Previous</Button><Button variant="outline" size="sm" disabled={loading || busy || !snapshot.nextAfter} onClick={() => { setCursors(stack => [...stack, snapshot.nextAfter!]); setLoading(true); }}>Next</Button></div></div>
        </div> : null}

    </section>;
}
