'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { MessageSquare, RefreshCw, Search } from 'lucide-react';
import { PageHeader } from '@/components/staff-preview/shared';
import { Badge } from '@/components/staff-ui/badge';
import { Button } from '@/components/staff-ui/button';
import { Card } from '@/components/staff-ui/card';
import { Input } from '@/components/staff-ui/input';
import { Label } from '@/components/staff-ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/staff-ui/table';
import { extractionEndpoint } from '../extraction/extraction-api';
import { extractionSelection } from '../extraction/retention-model';
import { byteLabel, historyPollingDelay, historyViews, importActions, importGuidance, importStatus, selectionPayload } from './history-model';

type Job = { id?: string; jobId?: string; status: string; importedMessages?: number; importedBytes?: number; errorCode: string | null; retryAt: string | null };
type Chat = { id: string; peer: { kind: string; id: string }; title: string; username: string | null; selected: boolean; version: number; extractionEnabled: boolean; extractionPending: boolean; import: Job | null };
type Snapshot = {
    connection: { id: string; generation: number; status: string; accountUserId: string | null } | null;
    account: { id: string; accountUserId: string } | null; canImport: boolean; blockedReason: string | null;
    discovery: { status: string; jobs: Job[] };
    totals: { chats: number; selected: number; messages: number; bytes: number; maxMessages: number; maxBytes: number };
    chats: Chat[]; nextCursor: string | null;
};
type View = keyof typeof historyViews;
const endpoint = '/api/staff/telegram-history';
const dateLabel = (date: string) => new Date(date).toLocaleString();
class HistoryError extends Error {
    constructor(public status: number) {
        super(status === 409 ? 'These chats changed. The latest status is loading; review it and retry your action.'
            : status === 403 || status === 401 ? 'You do not have access to these chats. Sign in again or contact your workspace administrator.'
                : status === 404 ? 'Telegram history import is not available in this workspace yet.'
                    : status === 400 || status === 422 ? 'This action could not be applied. Refresh the chats and check the selected rows.'
                        : 'The import service is temporarily unavailable. Retry to refresh the status.');
    }
}
async function request(url: string, init?: RequestInit) {
    const response = await fetch(url, { cache: 'no-store', ...init });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new HistoryError(response.status);
    if (!body) throw new HistoryError(503);
    return body;
}

