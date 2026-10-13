'use client';

import { staffWorkspaceFetch } from '@/lib/staff-workspace-fetch';

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
import { ChatRemoval, type RemovalReceipt } from './chat-removal';
import { StaffDate } from '../../staff-date';
import { extractionEndpoint } from '../extraction/extraction-api';
import { extractionSelection } from '../extraction/retention-model';
import { TelegramConnectionBrowser } from '../connect/telegram-connection-browser';
import { byteLabel, chatDisplayTitle, connectionGuidance, discoveryPresentation, historyPollingDelay, historyViews, importActions, importGuidance, importStatus, selectionPayload, syncStatus } from './history-model';

type Job = { id?: string; jobId?: string; status: string; importedMessages?: number; importedBytes?: number; errorCode: string | null; retryAt: string | null };
type Chat = { id: string; peer: { kind: string; id: string }; title: string; lastMessageAt?: string | null; username: string | null; selected: boolean; historyCompleted?: boolean; progress?: { lastProgressAt: string | null; oldestImportedAt: string | null; newestImportedAt: string | null }; removalState?: 'none' | 'pending' | 'device_pending' | 'completed'; removal?: RemovalReceipt | null; version: number; extractionEnabled: boolean; extractionPending: boolean; import: Job | null; sync?: { enabled: boolean; status: string; lastSyncedAt: string | null; nextSyncAt: string | null; checkpoint: string } };
type Snapshot = {
    connection: { id: string; generation: number; status: string; accountUserId: string | null } | null;
    account: { id: string; accountUserId: string } | null; canImport: boolean; blockedReason: string | null;
    discovery: { status: string; jobs: Job[] };
    totals: { chats: number; selected: number; messages: number; bytes: number; maxMessages: number; maxBytes: number };
    chats: Chat[]; nextCursor: string | null;
};
type View = keyof typeof historyViews;

const endpoint = '/api/staff/telegram-history';
const dateLabel = (date: string) => <StaffDate value={date} kind="timestamp" />;
class HistoryError extends Error {
    constructor(public status: number) {
        super(status === 409 ? 'These chats changed. The latest status is loading; review it and retry your action.'
            : status === 403 || status === 401 || status === 428 ? 'You do not have access to these chats. Sign in again or contact your workspace administrator.'
                : status === 404 ? 'Telegram history import is not available in this workspace yet.'
                    : status === 400 || status === 422 ? 'This action could not be applied. Refresh the chats and check the selected rows.'
                        : 'The import service is temporarily unavailable. Retry to refresh the status.');
    }
}
async function request(url: string, init?: RequestInit) {
    const response = await staffWorkspaceFetch(url, { cache: 'no-store', ...init });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new HistoryError(response.status);
    if (!body) throw new HistoryError(503);
    return body;
}

