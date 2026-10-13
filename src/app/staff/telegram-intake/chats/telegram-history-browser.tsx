'use client';

import { staffWorkspaceFetch } from '@/lib/staff-workspace-fetch';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CheckCircle2, MessageSquare, RefreshCw, Search } from 'lucide-react';
import { Button } from '@/components/staff-ui/button';
import { Card } from '@/components/staff-ui/card';
import { Input } from '@/components/staff-ui/input';
import { Label } from '@/components/staff-ui/label';
import { ProcessingStatus } from '../processing-status';
import { ChatRemoval, type RemovalReceipt } from './chat-removal';
import { TelegramConnectionBrowser } from '../connect/telegram-connection-browser';
import { chatDisplayTitle, discoveryPresentation, historyPollingDelay, importGuidance } from './history-model';

type Job = { id?: string; jobId?: string; status: string; importedMessages?: number; importedBytes?: number; errorCode: string | null; retryAt: string | null };
type Chat = { id: string; peer: { kind: string; id: string }; title: string; lastMessageAt?: string | null; username: string | null; selected: boolean; historyCompleted?: boolean; progress?: { lastProgressAt: string | null; oldestImportedAt: string | null; newestImportedAt: string | null }; removalState?: 'none' | 'pending' | 'device_pending' | 'completed'; removal?: RemovalReceipt | null; version: number; extractionEnabled: boolean; extractionPending: boolean; import: Job | null; sync?: { enabled: boolean; status: string; lastSyncedAt: string | null; nextSyncAt: string | null; checkpoint: string } };
type Snapshot = {
    connection: { id: string; generation: number; status: string; accountUserId: string | null } | null;
    account: { id: string; accountUserId: string } | null; canImport: boolean; blockedReason: string | null;
    discovery: { status: string; jobs: Job[] };
    totals: { chats: number; selected: number; messages: number; bytes: number; maxMessages: number; maxBytes: number };
    chats: Chat[]; nextCursor: string | null;
};

const endpoint = '/api/staff/telegram-history';
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