export function TelegramHistoryBrowser() {
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
    const [view, setView] = useState<View>('all');
    const [search, setSearch] = useState('');
    const [query, setQuery] = useState('');
    const [cursors, setCursors] = useState<string[]>(['']);
    const [marked, setMarked] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [denied, setDenied] = useState(false);
    const [revision, setRevision] = useState(0);
    const requestId = useRef(0);
    const currentRead = useRef<AbortController | null>(null);
    const mutating = useRef(false);
    const actionError = useRef(false);
    const mounted = useRef(true);
    const visibleAccount = useRef<string | null>(null);
    const after = cursors[cursors.length - 1];
    const delay = historyPollingDelay(snapshot);
    const blocked = !snapshot?.canImport || busy || loading || denied;
    const allMarked = Boolean(snapshot?.chats.length && snapshot.chats.every(chat => marked.includes(chat.id)));

    const load = useCallback(async () => {
        if (mutating.current || document.hidden) return;
        const id = ++requestId.current;
        currentRead.current?.abort();
        const controller = new AbortController();
        currentRead.current = controller;
        try {
            const params = new URLSearchParams({ view, q: query });
            if (after) params.set('after', after);
            const result: Snapshot = await request(`${endpoint}?${params}`, { signal: controller.signal });
            if (id !== requestId.current || controller.signal.aborted || !mounted.current) return;
            const account = result.account?.accountUserId || result.connection?.accountUserId || null;
            if (visibleAccount.current && account && visibleAccount.current !== account) {
                setCursors(['']); setSearch(''); setQuery(''); setMarked([]);
            } else setMarked(ids => ids.filter(id => result.chats.some(chat => chat.id === id)));
            visibleAccount.current = account;
            setSnapshot(result);
            if (!actionError.current) setError('');
        } catch (failure) {
            if (id !== requestId.current || controller.signal.aborted || !mounted.current) return;
            setError(failure instanceof Error ? failure.message : 'Unable to refresh chats.');
            if (failure instanceof HistoryError && [401, 403, 404].includes(failure.status)) { setDenied(true); setSnapshot(null); setMarked([]); }
        } finally {
            if (id === requestId.current && !controller.signal.aborted && mounted.current) setLoading(false);
        }
    }, [view, query, after]);

    useEffect(() => { mounted.current = true; return () => { mounted.current = false; currentRead.current?.abort(); }; }, []);
    useEffect(() => {
        if (denied) return;
        let timer: ReturnType<typeof setTimeout>;
        let stopped = false;
        let cycle = 0;
        const poll = async (version = cycle) => {
            await load();
            if (!stopped && version === cycle && !document.hidden) timer = setTimeout(() => void poll(version), delay);
        };
        const visibility = () => { cycle += 1; clearTimeout(timer); if (document.hidden) currentRead.current?.abort(); else void poll(); };
        void poll();
        document.addEventListener('visibilitychange', visibility);
        return () => { stopped = true; clearTimeout(timer); currentRead.current?.abort(); document.removeEventListener('visibilitychange', visibility); };
    }, [load, delay, denied, revision]);

    function refreshStatus() { actionError.current = false; setDenied(false); setLoading(true); setRevision(value => value + 1); }
    function switchView(next: View) { setView(next); setCursors(['']); setMarked([]); setLoading(true); setRevision(value => value + 1); }
    async function act(payload: Record<string, unknown>, message: string, clearMarked = false, target = endpoint) {
        if (busy || loading || denied || (target === endpoint && !snapshot?.canImport)) return;
        mutating.current = true; requestId.current += 1; currentRead.current?.abort();
        actionError.current = false; setBusy(true); setError(''); setNotice('');
        try {
            await request(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
            if (!mounted.current) return;
            setNotice(message);
            if (clearMarked) setMarked([]);
        } catch (failure) {
            if (!mounted.current) return;
            actionError.current = true;
            setError(failure instanceof Error ? failure.message : 'Unable to apply this action.');
            if (failure instanceof HistoryError && [401, 403, 404].includes(failure.status)) { setDenied(true); setSnapshot(null); setMarked([]); }
        } finally {
            mutating.current = false;
            if (mounted.current) { setBusy(false); setLoading(true); setRevision(value => value + 1); }
        }
    }
    function setExtraction(ids: string[], enabled: boolean) {
        const chats = extractionSelection(snapshot?.chats ?? [], ids, enabled);
        if (!chats.length) return;
        void act({ action: 'setExtraction', chats, enabled }, enabled
            ? 'Automatic extraction started. New imported messages will be processed as they arrive.'
            : 'Automatic extraction paused. Any current batch will finish; imports and saved drafts are kept.', false, extractionEndpoint);
    }
    function selectMarked(selected: boolean) {
        try { void act(selectionPayload(snapshot?.chats ?? [], marked, selected), selected ? 'Chat selection saved. Incomplete histories are queued for import.' : 'Imports cancelled for the marked chats. Previously imported data remains private.', true); }
        catch (failure) { setError(failure instanceof Error ? failure.message : 'Select chats on this page.'); }
    }
    function actOnChat(chat: Chat, action: { action: string; selected?: boolean }) {
        const message = action.action === 'pause' ? 'Import paused. Its saved position and imported data are retained.'
            : action.action === 'cancel' || action.selected === false ? 'Chat deselected. Imported data remains private; future pages are stopped.'
                : chat.import?.status === 'completed' ? 'Chat selection updated. Its completed history is retained.' : 'Import requested from its saved position.';
        void act({ action: action.action, chatId: chat.id, expectedVersion: chat.version, ...(action.selected === undefined ? {} : { selected: action.selected }) }, message);
    }

    return <section className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <PageHeader eyebrow="Private workspace" title="Telegram chats" description="Choose chats to import their full available history into your private workspace."
            actions={<div className="flex flex-wrap gap-2"><Button asChild variant="outline"><Link href="/staff/telegram-intake">Draft inbox</Link></Button><Button asChild variant="outline"><Link href="/staff/telegram-intake/extraction">Extraction progress</Link></Button><Button asChild variant="outline"><Link href="/staff/telegram-intake/connect">Telegram connection</Link></Button><Button variant="outline" onClick={refreshStatus} disabled={busy || loading}><RefreshCw />Refresh status</Button></div>} />
        <p className="text-sm text-muted-foreground">Automatic extraction processes imported messages as history arrives. Pausing extraction keeps imports and saved drafts intact.</p>
        {error ? <div role="alert" className="rounded-lg border border-border p-4 text-sm"><p>{error}</p><Button variant="outline" className="mt-3" onClick={refreshStatus} disabled={busy}>Retry status</Button></div> : null}
        {snapshot && !snapshot.canImport ? <Card className="space-y-3 p-5"><h2 className="font-semibold">Connect Telegram to import chats</h2><p className="text-sm text-muted-foreground">Your existing private history remains available. Reconnect the same Telegram account to resume its interrupted imports. A different account has its own separate chat list.</p><Button asChild><Link href="/staff/telegram-intake/connect">Connect Telegram</Link></Button></Card> : null}
        <Card className="space-y-4 p-5">
            <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="font-semibold">Discover your chats</h2><p className="mt-1 max-w-3xl text-sm text-muted-foreground">Discovery lists available chats, including archived chats. It does not import their messages until you select them.</p></div><Button disabled={blocked || snapshot?.discovery.status === 'active'} onClick={() => void act({ action: 'discover' }, 'Chat discovery started. Existing selections are preserved.')}>{snapshot?.discovery.status === 'active' ? 'Discovering chats…' : snapshot?.account ? 'Refresh chat list' : 'Discover chats'}</Button></div>
            {snapshot ? <><p role="status" className="text-sm">{snapshot.discovery.status === 'active' ? 'Discovering chats in the background. You can start imports as chats appear.' : snapshot.discovery.status === 'completed' ? 'Chat discovery complete.' : snapshot.discovery.status === 'paused' ? 'Chat discovery needs attention. Check the details below, then refresh the chat list.' : 'Start discovery to see your Telegram chats.'} {snapshot.totals.chats.toLocaleString()} chats found · {snapshot.totals.selected.toLocaleString()} selected.</p>
                {snapshot.discovery.jobs.filter(job => job.errorCode || job.retryAt).map(job => <div key={job.id} className="text-sm text-muted-foreground"><p>{importGuidance(job)}</p>{job.retryAt ? <p>Next attempt: {dateLabel(job.retryAt)}</p> : null}</div>)}
                {(snapshot.account?.accountUserId || snapshot.connection?.accountUserId) ? <p className="text-xs text-muted-foreground">Telegram account ID: {snapshot.account?.accountUserId || snapshot.connection?.accountUserId}. History is kept separate for each account.</p> : null}
            </> : null}
        </Card>
        {snapshot ? <Card className="grid gap-4 p-5 sm:grid-cols-2"><h2 className="font-semibold sm:col-span-2">Private storage across your accounts</h2><div><p className="text-sm font-medium">{snapshot.totals.messages.toLocaleString()} messages stored</p><progress aria-label="Message capacity" className="mt-2 h-2 w-full" value={Math.min(snapshot.totals.messages, snapshot.totals.maxMessages)} max={snapshot.totals.maxMessages || 1} /><p className="mt-1 text-xs text-muted-foreground">Capacity: {snapshot.totals.maxMessages.toLocaleString()} messages</p></div><div><p className="text-sm font-medium">{byteLabel(snapshot.totals.bytes)} stored</p><progress aria-label="Storage capacity" className="mt-2 h-2 w-full" value={Math.min(snapshot.totals.bytes, snapshot.totals.maxBytes)} max={snapshot.totals.maxBytes || 1} /><p className="mt-1 text-xs text-muted-foreground">Capacity: {byteLabel(snapshot.totals.maxBytes)}. Imports pause at capacity and retain their position.</p></div></Card> : null}
        <nav aria-label="Chat views" className="flex flex-wrap gap-2">{(Object.keys(historyViews) as View[]).map(key => <Button key={key} variant={view === key ? 'secondary' : 'ghost'} aria-pressed={view === key} disabled={busy} onClick={() => switchView(key)}>{historyViews[key]}</Button>)}</nav>
        <Card className="overflow-hidden">
            <form className="flex flex-wrap items-end gap-3 border-b border-border p-4" onSubmit={event => { event.preventDefault(); setQuery(search.trim()); setCursors(['']); setMarked([]); setLoading(true); setRevision(value => value + 1); }}><div className="min-w-48 flex-1 space-y-2"><Label htmlFor="telegram-chat-search">Search chats</Label><Input id="telegram-chat-search" value={search} maxLength={100} onChange={event => setSearch(event.target.value)} placeholder="Chat title or Telegram username" /></div><Button type="submit" variant="outline" disabled={busy}><Search />Search</Button></form>
            <div className="flex flex-wrap items-center gap-3 border-b border-border p-4"><span className="text-sm">{marked.length} marked on this page</span><Button size="sm" disabled={blocked || !marked.length} onClick={() => selectMarked(true)}>Import marked chats</Button><Button size="sm" variant="outline" disabled={blocked || !marked.length} onClick={() => selectMarked(false)}>Cancel marked imports</Button><Button size="sm" variant="outline" disabled={busy || loading || denied || !extractionSelection(snapshot?.chats ?? [], marked, true).length} onClick={() => setExtraction(marked, true)}>Start automatic extraction</Button><Button size="sm" variant="ghost" disabled={busy || loading || denied || !extractionSelection(snapshot?.chats ?? [], marked, false).length} onClick={() => setExtraction(marked, false)}>Pause automatic extraction</Button></div>
            <div aria-busy={loading || busy}>{loading ? <p role="status" className="px-5 py-3 text-sm text-muted-foreground">Loading chats…</p> : null}
                {!loading && snapshot && !snapshot.chats.length ? <div className="flex flex-col items-center gap-2 px-5 py-12 text-center"><MessageSquare className="h-7 w-7 text-muted-foreground" /><h2 className="font-medium">No chats in this view</h2><p className="text-sm text-muted-foreground">{snapshot.totals.chats ? 'Try another view or change your search.' : 'Connect Telegram and discover chats to get started.'}</p></div> : null}
                {snapshot?.chats.length ? <Table><TableHeader><TableRow><TableHead><input type="checkbox" aria-label="Mark all chats on this page" checked={allMarked} disabled={busy || loading || denied} onChange={event => setMarked(event.target.checked ? snapshot.chats.map(chat => chat.id) : [])} className="h-4 w-4 accent-primary" /></TableHead><TableHead>Chat</TableHead><TableHead>Import status</TableHead><TableHead>Messages stored</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader><TableBody>{snapshot.chats.map(chat => <TableRow key={chat.id}>
                    <TableCell><input type="checkbox" aria-label={`Mark ${chat.title || 'Untitled chat'}`} checked={marked.includes(chat.id)} disabled={busy || loading || denied} onChange={event => setMarked(ids => event.target.checked ? [...ids, chat.id] : ids.filter(id => id !== chat.id))} className="h-4 w-4 accent-primary" /></TableCell>
                    <TableCell className="max-w-xs"><p className="break-words font-medium">{chat.title || 'Untitled chat'}</p>{chat.username ? <p className="text-xs text-muted-foreground">@{chat.username}</p> : null}{chat.selected ? <Badge variant="outline" className="mt-2">Selected</Badge> : null}<p className="mt-2 text-xs text-muted-foreground">{chat.extractionEnabled ? chat.extractionPending ? 'Automatic extraction · Catch-up pending' : 'Automatic extraction on' : 'Automatic extraction off'}</p></TableCell>
                    <TableCell className="max-w-sm"><Badge variant="secondary">{importStatus(chat.import)}</Badge>{importGuidance(chat.import) ? <p className="mt-2 text-xs text-muted-foreground">{importGuidance(chat.import)}</p> : null}{chat.import?.retryAt ? <p className="mt-1 text-xs text-muted-foreground">Next attempt: {dateLabel(chat.import.retryAt)}</p> : null}</TableCell>
                    <TableCell>{(chat.import?.importedMessages ?? 0).toLocaleString()}<p className="mt-1 text-xs text-muted-foreground">{byteLabel(chat.import?.importedBytes ?? 0)}</p></TableCell>
                    <TableCell><div className="flex flex-wrap gap-2">{importActions(chat).map(action => <Button key={action.action} variant="outline" size="sm" disabled={blocked} onClick={() => actOnChat(chat, action)}>{action.label}</Button>)}{chat.selected || chat.extractionEnabled || (chat.import?.importedMessages ?? 0) > 0 ? <Button variant="outline" size="sm" disabled={busy || loading || denied} onClick={() => setExtraction([chat.id], !chat.extractionEnabled)}>{chat.extractionEnabled ? 'Pause automatic extraction' : 'Start automatic extraction'}</Button> : null}</div></TableCell>
                </TableRow>)}</TableBody></Table> : null}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-4"><p className="text-xs text-muted-foreground">Page {cursors.length} · Up to 50 chats per page</p><div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy || loading || cursors.length === 1} onClick={() => { setCursors(stack => stack.slice(0, -1)); setMarked([]); setLoading(true); }}>Previous</Button><Button size="sm" variant="outline" disabled={busy || loading || !snapshot?.nextCursor} onClick={() => { setCursors(stack => [...stack, snapshot!.nextCursor!]); setMarked([]); setLoading(true); }}>Next</Button></div></div>
        </Card>
        {notice ? <p role="status" className="text-sm">{notice}</p> : null}
        <div className="space-y-2 text-xs text-muted-foreground"><p>Full history includes every message Telegram makes available at the start of each import. Deleted or inaccessible messages cannot be recovered; new messages after that snapshot are not included yet.</p><p>Keep your Mac connector running during imports. If it sleeps, progress is saved and imports can continue when it returns.</p><p>Pausing or cancelling stops future pages and keeps imported data private. Resuming continues from the saved position.</p><p>This imports message text and attachment details only. CV files are not downloaded or validated during history import. Extract candidates from imported chats to create private drafts for review. Only approved candidate records become shared. <Link className="underline underline-offset-4" href="/staff/candidates/search">Search profiles by meaning</Link>.</p></div>
    </section>;
}
