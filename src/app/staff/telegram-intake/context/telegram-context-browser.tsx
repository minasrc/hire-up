'use client';

import { useEffect, useRef, useState } from 'react';
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
import { Chat, Message, SearchFilters, contextUrl, forwardedLabel, searchPayload, senderLabel, messageExcerpt, pendingFilterChanges, conversationDeepLink } from './context-model';

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
    const controllers = useRef<Record<string, AbortController>>({});
    const invalidated = useRef(false);
    const loadVersions = useRef({ chats: 0, search: 0, context: 0 });
    const searchButton = useRef<HTMLButtonElement>(null);
    const selectedChat = useRef<Chat | null>(null);

    function clearPrivate() {
        invalidated.current = true;
        Object.values(controllers.current).forEach(controller => controller.abort());
        setResult(null); setConversation(null); setChats([]); setFilters(emptyFilters); setSubmitted(null); setChatQuery(''); setChatAfter(null); setChatCursors([null]); setResultCursors([null]); setAppliedChatQuery(''); setTarget(null); selectedChat.current = null;
        setLoading(false); setChatLoading(false); setContextLoading(false);
    }
    async function read<T>(key: string, url: string, body?: unknown): Promise<T | null> {
        if (invalidated.current) return null;
        controllers.current[key]?.abort();
        const controller = new AbortController(); controllers.current[key] = controller;
        const epoch = staffAuthRecovery.requestEpoch();
        try {
            const response = await fetch(url, { cache: 'no-store', signal: controller.signal, ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
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
            throw new Error('Unable to reach conversation search. Check your network connection and retry. Stored messages remain searchable when the Telegram connector is offline.');
        }
    }
    async function loadChats(after: string | null = null, query = chatQuery, cursors: (string | null)[] = [null]) {
        if (invalidated.current) return;
        const version = ++loadVersions.current.chats;
        setChatLoading(true); setChatError(''); setChats([]); setChatCursors(cursors); setAppliedChatQuery(query);
        try { const data = await read<{ chats: Chat[]; nextAfter: string | null }>('chats', endpoint, { action: 'chats', query, after }); if (data) { setChats(data.chats); setChatAfter(data.nextAfter); } }
        catch (failure) { if (version === loadVersions.current.chats) setChatError((failure as Error).message); }
        finally { if (version === loadVersions.current.chats && !controllers.current.chats?.signal.aborted) setChatLoading(false); }
    }
    async function search(next: SearchFilters, after: string | null = null, cursors: (string | null)[] = [null]) {
        if (invalidated.current) return;
        const version = ++loadVersions.current.search;
        setLoading(true); setError(''); setResult(null); setSubmitted(next); setResultCursors(cursors);
        try { const data = await read<SearchResult>('search', endpoint, searchPayload(next, after)); if (data) setResult(data); }
        catch (failure) { if (version === loadVersions.current.search) setError((failure as Error).message); }
        finally { if (version === loadVersions.current.search && !controllers.current.search?.signal.aborted) setLoading(false); }
    }
    async function loadContext(next: { chatId: string; anchor?: string; before?: string; after?: string }) {
        if (invalidated.current) return;
        const version = ++loadVersions.current.context;
        setContextLoading(true); setContextError(''); setConversation(null);
        try { const data = await read<Conversation>('context', contextUrl(next.chatId, next)); if (data) setConversation(data); }
        catch (failure) { if (version === loadVersions.current.context) setContextError((failure as Error).message); }
        finally { if (version === loadVersions.current.context && !controllers.current.context?.signal.aborted) setContextLoading(false); }
    }
    function openContext(chatId: string, anchor?: string) { const next = { chatId, anchor }; setTarget(next); void loadContext(next); }
    useEffect(() => {
        void loadChats();
        const params = new URLSearchParams(window.location.search);
        const chatId = params.get('chatId'); const anchor = params.get('messageId');
        const deepLink = conversationDeepLink(chatId, anchor);
        if (deepLink) openContext(deepLink.chatId, deepLink.anchor);
        const invalidate = () => clearPrivate();
        const retry = () => { invalidated.current = false; setError(''); setContextError(''); void loadChats(null, ''); };
        window.addEventListener('staff-session-invalidated', invalidate); window.addEventListener('staff-auth-retry', retry);
        return () => { Object.values(controllers.current).forEach(controller => controller.abort()); window.removeEventListener('staff-session-invalidated', invalidate); window.removeEventListener('staff-auth-retry', retry); };
        // Initial reads and recovery deliberately discard all private search state.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    function field(key: keyof SearchFilters, value: string | boolean) { setFilters(current => ({ ...current, [key]: value })); }
    function messageCard(message: Message, inContext = false) {
        const forwarded = forwardedLabel(message.forwardedFrom);
        return <Card key={`${message.chatId}:${message.messageId}`} className={`min-w-0 space-y-3 p-4 ${inContext && target?.anchor === message.messageId ? 'border-primary' : ''}`}>
            <div className="flex flex-wrap justify-between gap-2"><p className="break-words font-medium">{inContext ? senderLabel(message.sender) : message.chatTitle || 'Untitled chat'}</p><span className="text-xs text-muted-foreground"><StaffDate value={message.sentAt} kind="timestamp" /></span></div>
            {!inContext ? <p className="break-words text-sm text-muted-foreground">{senderLabel(message.sender)}</p> : null}
            {message.sender?.displayName && message.sender.username ? <p className="break-words text-xs text-muted-foreground">@{message.sender.username.replace(/^@/, '')}</p> : null}
            {inContext && target?.anchor === message.messageId ? <p className="text-xs font-medium">Requested message</p> : null}
            <blockquote className={`whitespace-pre-wrap break-words text-sm ${inContext ? '' : 'line-clamp-5'}`}>{inContext ? message.text || 'No retained message text.' : messageExcerpt(message.text)}</blockquote>
            {message.editedAt ? <p className="text-xs text-muted-foreground">Imported edit timestamp: <StaffDate value={message.editedAt} kind="timestamp" /></p> : null}
            {forwarded ? <p className="break-words text-xs text-muted-foreground">Forwarded from: {forwarded}</p> : null}
            {message.attachments.length ? <ul className="space-y-1 text-xs text-muted-foreground">{message.attachments.map((attachment, index) => <li className="break-words" key={`${index}:${attachment.id ?? 'attachment'}`}>{attachment.filename || attachment.kind} · {attachment.mimeType || attachment.kind}{attachment.sizeBytes !== null ? ` · ${attachment.sizeBytes.toLocaleString()} bytes` : ''} · Metadata only</li>)}</ul> : null}
            <div className="flex flex-wrap gap-2">{!inContext ? <Button variant="outline" size="sm" onClick={() => openContext(message.chatId, message.messageId)}>View conversation</Button> : null}{message.replyToMessageId ? <Button variant="ghost" size="sm" onClick={() => openContext(message.chatId, message.replyToMessageId!)}>View replied-to message</Button> : null}</div>
        </Card>;
    }
    return <section className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <PageHeader eyebrow="Private workspace" title="Search conversations" description="Find original messages in your retained Telegram history." actions={<Button asChild variant="outline"><Link href="/staff/telegram-intake/chats">Telegram chats</Link></Button>} />
        <p className="text-sm text-muted-foreground">Private conversations are separate from profiles and CVs. Reviewed source material may be released through the candidate review workflow. Search covers retained imports, including disconnected accounts; removed sources and later Telegram edits may be unavailable.</p>
        <StaffAuthRecoveryPrompt />
        <Card className="space-y-4 p-5">
            <form onSubmit={event => { event.preventDefault(); void loadChats(null); }} className="flex flex-wrap items-end gap-2"><div className="min-w-0 flex-1 space-y-2"><Label htmlFor="context-chat-query">Find an imported chat</Label><Input id="context-chat-query" value={chatQuery} maxLength={100} onChange={event => setChatQuery(event.target.value)} placeholder="Title or username" /></div><Button type="submit" variant="outline" disabled={chatLoading}>Find chats</Button></form>
            <div className="flex max-h-64 flex-wrap gap-2 overflow-y-auto rounded-lg p-1" aria-label="Imported chat choices" aria-busy={chatLoading}><Button variant={!filters.chatId ? 'secondary' : 'outline'} aria-pressed={!filters.chatId} onClick={() => { field('chatId', ''); selectedChat.current = null; }}>All imported chats</Button>{chats.map(chat => <Button key={chat.id} className="max-w-full whitespace-normal break-words text-left" variant={filters.chatId === chat.id ? 'secondary' : 'outline'} aria-pressed={filters.chatId === chat.id} onClick={() => { selectedChat.current = chat; field('chatId', chat.id); }}>{chat.title || 'Untitled chat'}{chat.username ? ` (@${chat.username})` : ''} · Account {chat.accountUserId}</Button>)}</div>
            <p role="status" className="text-sm text-muted-foreground">{chatLoading ? 'Loading chats…' : chatError || (!chats.length ? 'No imported chats match this chat search.' : '')}{filters.chatId ? ` Searching in ${selectedChat.current?.title || 'selected chat'}.` : ''}</p>
            <div className="flex flex-wrap items-center gap-2"><span className="text-xs">Chat page {chatCursors.length}</span><Button size="sm" variant="outline" disabled={chatLoading || chatCursors.length === 1} onClick={() => { const previous = chatCursors.slice(0, -1); void loadChats(previous.at(-1), appliedChatQuery, previous); }}>Previous chat page</Button>{chatAfter ? <Button size="sm" variant="outline" disabled={chatLoading} onClick={() => void loadChats(chatAfter, appliedChatQuery, [...chatCursors, chatAfter])}>Next chat page</Button> : null}</div>
        </Card>
        <Card className="p-5"><form className="grid gap-4 sm:grid-cols-2" onSubmit={event => { event.preventDefault(); void search(filters); }}>
            <div className="space-y-2 sm:col-span-2"><Label htmlFor="context-query">Message words or phrase</Label><Input id="context-query" required maxLength={500} value={filters.query} onChange={event => field('query', event.target.value)} placeholder='developer OR "product designer"' /><p className="text-xs text-muted-foreground">Use quotes for phrases, OR for alternatives, and a minus sign to exclude a word. Search terms stay in this page only.</p></div>
            <div className="space-y-2"><Label htmlFor="context-sender">Exact Telegram username</Label><Input id="context-sender" value={filters.sender} maxLength={33} onChange={event => field('sender', event.target.value)} placeholder="@username (optional)" /></div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={filters.attachmentsOnly} onChange={event => field('attachmentsOnly', event.target.checked)} />Messages with attachments only</label>
            <div className="space-y-2"><Label htmlFor="context-from">From date (UTC, inclusive)</Label><Input id="context-from" type="date" value={filters.from} onChange={event => field('from', event.target.value)} /></div><div className="space-y-2"><Label htmlFor="context-to">To date (UTC, inclusive)</Label><Input id="context-to" type="date" value={filters.to} min={filters.from || undefined} onChange={event => field('to', event.target.value)} /></div>
            <Button ref={searchButton} type="submit" disabled={loading || invalidated.current}>Search messages</Button>
        </form></Card>
        <div aria-live="polite" role="status" className="text-sm">{loading ? 'Searching retained messages…' : error || (result ? `${result.results.length} results on this page, newest first. ${result.coverage.retainedMessages.toLocaleString()} retained message records across your private imports.` : 'Enter words to search your private message history.')}</div>
        {pendingFilterChanges(filters, submitted) ? <p role="status" className="text-sm text-muted-foreground">You have unapplied filter changes. Search messages to apply them; result pagination uses your previous search.</p> : null}
        {chatQuery.trim() !== appliedChatQuery.trim() ? <p className="text-xs text-muted-foreground">Chat search changes are unapplied. Find chats to apply them; chat pagination uses the previous chat search.</p> : null}
        {error ? <Button variant="outline" disabled={loading || invalidated.current || !submitted} onClick={() => submitted && void search(submitted, resultCursors.at(-1), resultCursors)}>Retry search</Button> : null}
        {result && !result.results.length ? <Card className="p-5">No retained messages match these terms and filters. Try broader terms or another chat.</Card> : null}
        {result?.results.map(message => messageCard(message))}
        {result && submitted ? <div className="flex flex-wrap items-center gap-2"><span className="text-xs">Result page {resultCursors.length}</span><Button variant="outline" disabled={loading || resultCursors.length === 1} onClick={() => { const previous = resultCursors.slice(0, -1); void search(submitted, previous.at(-1), previous); }}>Previous result page</Button>{result.nextAfter ? <Button variant="outline" disabled={loading} onClick={() => void search(submitted, result.nextAfter, [...resultCursors, result.nextAfter])}>Next result page</Button> : null}</div> : null}
        <Dialog open={Boolean(target)} onOpenChange={open => { if (!open) { controllers.current.context?.abort(); setTarget(null); setConversation(null); setContextError(''); } }}><DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto" onCloseAutoFocus={event => { event.preventDefault(); searchButton.current?.focus(); }}>
            <DialogTitle>{conversation?.chat.title || 'Private conversation'}</DialogTitle><DialogDescription>Original retained messages in chronological order. Attachment details are metadata; files are not downloaded here.</DialogDescription>
            <p role="status" aria-live="polite" className="text-sm">{contextLoading ? 'Loading conversation…' : contextError}</p>
            {contextError && target ? <Button variant="outline" onClick={() => void loadContext(target)}>Retry conversation</Button> : null}
            {conversation ? <><p className="text-xs text-muted-foreground">Telegram account {conversation.chat.accountUserId}</p>{conversation.anchorUnavailable ? <p role="status" className="rounded-lg border p-3 text-sm">The requested message is not retained or is no longer available. Available conversation messages are shown below.</p> : null}<div className="flex flex-wrap gap-2">{conversation.olderBefore ? <Button variant="outline" onClick={() => void loadContext({ chatId: conversation.chat.id, before: conversation.olderBefore! })}>Older messages</Button> : null}{conversation.newerAfter ? <Button variant="outline" onClick={() => void loadContext({ chatId: conversation.chat.id, after: conversation.newerAfter! })}>Newer messages</Button> : null}<Button variant="ghost" onClick={() => void loadContext({ chatId: conversation.chat.id })}>Latest messages</Button></div>{conversation.messages.length ? conversation.messages.map(message => messageCard(message, true)) : <p className="text-sm">No retained messages are available in this conversation.</p>}</> : null}
        </DialogContent></Dialog>
    </section>;
}
