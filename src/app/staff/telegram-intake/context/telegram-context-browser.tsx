'use client';

import { staffWorkspaceFetch } from '@/lib/staff-workspace-fetch';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/staff-preview/shared';
import { Button } from '@/components/staff-ui/button';
import { Card } from '@/components/staff-ui/card';
import { Input } from '@/components/staff-ui/input';
import { Label } from '@/components/staff-ui/label';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/staff-ui/dialog';
import { StaffDate } from '../../staff-date';
import { StaffAuthRecoveryPrompt } from '../../auth-recovery';
import { staffAuthRecovery } from '@/lib/staff-auth-recovery';
import { Chat, Message, SearchFilters, contextUrl, forwardedLabel, searchPayload, senderLabel, retainedMessageText, pendingFilterChanges, conversationDeepLink, SourceUpdateStatus, sourceStatusLabel, nativeFeedLabel, nativeRepairPending, sourceSummary } from './context-model';

const endpoint = '/api/staff/telegram-context';
const emptyFilters: SearchFilters = { query: '', chatId: '', sender: '', from: '', to: '', attachmentsOnly: false };
type SearchResult = { results: Message[]; nextAfter: string | null; coverage: { retainedMessages: number }; query: string };
type Conversation = { chat: Chat; messages: Message[]; anchorUnavailable: boolean; olderBefore: string | null; newerAfter: string | null };
class ContextError extends Error { constructor(public status: number) { super(status === 400 || status === 422 ? 'Check your search terms and filters. Include a word or phrase to search for.' : status === 401 || status === 428 ? 'Verify your access to continue.' : status === 403 ? 'You no longer have access to these private conversations.' : status === 404 ? 'This conversation source is unavailable or has been removed.' : 'Conversation search is temporarily unavailable. Please retry.'); } }