export function TelegramHistoryBrowser({ workspaceId, hostedEnabled = false }: { workspaceId: string; hostedEnabled?: boolean }) {
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
    const currentMutation = useRef<AbortController | null>(null);
    const mutating = useRef(false);
    const actionError = useRef(false);
    const mounted = useRef(true);
    const visibleAccount = useRef<string | null>(null);
    const pollingSnapshot = useRef<Snapshot | null>(null);
    const discoveryPanel = useRef<HTMLButtonElement>(null);
    const chatPanel = useRef<HTMLHeadingElement>(null);
    const discoveryHeading = useRef<HTMLHeadingElement>(null);
    const after = cursors[cursors.length - 1];
    const delay = historyPollingDelay(snapshot);
    const blocked = !snapshot?.canImport || busy || loading || denied;
    const guidance = connectionGuidance(snapshot);
    const discovery = discoveryPresentation(snapshot);
    const showChats = discovery.hasChats;
    const eligibleChats = snapshot?.chats.filter(chat => !chat.removalState || chat.removalState === 'none') ?? [];
    const allMarked = Boolean(eligibleChats.length && eligibleChats.every(chat => marked.includes(chat.id)));
    const denyRemovalAccess = useCallback(() => {
        requestId.current += 1; currentRead.current?.abort(); currentMutation.current?.abort();
        setDenied(true); setSnapshot(null); setMarked([]); setSearch(''); setQuery(''); setCursors(['']); setNotice('');
        setError('Your workspace access needs verification. Refresh status to check it, or sign in again.');
    }, []);
    const connectionChanged = useCallback(() => {
        // The history endpoint remains authoritative about whether discovery is allowed.
        setRevision(value => value + 1);
    }, []);
    const chooseChats = useCallback(() => {
        const target = discovery.hasChats ? chatPanel.current : discoveryPanel.current?.disabled ? discoveryHeading.current : discoveryPanel.current;
        target?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        target?.focus({ preventScroll: true });
    }, [discovery.hasChats]);

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
            } else setMarked(ids => ids.filter(id => result.chats.some(chat => chat.id === id && (!chat.removalState || chat.removalState === 'none'))));
            visibleAccount.current = account;
            pollingSnapshot.current = result;
            setSnapshot(result);
            if (!actionError.current) setError('');
        } catch (failure) {
            if (id !== requestId.current || controller.signal.aborted || !mounted.current) return;
            if (failure instanceof HistoryError && failure.status === 400 && after) {
                // Account changes or an old cursor must not strand the reader
                // on a rejected page. Retry once without that cursor under the
                // current server-authorized account, clearing old row actions.
                requestId.current += 1; pollingSnapshot.current = null;
                setSnapshot(null); setCursors(['']); setMarked([]); setLoading(true); setError('');
                setNotice('The chat list changed. Showing its first page.');
                return;
            }
            setError(failure instanceof Error ? failure.message : 'Unable to refresh chats.');
            if (failure instanceof HistoryError && [401, 403, 404, 428].includes(failure.status)) { setDenied(true); setSnapshot(null); setMarked([]); }
        } finally {
            if (id === requestId.current && !controller.signal.aborted && mounted.current) setLoading(false);
        }
    }, [view, query, after]);

    useEffect(() => { mounted.current = true; return () => { mounted.current = false; currentRead.current?.abort(); currentMutation.current?.abort(); }; }, []);
    useEffect(() => {
        window.addEventListener('staff-session-invalidated', denyRemovalAccess);
        return () => window.removeEventListener('staff-session-invalidated', denyRemovalAccess);
    }, [denyRemovalAccess]);
    useEffect(() => {
        if (denied) return;
        let timer: ReturnType<typeof setTimeout>;
        let stopped = false;
        let cycle = 0;
        const started = Date.now();
        const poll = async (version = cycle) => {
            await load();
            if (!stopped && version === cycle && !document.hidden) timer = setTimeout(() => void poll(version), historyPollingDelay(pollingSnapshot.current, Date.now() - started));
        };
        const visibility = () => { cycle += 1; clearTimeout(timer); if (document.hidden) currentRead.current?.abort(); else void poll(); };
        void poll();
        document.addEventListener('visibilitychange', visibility);
        return () => { stopped = true; clearTimeout(timer); currentRead.current?.abort(); document.removeEventListener('visibilitychange', visibility); };
    }, [load, delay, denied, revision]);

    function refreshStatus() { actionError.current = false; setDenied(false); setCursors(['']); setMarked([]); setLoading(true); setRevision(value => value + 1); }
    function switchView(next: View) { setView(next); setCursors(['']); setMarked([]); setLoading(true); setRevision(value => value + 1); }
    async function act(payload: Record<string, unknown>, message: string, clearMarked = false, target = endpoint) {
        if (busy || loading || denied || (target === endpoint && !snapshot?.canImport)) return;
        mutating.current = true; const revision = ++requestId.current; currentRead.current?.abort();
        const controller = new AbortController(); currentMutation.current = controller;
        actionError.current = false; setBusy(true); setError(''); setNotice('');
        try {
            await request(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
            if (!mounted.current || controller.signal.aborted || revision !== requestId.current) return;
            setNotice(message);
            if (target === endpoint && payload.action === 'discover') { setCursors(['']); setMarked([]); }
            if (clearMarked) setMarked([]);
        } catch (failure) {
            if (!mounted.current || controller.signal.aborted || revision !== requestId.current) return;
            actionError.current = true;
            setError(failure instanceof Error ? failure.message : 'Unable to apply this action.');
            if (failure instanceof HistoryError && [401, 403, 404, 428].includes(failure.status)) { setDenied(true); setSnapshot(null); setMarked([]); }
        } finally {
            if (currentMutation.current === controller) currentMutation.current = null;
            mutating.current = false;
            if (mounted.current) { setBusy(false); setLoading(true); setRevision(value => value + 1); }
        }
    }
    function setExtraction(ids: string[], enabled: boolean) {
        const chats = extractionSelection(eligibleChats, ids, enabled);
        if (!chats.length) return;
        void act({ action: 'setExtraction', chats, enabled }, enabled
            ? 'Automatic extraction started. New imported messages will be processed as they arrive.'
            : 'Automatic extraction paused. Any current batch will finish; imports and saved drafts are kept.', false, extractionEndpoint);
    }
    function selectMarked(selected: boolean) {
        try { void act(selectionPayload(eligibleChats, marked, selected), selected ? 'Chat selection saved. History imports and ongoing sync are queued.' : 'Imports cancelled for the marked chats. Previously imported data remains private.', true); }
        catch (failure) { setError(failure instanceof Error ? failure.message : 'Select chats on this page.'); }
    }
    function actOnChat(chat: Chat, action: { action: string; selected?: boolean }) {
        const message = action.action === 'pause' ? 'Import and sync paused. Saved progress and imported data are retained.'
            : action.action === 'cancel' || action.selected === false ? 'Chat deselected. Imported data remains private; future pages are stopped.'
                : chat.historyCompleted || chat.import?.status === 'completed' ? 'Chat selection updated. Selected chats continuously sync new messages.' : 'Import requested from its saved position.';
        void act({ action: action.action, chatId: chat.id, expectedVersion: chat.version, ...(action.selected === undefined ? {} : { selected: action.selected }) }, message);
    }

    return <section className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <PageHeader eyebrow="Private workspace" title="Telegram" description="Connect your account, discover your chats, then choose conversations to import and search. Your imported history stays private."
            actions={<div className="flex flex-wrap gap-2"><Button asChild variant="outline"><Link href="/staff/telegram-intake/context">Search conversations</Link></Button><Button asChild variant="outline"><Link href="/staff/telegram-intake">Draft inbox</Link></Button><Button asChild variant="outline"><Link href="/staff/telegram-intake/extraction">Extraction progress</Link></Button><Button variant="outline" onClick={refreshStatus} disabled={busy || loading}><RefreshCw />Refresh status</Button></div>} />
        {error ? <div role="alert" className="rounded-lg border border-border p-4 text-sm"><p>{error}</p><Button variant="outline" className="mt-3" onClick={refreshStatus} disabled={busy}>Retry status</Button></div> : null}
        <TelegramConnectionBrowser workspaceId={workspaceId} hostedEnabled={hostedEnabled} blocked={denied} onConnectionChange={connectionChanged} onDenied={denyRemovalAccess} onChooseChats={chooseChats} chooseChatsLabel={discovery.connectionButton} />
        <Card className="space-y-4 p-5">
            <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 ref={discoveryHeading} tabIndex={-1} className="scroll-mt-24 font-semibold">2. Discover your chats</h2><p className="mt-1 max-w-3xl text-sm text-muted-foreground">Discovery lists available chats, including archived chats. It does not import their messages until you select them.</p></div><Button ref={discoveryPanel} className="scroll-mt-24" disabled={blocked || snapshot?.discovery.status === 'active'} onClick={() => void act({ action: 'discover' }, 'Chat discovery started. Existing selections are preserved.')}>{discovery.button}</Button></div>
            {snapshot && !snapshot.canImport ? <p className="text-sm text-muted-foreground">{guidance?.description}</p> : null}
            {snapshot?.canImport && !showChats ? <p role="status" className="rounded-lg bg-muted p-4 text-sm">{discovery.description}</p> : null}
            {snapshot ? <><p role="status" className="text-sm">{snapshot.discovery.status === 'active' ? 'Discovering chats in the background. You can start imports as chats appear.' : snapshot.discovery.status === 'completed' ? 'Chat discovery complete.' : snapshot.discovery.status === 'paused' ? 'Chat discovery needs attention. Check the details below, then refresh the chat list.' : 'Start discovery to see your Telegram chats.'} {snapshot.totals.chats.toLocaleString()} chats found · {snapshot.totals.selected.toLocaleString()} selected.</p>
                {snapshot.discovery.jobs.filter(job => job.errorCode || job.retryAt).map(job => <div key={job.id} className="text-sm text-muted-foreground"><p>{importGuidance(job)}</p>{job.retryAt ? <p>Next attempt: {dateLabel(job.retryAt)}</p> : null}</div>)}
                {(snapshot.account?.accountUserId || snapshot.connection?.accountUserId) ? <p className="text-xs text-muted-foreground">Telegram account ID: {snapshot.account?.accountUserId || snapshot.connection?.accountUserId}. History is kept separate for each account.</p> : null}
            </> : null}
        </Card>
        {snapshot && (showChats || snapshot.totals.messages > 0 || snapshot.canImport) ? <Card className="grid gap-4 p-5 sm:grid-cols-2"><h2 className="font-semibold sm:col-span-2">Private storage across your accounts</h2><div><p className="text-sm font-medium">{snapshot.totals.messages.toLocaleString()} messages stored</p><progress aria-label="Message capacity" className="mt-2 h-2 w-full" value={Math.min(snapshot.totals.messages, snapshot.totals.maxMessages)} max={snapshot.totals.maxMessages || 1} /><p className="mt-1 text-xs text-muted-foreground">Capacity: {snapshot.totals.maxMessages.toLocaleString()} messages</p></div><div><p className="text-sm font-medium">{byteLabel(snapshot.totals.bytes)} stored</p><progress aria-label="Storage capacity" className="mt-2 h-2 w-full" value={Math.min(snapshot.totals.bytes, snapshot.totals.maxBytes)} max={snapshot.totals.maxBytes || 1} /><p className="mt-1 text-xs text-muted-foreground">Capacity: {byteLabel(snapshot.totals.maxBytes)}. Imports pause at capacity and retain their position.</p></div></Card> : null}
        {showChats ? <>
        <div><h2 ref={chatPanel} tabIndex={-1} className="scroll-mt-24 font-semibold">3. Choose chats to import</h2><p className="mt-1 text-sm text-muted-foreground">{discovery.description} Most recent activity first.</p></div>
        <nav aria-label="Chat views" className="flex flex-wrap gap-2">{(Object.keys(historyViews) as View[]).map(key => <Button key={key} variant={view === key ? 'secondary' : 'ghost'} aria-pressed={view === key} disabled={busy} onClick={() => switchView(key)}>{historyViews[key]}</Button>)}</nav>
        <Card className="overflow-hidden">
            <form className="flex flex-wrap items-end gap-3 border-b border-border p-4" onSubmit={event => { event.preventDefault(); setQuery(search.trim()); setCursors(['']); setMarked([]); setLoading(true); setRevision(value => value + 1); }}><div className="min-w-48 flex-1 space-y-2"><Label htmlFor="telegram-chat-search">Search chats</Label><Input id="telegram-chat-search" value={search} maxLength={100} onChange={event => setSearch(event.target.value)} placeholder="Chat title or Telegram username" /></div><Button type="submit" variant="outline" disabled={busy}><Search />Search</Button></form>
            <div className="flex flex-wrap items-center gap-3 border-b border-border p-4"><span className="text-sm">{marked.length} marked on this page</span><Button size="sm" disabled={blocked || !marked.length} onClick={() => selectMarked(true)}>Import marked chats</Button><Button size="sm" variant="outline" disabled={blocked || !marked.length} onClick={() => selectMarked(false)}>Cancel marked imports</Button><Button size="sm" variant="outline" disabled={busy || loading || denied || !extractionSelection(eligibleChats, marked, true).length} onClick={() => setExtraction(marked, true)}>Start automatic extraction</Button><Button size="sm" variant="ghost" disabled={busy || loading || denied || !extractionSelection(eligibleChats, marked, false).length} onClick={() => setExtraction(marked, false)}>Pause automatic extraction</Button></div>
            <div aria-busy={loading || busy}>{loading ? <p role="status" className="px-5 py-3 text-sm text-muted-foreground">Loading chats…</p> : null}
                {!loading && snapshot && !snapshot.chats.length ? <div className="flex flex-col items-center gap-2 px-5 py-12 text-center"><MessageSquare className="h-7 w-7 text-muted-foreground" /><h2 className="font-medium">No chats in this view</h2><p className="text-sm text-muted-foreground">{snapshot.totals.chats ? 'Try another view or change your search.' : guidance?.empty || 'Discover your chats, then choose chats to import their messages.'}</p></div> : null}
                {snapshot?.chats.length ? <Table className="block md:table"><TableHeader className="block md:table-header-group"><TableRow className="block md:table-row"><TableHead className="block md:table-cell"><input type="checkbox" aria-label="Mark all chats on this page" checked={allMarked} disabled={busy || loading || denied || !eligibleChats.length} onChange={event => setMarked(event.target.checked ? eligibleChats.map(chat => chat.id) : [])} className="h-4 w-4 accent-primary" /><span className="ml-2 md:hidden">Mark all chats</span></TableHead><TableHead className="hidden md:table-cell">Chat</TableHead><TableHead className="hidden md:table-cell">Import status</TableHead><TableHead className="hidden md:table-cell">Import progress</TableHead><TableHead className="hidden md:table-cell">Actions</TableHead></TableRow></TableHeader><TableBody className="block space-y-3 md:table-row-group md:space-y-0">{snapshot.chats.map(chat => <TableRow key={chat.id} className="grid grid-cols-[2rem_minmax(0,1fr)] rounded-lg border md:table-row md:rounded-none md:border-x-0 md:border-t-0">
                    <TableCell className="block px-2 md:table-cell md:px-3"><input type="checkbox" aria-label={`Mark ${chatDisplayTitle(chat, snapshot.account?.accountUserId)}`} checked={marked.includes(chat.id)} disabled={busy || loading || denied || Boolean(chat.removalState && chat.removalState !== 'none')} onChange={event => setMarked(ids => event.target.checked ? [...ids, chat.id] : ids.filter(id => id !== chat.id))} className="h-4 w-4 accent-primary" /></TableCell>
                    <TableCell className="block min-w-0 md:table-cell md:max-w-xs"><p className="break-words font-medium">{chatDisplayTitle(chat, snapshot.account?.accountUserId)}</p>{(!chat.title || chat.title === 'Unavailable chat') ? <p className="mt-1 text-xs text-muted-foreground">A name was not included in the chat metadata. Refresh the chat list to check again.</p> : null}{chat.lastMessageAt ? <p className="mt-1 text-xs text-muted-foreground">Last activity: {dateLabel(chat.lastMessageAt)}</p> : null}{chat.username ? <p className="text-xs text-muted-foreground">@{chat.username}</p> : null}{chat.selected ? <Badge variant="outline" className="mt-2">Selected</Badge> : null}<p className="mt-2 text-xs text-muted-foreground">{chat.extractionEnabled ? chat.extractionPending ? 'Automatic extraction · Catch-up pending' : 'Automatic extraction on' : 'Automatic extraction off'}</p></TableCell>
                    <TableCell className="col-span-2 block min-w-0 pt-0 md:table-cell md:max-w-sm md:pt-3"><Badge variant="secondary">{importStatus(chat.import)}</Badge>{chat.sync ? <><p className="mt-2 text-xs">{syncStatus(chat.sync, hostedEnabled)}</p>{chat.sync.lastSyncedAt ? <p className="mt-1 text-xs text-muted-foreground">Last synced: {dateLabel(chat.sync.lastSyncedAt)}</p> : null}</> : null}{importGuidance(chat.import) ? <p className="mt-2 text-xs text-muted-foreground">{importGuidance(chat.import)}</p> : null}{chat.import?.retryAt ? <p className="mt-1 text-xs text-muted-foreground">Next attempt: {dateLabel(chat.import.retryAt)}</p> : null}</TableCell>
                    <TableCell className="col-span-2 block min-w-0 pt-0 md:table-cell md:pt-3">
                        <p>{(chat.import?.importedMessages ?? 0).toLocaleString()} imported historically · {byteLabel(chat.import?.importedBytes ?? 0)}</p>
                        {chat.progress?.lastProgressAt || chat.progress?.oldestImportedAt ? <details className="mt-2 text-xs text-muted-foreground">
                            <summary className="cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-primary">Import progress details</summary>
                            {chat.progress.lastProgressAt ? <p className="mt-2">Last progress: {dateLabel(chat.progress.lastProgressAt)}</p> : null}
                            {chat.progress.oldestImportedAt ? <p className="mt-1">History reached: {dateLabel(chat.progress.oldestImportedAt)}</p> : null}
                            <p className="mt-1">Historical import progress; some messages may since have been removed.</p>
                        </details> : null}
                    </TableCell>
                    <TableCell className="col-span-2 block min-w-0 pt-0 md:table-cell md:pt-3"><div className="flex flex-wrap gap-2">{(!chat.removalState || chat.removalState === 'none') && (chat.import?.importedMessages ?? 0) > 0 ? <Button asChild variant="outline" size="sm"><Link href={`/staff/telegram-intake/context?chatId=${encodeURIComponent(chat.id)}`}>View conversation</Link></Button> : null}{(!chat.removalState || chat.removalState === 'none') ? importActions(chat).map(action => <Button key={action.action} variant="outline" size="sm" disabled={blocked} onClick={() => actOnChat(chat, action)}>{action.label}</Button>) : null}{(!chat.removalState || chat.removalState === 'none') && (chat.selected || chat.extractionEnabled || (chat.import?.importedMessages ?? 0) > 0) ? <Button variant="outline" size="sm" disabled={busy || loading || denied} onClick={() => setExtraction([chat.id], !chat.extractionEnabled)}>{chat.extractionEnabled ? 'Pause automatic extraction' : 'Start automatic extraction'}</Button> : null}<ChatRemoval chatId={chat.id} title={chat.title} state={chat.removalState} receipt={chat.removal} disabled={busy || loading} accessBlocked={denied} connected={Boolean(snapshot.canImport)} onChanged={refreshStatus} onDenied={denyRemovalAccess} /></div></TableCell>
                </TableRow>)}</TableBody></Table> : null}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-4"><p className="text-xs text-muted-foreground">Page {cursors.length} · Up to 50 chats per page</p><div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy || loading || cursors.length === 1} onClick={() => { setCursors(stack => stack.slice(0, -1)); setMarked([]); setLoading(true); }}>Previous</Button><Button size="sm" variant="outline" disabled={busy || loading || !snapshot?.nextCursor} onClick={() => { setCursors(stack => [...stack, snapshot!.nextCursor!]); setMarked([]); setLoading(true); }}>Next</Button></div></div>
        </Card>
        </> : null}
        {notice ? <p role="status" className="text-sm">{notice}</p> : null}
        <div className="space-y-2 text-xs text-muted-foreground"><p>Selected chats are checked for new messages, edits and deletions after history import. Busy queues and Telegram waits can delay updates. Saved messages remain searchable during interruptions; some may be out of date until checks catch up. An unavailable source does not confirm a Telegram deletion.</p><p>{hostedEnabled ? 'Sync pauses when the Telegram service is offline and resumes from saved progress when it returns. Reconnect the same account if Telegram asks you to sign in again.' : 'Keep your Mac connector running for continuous sync. If it sleeps, progress is saved and sync catches up when it returns. Reconnect the same account if Telegram asks you to sign in again.'}</p><p>Pausing or cancelling stops future pages and keeps imported data private. Resuming continues from the saved position.</p><p>This imports message text and attachment details only. CV files are not downloaded or validated during history import. Extract candidates from imported chats to create private drafts for review. Only approved candidate records become shared. <Link className="underline underline-offset-4" href="/staff/candidates/search">Search profiles by meaning</Link>.</p></div>
    </section>;
}