export function TelegramHistoryBrowser({ workspaceId, hostedEnabled = false, onboarding = false }: { workspaceId: string; hostedEnabled?: boolean; onboarding?: boolean }) {
    const router = useRouter();
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
    const view = 'all';
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
    const after = cursors[cursors.length - 1];
    const delay = historyPollingDelay(snapshot);
    const blocked = !snapshot?.canImport || busy || loading || denied;
    const discovery = discoveryPresentation(snapshot);
    const showChats = discovery.hasChats;
    const eligibleChats = snapshot?.chats.filter(chat => !chat.removalState || chat.removalState === 'none') ?? [];
    const selectedRows = useRef(new Map<string, Chat>());
    const autoDiscovery = useRef<string | null>(null);
    const [started, setStarted] = useState(false);
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
        const target = discovery.hasChats ? chatPanel.current : discoveryPanel.current;
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
                selectedRows.current.clear();
            }
            for (const chat of result.chats) {
                if (!chat.removalState || chat.removalState === 'none') selectedRows.current.set(chat.id, chat);
                else { selectedRows.current.delete(chat.id); setMarked(ids => ids.filter(id => id !== chat.id)); }
            }
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
            return false;
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

    function refreshStatus() { actionError.current = false; setDenied(false); setLoading(true); setRevision(value => value + 1); }
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
            return true;
        } catch (failure) {
            if (!mounted.current || controller.signal.aborted || revision !== requestId.current) return;
            actionError.current = true;
            setError(failure instanceof Error ? failure.message : 'Unable to apply this action.');
            if (failure instanceof HistoryError && [401, 403, 404, 428].includes(failure.status)) { setDenied(true); setSnapshot(null); setMarked([]); }
            return false;
        } finally {
            if (currentMutation.current === controller) currentMutation.current = null;
            mutating.current = false;
            if (mounted.current) { setBusy(false); setLoading(true); setRevision(value => value + 1); }
        }
    }
    function mark(ids: string[], checked: boolean) {
        setMarked(current => checked ? Array.from(new Set([...current, ...ids])).slice(0, 50) : current.filter(id => !ids.includes(id)));
    }
    async function start() {
        const chats = marked.map(id => selectedRows.current.get(id)).filter((chat): chat is Chat => Boolean(chat));
        if (!chats.length) return;
        const success = await act({ action: 'start', selected: true, chats: chats.map(chat => ({ chatId: chat.id, expectedVersion: chat.version })) }, '', true);
        if (success) { setStarted(true); if (onboarding) router.push('/staff/telegram-intake'); }
    }
    useEffect(() => {
        const account = snapshot?.connection?.accountUserId;
        if (!snapshot?.canImport || !account || snapshot.totals.chats || !['idle', 'not_started'].includes(snapshot.discovery.status) || busy || loading || denied || autoDiscovery.current === account) return;
        autoDiscovery.current = account;
        void act({ action: 'discover' }, 'Loading your chats…');
        // One discovery attempt per connected account; retries remain explicit.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [snapshot, busy, loading, denied]);

    return <section className="flex w-full flex-col gap-3">
        <header className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-2"><h1 className="text-lg font-semibold">{onboarding ? 'Connect Telegram' : 'Choose chats'}</h1>{!onboarding ? <Button asChild size="sm" variant="outline"><Link href="/staff/telegram-intake">Review proposals</Link></Button> : null}</header>
        {onboarding ? <ol aria-label="Telegram onboarding steps" className="flex w-full items-center gap-3 py-3 text-sm text-muted-foreground">
            {['Connect', 'Choose chats', 'Review'].map((label, index) => {
                const active = snapshot?.canImport ? 1 : 0;
                return <li key={label} aria-current={index === active ? 'step' : undefined} className={`flex min-w-0 flex-1 items-center gap-2 ${index === active ? 'font-medium text-foreground' : 'text-muted-foreground'}`}><span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${index <= active ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>{index < active ? <CheckCircle2 className="h-4 w-4" aria-label="Complete" /> : index + 1}</span>{label}</li>;
            })}
        </ol> : null}
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-3">
        {error ? <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4 text-sm"><p>{error}</p><Button variant="outline" onClick={refreshStatus} disabled={busy}>Retry</Button></div> : null}
        {snapshot?.canImport ? <details className="rounded-lg border bg-card px-3 py-2"><summary className="cursor-pointer text-sm font-medium"><CheckCircle2 className="mr-2 inline h-4 w-4 text-primary" />Telegram connected</summary><div className="mt-4"><TelegramConnectionBrowser workspaceId={workspaceId} hostedEnabled={hostedEnabled} blocked={denied} onConnectionChange={connectionChanged} onDenied={denyRemovalAccess} onChooseChats={chooseChats} chooseChatsLabel={null} /></div></details>
            : <TelegramConnectionBrowser workspaceId={workspaceId} hostedEnabled={hostedEnabled} blocked={denied} onConnectionChange={connectionChanged} onDenied={denyRemovalAccess} onChooseChats={chooseChats} chooseChatsLabel="Choose chats" />}
        {started || (snapshot?.totals.selected ?? 0) > 0 ? <ProcessingStatus reviewLink={false} /> : null}
        {snapshot?.canImport ? <Card className="overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b p-4"><h2 ref={chatPanel} tabIndex={-1} className="scroll-mt-24 font-semibold">Your chats</h2><Button ref={discoveryPanel} variant="ghost" size="sm" disabled={blocked || snapshot.discovery.status === 'active'} onClick={() => void act({ action: 'discover' }, 'Updating chats…')} aria-label="Refresh chat list"><RefreshCw className={snapshot.discovery.status === 'active' ? 'motion-safe:animate-spin' : ''} /></Button></div>
            <form className="flex items-center gap-2 p-4" onSubmit={event => { event.preventDefault(); setQuery(search.trim()); setCursors(['']); setLoading(true); }}>
                <Label htmlFor="telegram-chat-search" className="sr-only">Search chats</Label><Input id="telegram-chat-search" value={search} maxLength={100} onChange={event => setSearch(event.target.value)} placeholder="Search chats…" /><Button type="submit" variant="outline" size="icon" aria-label="Search chats" disabled={busy}><Search /></Button>
            </form>
            {eligibleChats.length ? <label className="flex cursor-pointer items-center gap-3 border-b px-4 pb-3 text-sm"><input type="checkbox" checked={allMarked} disabled={busy || loading} onChange={event => mark(eligibleChats.map(chat => chat.id), event.target.checked)} className="h-4 w-4 accent-primary" />Select this page</label> : null}
            <div aria-busy={loading || busy} className="divide-y">
                {!showChats || !snapshot.chats.length ? <div className="flex flex-col items-center gap-3 p-10 text-center"><MessageSquare className="h-7 w-7 text-muted-foreground" /><p role="status" className="text-sm text-muted-foreground">{snapshot.discovery.status === 'active' || loading ? 'Loading your chats…' : query ? 'No matching chats' : 'No chats found yet'}</p>{snapshot.discovery.status !== 'active' && !loading && !query ? <Button onClick={() => void act({ action: 'discover' }, 'Loading your chats…')} disabled={blocked}>Load chats</Button> : null}</div> : snapshot.chats.map(chat => <div key={chat.id} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40">
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3"><input type="checkbox" aria-label={`Select ${chatDisplayTitle(chat, snapshot.account?.accountUserId)}`} checked={marked.includes(chat.id)} disabled={busy || loading || Boolean(chat.removalState && chat.removalState !== 'none') || (marked.length >= 50 && !marked.includes(chat.id))} onChange={event => mark([chat.id], event.target.checked)} className="h-4 w-4 shrink-0 accent-primary" /><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted"><MessageSquare className="h-4 w-4" /></span><span className="min-w-0"><span className="block truncate text-sm font-medium">{chatDisplayTitle(chat, snapshot.account?.accountUserId)}</span>{chat.selected ? <span className="block text-xs text-muted-foreground">Connected for candidate updates</span> : chat.username ? <span className="block text-xs text-muted-foreground">@{chat.username}</span> : null}</span></label>
                    {chat.import?.errorCode ? <details className="text-xs"><summary className="cursor-pointer">Needs attention</summary><p className="max-w-48 pt-2">{importGuidance(chat.import)}</p><Button size="sm" variant="outline" disabled={blocked} onClick={() => void act({ action: 'resume', chatId: chat.id, expectedVersion: chat.version }, 'Retrying…')}>Retry</Button></details> : chat.selected ? <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" aria-label="Chat connected" /> : null}
                </div>)}
            </div>
            {snapshot.nextCursor || cursors.length > 1 ? <div className="flex justify-between border-t p-3"><Button size="sm" variant="ghost" disabled={loading || busy || cursors.length === 1} onClick={() => { setCursors(stack => stack.slice(0, -1)); setLoading(true); }}>Previous</Button><Button size="sm" variant="ghost" disabled={loading || busy || !snapshot.nextCursor} onClick={() => { setCursors(stack => [...stack, snapshot.nextCursor!]); setLoading(true); }}>More chats</Button></div> : null}
            <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t bg-card p-4"><span className="text-sm text-muted-foreground" role="status">{marked.length} selected{marked.length === 50 ? ' · Maximum 50 per import' : ''}</span><Button disabled={blocked || !marked.length} onClick={() => void start()}>{busy ? 'Starting…' : 'Start'}</Button></div>
        </Card> : null}
        {notice ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}
        {snapshot && snapshot.totals.messages >= snapshot.totals.maxMessages ? <p role="alert" className="text-sm">Storage is full. Review pending proposals to release their sources.</p> : null}
        {showChats ? <details className="text-sm text-muted-foreground"><summary className="cursor-pointer">Connected chats</summary><div className="mt-3 space-y-3">{snapshot?.chats.filter(chat => chat.selected || (chat.removalState && chat.removalState !== 'none')).map(chat => <div key={chat.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"><span>{chatDisplayTitle(chat, snapshot.account?.accountUserId)}</span><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={blocked} onClick={() => void act({ action: chat.import?.status === 'paused' ? 'resume' : 'pause', chatId: chat.id, expectedVersion: chat.version }, 'Chat updated.')}>{chat.import?.status === 'paused' ? 'Resume' : 'Pause'}</Button><ChatRemoval chatId={chat.id} title={chat.title} state={chat.removalState} receipt={chat.removal} disabled={busy || loading} accessBlocked={denied} connected={Boolean(snapshot.canImport)} onChanged={refreshStatus} onDenied={denyRemovalAccess} /></div></div>)}</div></details> : null}
        </div>
    </section>;
}