export function TelegramContextBrowser() {
    const [filters, setFilters] = useState<SearchFilters>(emptyFilters);
    const [submitted, setSubmitted] = useState<SearchFilters | null>(null);
    const [result, setResult] = useState<SearchResult | null>(null);
    const [chats, setChats] = useState<Chat[]>([]);
    const [chatQuery, setChatQuery] = useState('');
    const [chatCursors, setChatCursors] = useState<(string | null)[]>([null]);
    const [resultCursors, setResultCursors] = useState<(string | null)[]>([null]);
    const [appliedChatQuery, setAppliedChatQuery] = useState('');
    const [chatAfter, setChatAfter] = useState<string | null>(null);
    const [chatError, setChatError] = useState('');
    const [chatLoading, setChatLoading] = useState(false);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [target, setTarget] = useState<{ chatId: string; anchor?: string } | null>(null);
    const [conversation, setConversation] = useState<Conversation | null>(null);
    const [contextLoading, setContextLoading] = useState(false);
    const [contextError, setContextError] = useState('');
    const [sourceRecords, setSourceRecords] = useState<{ source: SourceUpdateStatus[]; sourceDialog: SourceUpdateStatus[] }>({ source: [], sourceDialog: [] });
    const [sourceBusy, setSourceBusy] = useState({ source: false, sourceDialog: false });
    const sourceLoading = sourceBusy.source || sourceBusy.sourceDialog;
    const [accessBlocked, setAccessBlocked] = useState(false);
    const [sourceError, setSourceError] = useState('');
    const controllers = useRef<Record<string, AbortController>>({});
    const invalidated = useRef(false);
    const loadVersions = useRef({ chats: 0, search: 0, context: 0, source: 0, sourceDialog: 0 });
    const searchButton = useRef<HTMLButtonElement>(null);
    const requestedMessage = useRef<HTMLDivElement>(null);
    const [selectedChat, setSelectedChat] = useState<Chat | null>(null);

    const clearPrivate = useCallback(() => {
        invalidated.current = true; setAccessBlocked(true);
        Object.values(controllers.current).forEach(controller => controller.abort());
        setResult(null); setConversation(null); setChats([]); setFilters(emptyFilters); setSubmitted(null); setChatQuery(''); setChatAfter(null); setChatCursors([null]); setResultCursors([null]); setAppliedChatQuery(''); setTarget(null); setSelectedChat(null);
        setLoading(false); setChatLoading(false); setContextLoading(false); setSourceRecords({ source: [], sourceDialog: [] }); setSourceError(''); setSourceBusy({ source: false, sourceDialog: false });
    }, []);
    const read = useCallback(async <T,>(key: string, url: string, body?: unknown): Promise<T | null> => {
        if (invalidated.current) return null;
        controllers.current[key]?.abort();
        const controller = new AbortController(); controllers.current[key] = controller;
        const epoch = staffAuthRecovery.requestEpoch();
        try {
            const response = await staffWorkspaceFetch(url, { cache: 'no-store', signal: controller.signal, ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
            if (controller.signal.aborted || invalidated.current) return null;
            if (!response.ok) {
                if ([401, 403, 428].includes(response.status)) { clearPrivate(); staffAuthRecovery.require(response.status, epoch); }
                throw new ContextError(response.status);
            }
            const data = await response.json();
            if (controller.signal.aborted || invalidated.current || epoch !== staffAuthRecovery.requestEpoch()) return null;
            staffAuthRecovery.accepted(epoch);
            return data;
        } catch (failure) {
            if (controller.signal.aborted && !(failure instanceof ContextError)) return null;
            if (failure instanceof ContextError) throw failure;
            throw new Error('Unable to reach conversation search. Check your network connection and retry. Saved messages remain searchable when Telegram sync is offline.');
        }
    }, [clearPrivate]);
    const loadSourceStatus = useCallback(async (chatIds: string[], key: 'source' | 'sourceDialog' = 'source') => {
        if (invalidated.current) return;
        const version = ++loadVersions.current[key];
        setSourceBusy(current => ({ ...current, [key]: true })); setSourceError(''); setSourceRecords(current => ({ ...current, [key]: [] }));
        if (!chatIds.length) { setSourceBusy(current => ({ ...current, [key]: false })); return; }
        const params = new URLSearchParams(); chatIds.forEach(id => params.append('chatId', id));
        try {
            const data = await read<SourceUpdateStatus[]>(key, `/api/staff/telegram-source-updates?${params}`);
            if (data) setSourceRecords(current => ({ ...current, [key]: data }));
        } catch (failure) {
            if (version === loadVersions.current[key]) {
                if (failure instanceof ContextError && [401, 403, 428].includes(failure.status)) setSourceError(failure.message);
                else if (!invalidated.current) setSourceError('Retained-message check status is unavailable. Retry to check it; stored keyword search is still available.');
            }
        } finally {
            if (version === loadVersions.current[key] && !controllers.current[key]?.signal.aborted) setSourceBusy(current => ({ ...current, [key]: false }));
        }
    }, [read]);
    function freshness(chatId: string) {
        const source = [...sourceRecords.sourceDialog, ...sourceRecords.source].find(row => row.chatId === chatId);
        if (!source) return <p className="text-xs text-muted-foreground">{sourceLoading ? 'Loading retained-message check status…' : 'Retained-message check status unavailable for this chat.'}</p>;
        return <div className="space-y-2 text-xs text-muted-foreground">
            <p>{sourceSummary(source)}</p>
            {nativeRepairPending(source) ? <p className="font-medium">Some saved messages may be out of date. History repair is pending.</p> : null}
            {source.needsReextraction ? <p className="font-medium">Source changed. Candidate re-extraction is pending; drafts may contain an earlier version.</p> : null}
            <details className="space-y-2">
                <summary className="cursor-pointer rounded-sm text-foreground underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Update check details</summary>
                <div className="space-y-1 border-l pl-3">
                    <p>{sourceStatusLabel(source)}</p>
                    {nativeFeedLabel(source) ? <p>{nativeFeedLabel(source)}</p> : null}
                    {source.mode === 'native_updates_with_reconciliation' ? <>
                        <p>Last update check: {source.lastNativeAt ? <StaffDate value={source.lastNativeAt} kind="timestamp" /> : 'Not recorded'}. Some saved messages may still be out of date.</p>
                        <p>Catch-up requested: {source.repairRequestedAt ? <StaffDate value={source.repairRequestedAt} kind="timestamp" /> : 'Not recorded'}.</p>
                        <p>Last catch-up completed: {source.repairCompletedAt ? <StaffDate value={source.repairCompletedAt} kind="timestamp" /> : 'Not recorded'}.</p>
                        {nativeRepairPending(source) ? <p>Paused or offline chats cannot finish repair until checks resume.</p> : null}
                    </> : null}
                    <p>Last message check: {source.lastCheckedAt ? <StaffDate value={source.lastCheckedAt} kind="timestamp" /> : 'Not checked yet'}.</p>
                    <p>Last completed check: {source.lastCycleAt ? <StaffDate value={source.lastCycleAt} kind="timestamp" /> : 'No completed check recorded'}.</p>
                </div>
            </details>
        </div>;
    }
    const loadChats = useCallback(async (after: string | null = null, query = '', cursors: (string | null)[] = [null]) => {
        if (invalidated.current) return;
        controllers.current.source?.abort(); setSourceRecords(current => ({ ...current, source: [] }));
        const version = ++loadVersions.current.chats;
        setChatLoading(true); setChatError(''); setChats([]); setChatCursors(cursors); setAppliedChatQuery(query);
        try { const data = await read<{ chats: Chat[]; nextAfter: string | null }>('chats', endpoint, { action: 'chats', query, after }); if (data) { setChats(data.chats); setChatAfter(data.nextAfter); await loadSourceStatus(data.chats.map(chat => chat.id)); } }
        catch (failure) { if (version === loadVersions.current.chats) setChatError((failure as Error).message); }
        finally { if (version === loadVersions.current.chats && !controllers.current.chats?.signal.aborted) setChatLoading(false); }
    }, [read, loadSourceStatus]);
    async function search(next: SearchFilters, after: string | null = null, cursors: (string | null)[] = [null]) {
        if (invalidated.current) return;
        const version = ++loadVersions.current.search;
        setLoading(true); setError(''); setResult(null); setSubmitted(next); setResultCursors(cursors);
        try { const data = await read<SearchResult>('search', endpoint, searchPayload(next, after)); if (data) setResult(data); }
        catch (failure) { if (version === loadVersions.current.search) setError((failure as Error).message); }
        finally { if (version === loadVersions.current.search && !controllers.current.search?.signal.aborted) setLoading(false); }
    }
    const loadContext = useCallback(async (next: { chatId: string; anchor?: string; before?: string; after?: string }) => {
        if (invalidated.current) return;
        controllers.current.sourceDialog?.abort(); setSourceRecords(current => ({ ...current, sourceDialog: [] }));
        const version = ++loadVersions.current.context;
        setContextLoading(true); setContextError(''); setConversation(null);
        try { const data = await read<Conversation>('context', contextUrl(next.chatId, next)); if (data) { setConversation(data); await loadSourceStatus([data.chat.id], 'sourceDialog'); } }
        catch (failure) { if (version === loadVersions.current.context) setContextError((failure as Error).message); }
        finally { if (version === loadVersions.current.context && !controllers.current.context?.signal.aborted) setContextLoading(false); }
    }, [read, loadSourceStatus]);
    const openContext = useCallback((chatId: string, anchor?: string) => { const next = { chatId, anchor }; setTarget(next); void loadContext(next); }, [loadContext]);
    useEffect(() => {
        let cancelled = false;
        const pending = controllers.current;
        queueMicrotask(async () => {
            if (cancelled) return;
            await loadChats();
            if (cancelled) return;
            const params = new URLSearchParams(window.location.search);
            const deepLink = conversationDeepLink(params.get('chatId'), params.get('messageId'));
            if (deepLink) openContext(deepLink.chatId, deepLink.anchor);
        });
        const invalidate = () => clearPrivate();
        const retry = () => { invalidated.current = false; setAccessBlocked(false); setError(''); setContextError(''); void loadChats(); };
        window.addEventListener('staff-session-invalidated', invalidate); window.addEventListener('staff-auth-retry', retry);
        return () => { cancelled = true; Object.values(pending).forEach(controller => controller.abort()); window.removeEventListener('staff-session-invalidated', invalidate); window.removeEventListener('staff-auth-retry', retry); };
    }, [loadChats, openContext, clearPrivate]);
    useEffect(() => {
        if (!conversation || conversation.anchorUnavailable) return;
        const node = requestedMessage.current;
        if (!node) return;
        const frame = requestAnimationFrame(() => { node.scrollIntoView({ block: 'start' }); node.focus({ preventScroll: true }); });
        return () => cancelAnimationFrame(frame);
    }, [conversation, target?.anchor]);
    function field(key: keyof SearchFilters, value: string | boolean) { setFilters(current => ({ ...current, [key]: value })); }
    function messageCard(message: Message, inContext = false) {
        const forwarded = forwardedLabel(message.forwardedFrom);
        return <Card key={`${message.chatId}:${message.messageId}`} ref={inContext && target?.anchor === message.messageId ? requestedMessage : undefined} tabIndex={inContext && target?.anchor === message.messageId ? -1 : undefined} className={`min-w-0 space-y-3 p-4 ${inContext && target?.anchor === message.messageId ? 'border-primary focus-visible:ring-2 focus-visible:ring-ring' : ''}`}>
            <div className="flex flex-wrap justify-between gap-2"><p className="break-words font-medium">{inContext ? senderLabel(message.sender) : message.chatTitle || 'Untitled chat'}</p><span className="text-xs text-muted-foreground"><StaffDate value={message.sentAt} kind="timestamp" /></span></div>
            {!inContext ? <p className="break-words text-sm text-muted-foreground">{senderLabel(message.sender)}</p> : null}
            {message.sender?.displayName && message.sender.username ? <p className="break-words text-xs text-muted-foreground">@{message.sender.username.replace(/^@/, '')}</p> : null}
            {inContext && target?.anchor === message.messageId ? <p className="text-xs font-medium">Requested message</p> : null}
            <blockquote className={`whitespace-pre-wrap break-words text-sm ${inContext ? '' : 'line-clamp-5'}`}>{retainedMessageText(message, inContext)}</blockquote>
            {message.editedAt ? <p className="text-xs text-muted-foreground">Imported edit timestamp: <StaffDate value={message.editedAt} kind="timestamp" /></p> : null}
            {forwarded ? <p className="break-words text-xs text-muted-foreground">Forwarded from: {forwarded}</p> : null}
            {message.attachments.length ? <ul className="space-y-1 text-xs text-muted-foreground">{message.attachments.map((attachment, index) => <li className="break-words" key={`${index}:${attachment.id ?? 'attachment'}`}>{attachment.filename || attachment.kind} · {attachment.mimeType || attachment.kind}{attachment.sizeBytes !== null ? ` · ${attachment.sizeBytes.toLocaleString()} bytes` : ''} · Metadata only</li>)}</ul> : null}
            <div className="flex flex-wrap gap-2">{!inContext ? <Button variant="outline" size="sm" onClick={() => openContext(message.chatId, message.messageId)}>View conversation</Button> : null}{message.replyToMessageId ? <Button variant="ghost" size="sm" onClick={() => openContext(message.chatId, message.replyToMessageId!)}>View replied-to message</Button> : null}</div>
        </Card>;
    }
    return <section className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <PageHeader eyebrow="Private workspace" title="Search conversations" description="Find original messages in your retained Telegram history." actions={<Button asChild variant="outline"><Link href="/staff/telegram-intake/chats">Telegram chats</Link></Button>} />
        <p className="text-sm text-muted-foreground">Search messages you retained from current or previously connected accounts. Only you can read your imported conversations. Check each chat’s update status before relying on older messages.</p>
        <StaffAuthRecoveryPrompt />
        <div className="flex flex-wrap items-center gap-3"><Button variant="outline" disabled={sourceLoading || accessBlocked} onClick={async () => { await loadSourceStatus(chats.map(chat => chat.id)); if (target) await loadSourceStatus([target.chatId], 'sourceDialog'); }}>Refresh source update status</Button><p role="status" className="text-xs text-muted-foreground">{sourceLoading ? 'Checking source update status…' : sourceError || 'Status changes only when loaded or refreshed here.'}</p></div>
        <Card className="space-y-4 p-5">
            <form onSubmit={event => { event.preventDefault(); void loadChats(null, chatQuery); }} className="flex flex-wrap items-end gap-2"><div className="min-w-0 flex-1 space-y-2"><Label htmlFor="context-chat-query">Find an imported chat</Label><Input id="context-chat-query" value={chatQuery} maxLength={100} onChange={event => setChatQuery(event.target.value)} placeholder="Title or username" /></div><Button type="submit" variant="outline" disabled={chatLoading}>Find chats</Button></form>
            <div className="flex max-h-64 flex-wrap gap-2 overflow-y-auto rounded-lg p-1" aria-label="Imported chat choices" aria-busy={chatLoading}><Button variant={!filters.chatId ? 'secondary' : 'outline'} aria-pressed={!filters.chatId} onClick={() => { field('chatId', ''); setSelectedChat(null); }}>All imported chats</Button>{chats.map(chat => <div key={chat.id} className="w-full space-y-2 rounded-lg border p-3 sm:w-[calc(50%-0.25rem)]"><Button className="max-w-full whitespace-normal break-words text-left" variant={filters.chatId === chat.id ? 'secondary' : 'outline'} aria-pressed={filters.chatId === chat.id} onClick={() => { setSelectedChat(chat); field('chatId', chat.id); }}>{chat.title || 'Untitled chat'}{chat.username ? ` (@${chat.username})` : ''} · Account {chat.accountUserId}</Button>{freshness(chat.id)}</div>)}</div>
            <p role="status" className="text-sm text-muted-foreground">{chatLoading ? 'Loading chats…' : chatError || (!chats.length ? 'No imported chats match this chat search.' : '')}{filters.chatId ? ` Searching in ${selectedChat?.title || 'selected chat'}.` : ''}</p>
            <div className="flex flex-wrap items-center gap-2"><span className="text-xs">Chat page {chatCursors.length}</span><Button size="sm" variant="outline" disabled={chatLoading || chatCursors.length === 1} onClick={() => { const previous = chatCursors.slice(0, -1); void loadChats(previous.at(-1), appliedChatQuery, previous); }}>Previous chat page</Button>{chatAfter ? <Button size="sm" variant="outline" disabled={chatLoading} onClick={() => void loadChats(chatAfter, appliedChatQuery, [...chatCursors, chatAfter])}>Next chat page</Button> : null}</div>
        </Card>
        <Card className="p-5"><form className="grid gap-4 sm:grid-cols-2" onSubmit={event => { event.preventDefault(); void search(filters); }}>
            <div className="space-y-2 sm:col-span-2"><Label htmlFor="context-query">Message words or phrase</Label><Input id="context-query" required maxLength={500} value={filters.query} onChange={event => field('query', event.target.value)} placeholder='developer OR "product designer"' /><p className="text-xs text-muted-foreground">Use quotes for phrases, OR for alternatives, and a minus sign to exclude a word. Search terms stay in this page only.</p></div>
            <div className="space-y-2"><Label htmlFor="context-sender">Exact Telegram username</Label><Input id="context-sender" value={filters.sender} maxLength={33} onChange={event => field('sender', event.target.value)} placeholder="@username (optional)" /></div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={filters.attachmentsOnly} onChange={event => field('attachmentsOnly', event.target.checked)} />Messages with attachments only</label>
            <div className="space-y-2"><Label htmlFor="context-from">From date (UTC, inclusive)</Label><Input id="context-from" type="date" value={filters.from} onChange={event => field('from', event.target.value)} /></div><div className="space-y-2"><Label htmlFor="context-to">To date (UTC, inclusive)</Label><Input id="context-to" type="date" value={filters.to} min={filters.from || undefined} onChange={event => field('to', event.target.value)} /></div>
            <Button ref={searchButton} type="submit" disabled={loading || accessBlocked}>Search messages</Button>
        </form></Card>
        <div aria-live="polite" role="status" className="text-sm">{loading ? 'Searching retained messages…' : error || (result ? `${result.results.length} results on this page, newest first. ${result.coverage.retainedMessages.toLocaleString()} retained message records across your private imports.` : 'Enter words to search your private message history.')}</div>
        {pendingFilterChanges(filters, submitted) ? <p role="status" className="text-sm text-muted-foreground">You have unapplied filter changes. Search messages to apply them; result pagination uses your previous search.</p> : null}
        {chatQuery.trim() !== appliedChatQuery.trim() ? <p className="text-xs text-muted-foreground">Chat search changes are unapplied. Find chats to apply them; chat pagination uses the previous chat search.</p> : null}
        {error ? <Button variant="outline" disabled={loading || accessBlocked || !submitted} onClick={() => submitted && void search(submitted, resultCursors.at(-1), resultCursors)}>Retry search</Button> : null}
        {result && !result.results.length ? <Card className="p-5">No retained messages match these terms and filters. Try broader terms or another chat.</Card> : null}
        {result?.results.map(message => messageCard(message))}
        {result && submitted ? <div className="flex flex-wrap items-center gap-2"><span className="text-xs">Result page {resultCursors.length}</span><Button variant="outline" disabled={loading || resultCursors.length === 1} onClick={() => { const previous = resultCursors.slice(0, -1); void search(submitted, previous.at(-1), previous); }}>Previous result page</Button>{result.nextAfter ? <Button variant="outline" disabled={loading} onClick={() => void search(submitted, result.nextAfter, [...resultCursors, result.nextAfter])}>Next result page</Button> : null}</div> : null}
        <Dialog open={Boolean(target)} onOpenChange={open => { if (!open) { controllers.current.context?.abort(); setTarget(null); setConversation(null); setContextError(''); controllers.current.sourceDialog?.abort(); setSourceRecords(current => ({ ...current, sourceDialog: [] })); setSourceBusy(current => ({ ...current, sourceDialog: false })); } }}><DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto" onCloseAutoFocus={event => { event.preventDefault(); searchButton.current?.focus(); }}>
            <DialogTitle>{conversation?.chat.title || 'Private conversation'}</DialogTitle>{target?.anchor ? <Button variant="outline" disabled={contextLoading} onClick={() => void loadContext(target)}>Jump to requested message</Button> : null}<DialogDescription>Original retained messages in chronological order. Attachment details are metadata; files are not downloaded here.</DialogDescription>
            <p role="status" aria-live="polite" className="text-sm">{contextLoading ? 'Loading conversation…' : contextError}</p>
            {contextError && target ? <Button variant="outline" onClick={() => void loadContext(target)}>Retry conversation</Button> : null}
            {conversation ? <><p className="text-xs text-muted-foreground">Telegram account {conversation.chat.accountUserId}</p>{freshness(conversation.chat.id)}{conversation.anchorUnavailable ? <p role="status" className="rounded-lg border p-3 text-sm">The requested message is not retained or is no longer available. Available conversation messages are shown below.</p> : null}<div className="flex flex-wrap gap-2">{conversation.olderBefore ? <Button variant="outline" onClick={() => void loadContext({ chatId: conversation.chat.id, before: conversation.olderBefore! })}>Older messages</Button> : null}{conversation.newerAfter ? <Button variant="outline" onClick={() => void loadContext({ chatId: conversation.chat.id, after: conversation.newerAfter! })}>Newer messages</Button> : null}<Button variant="ghost" onClick={() => void loadContext({ chatId: conversation.chat.id })}>Latest messages</Button></div>{conversation.messages.length ? conversation.messages.map(message => messageCard(message, true)) : <p className="text-sm">No retained messages are available in this conversation.</p>}</> : null}
        </DialogContent></Dialog>
    </section>;
}
