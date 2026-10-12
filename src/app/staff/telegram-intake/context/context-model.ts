export type Attachment = { id: string | null; kind: string; filename: string | null; mimeType: string | null; sizeBytes: number | null };
export type Message = { chatId: string; messageId: string; kind: 'message' | 'service' | 'unavailable'; chatTitle: string; text: string | null; sentAt: string | null; editedAt: string | null; sender: { peer: unknown; username: string | null; displayName: string | null } | null; attachments: Attachment[]; replyToMessageId: string | null; forwardedFrom: { peer: { kind: string; id: string } | null; displayName: string | null } | null };
export type Chat = { id: string; title: string; username: string | null; accountUserId: string };
export type SearchFilters = { query: string; chatId: string; sender: string; from: string; to: string; attachmentsOnly: boolean };
export function searchPayload(filters: SearchFilters, after: string | null = null) {
    return { action: 'search', query: filters.query.trim(), chatId: filters.chatId || null, sender: filters.sender.trim() || null, from: filters.from || null, to: filters.to || null, attachmentsOnly: filters.attachmentsOnly, after };
}
export function contextUrl(chatId: string, options: { anchor?: string; before?: string; after?: string } = {}) {
    const params = new URLSearchParams({ chatId });
    const entry = ['anchor', 'before', 'after'].map(key => [key, options[key as keyof typeof options]]).find(([, value]) => value);
    if (entry) params.set(entry[0], entry[1]!);
    return `/api/staff/telegram-context?${params}`;
}
export function senderLabel(sender: Message['sender']) { return sender?.displayName || (sender?.username ? `@${sender.username.replace(/^@/, '')}` : 'Unknown sender'); }
export function forwardedLabel(value: Message['forwardedFrom']): string | null {
    if (!value) return null;
    return value.displayName || 'Forwarded message';
}
export function messageExcerpt(text: string | null) {
    if (!text) return 'No retained message text.';
    return text.length > 600 ? `${text.slice(0, 600).replace(/[\uD800-\uDBFF]$/, '')}…` : text;
}
export function retainedMessageText(message: Pick<Message, 'kind' | 'text'>, fullText = false) {
    if (message.kind === 'unavailable') return 'This retained source is unavailable. This does not confirm a Telegram deletion.';
    return fullText ? message.text || 'No retained message text.' : messageExcerpt(message.text);
}
export function pendingFilterChanges(filters: SearchFilters, submitted: SearchFilters | null) {
    return submitted !== null && JSON.stringify(searchPayload(filters)) !== JSON.stringify(searchPayload(submitted));
}
export function conversationDeepLink(chatId: string | null, anchor: string | null) {
    if (!chatId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(chatId)) return null;
    if (anchor !== null && (!/^[1-9][0-9]{0,9}$/.test(anchor) || Number(anchor) > 2147483647)) return null;
    return { chatId, ...(anchor ? { anchor } : {}) };
}
export type SourceUpdateStatus = { chatId: string; mode: string; needsReextraction: boolean; sourceChangeReason: string | null; cursor: string | null; lastCheckedAt: string | null; lastCycleAt: string | null; nextCheckAt: string | null; errorCode: string | null; status: string; nativeStatus?: 'baseline_pending' | 'waiting' | 'repair_required' | 'live'; lastNativeAt?: string | null; repairRequestedAt?: string | null; repairCompletedAt?: string | null; gapReason?: string | null; nativeErrorCode?: string | null };
export function sourceStatusLabel(source: SourceUpdateStatus) {
    if (source.status === 'worker_offline') return 'Telegram sync is offline; saved messages remain searchable.';
    if (source.status === 'reconnect_required') return 'Reconnect Telegram to check retained messages.';
    if (source.status === 'off') return 'Chat not selected; retained-message checks are off.';
    if (source.status === 'paused') return 'Paused or cancelled; retained-message checks are stopped.';
    if (source.status === 'checking') return 'Checking saved messages. Some may be out of date until checks finish.';
    if (source.errorCode || source.status === 'waiting') return 'Message checks are delayed by Telegram waits or a busy queue. Reconnect if Telegram asks you to sign in.';
    return 'Selected; retained-message check scheduled.';
}

export function nativeRepairPending(source: SourceUpdateStatus) {
    return source.nativeStatus === 'baseline_pending' || source.nativeStatus === 'repair_required'
        || Boolean(source.repairRequestedAt && (!source.repairCompletedAt || Date.parse(source.repairRequestedAt) > Date.parse(source.repairCompletedAt)));
}
export function nativeFeedLabel(source: SourceUpdateStatus) {
    if (source.mode !== 'native_updates_with_reconciliation' || ['off', 'paused', 'worker_offline', 'reconnect_required'].includes(source.status)) return null;
    if (nativeRepairPending(source)) return 'Updates are catching up. Some saved messages may be out of date.';
    if (source.nativeStatus === 'waiting' || source.nativeErrorCode) return 'Updates are delayed by Telegram waits or a busy queue. Reconnect if Telegram asks you to sign in.';
    if (source.nativeStatus === 'live') return 'Telegram updates checked. Some saved messages may still need checking.';
    return 'Telegram update status is unavailable.';
}

export function sourceSummary(source: SourceUpdateStatus) {
    if (source.status === 'worker_offline') return 'Telegram sync is offline. Saved messages remain searchable.';
    if (source.status === 'reconnect_required') return 'Reconnect Telegram to resume updates.';
    if (source.status === 'off') return 'Updates paused: chat not selected.';
    if (source.status === 'paused') return 'Updates paused or cancelled.';
    if (source.errorCode === 'CAPACITY_LIMIT' || source.nativeErrorCode === 'CAPACITY_LIMIT') return 'Storage limit reached. Review and release saved context to resume updates.';
    if (source.status === 'waiting' || source.errorCode || source.nativeStatus === 'waiting' || source.nativeErrorCode) return 'Telegram checks are delayed. Reconnect if Telegram asks you to sign in.';
    if (source.status === 'checking') return 'Checking saved messages.';
    if (nativeRepairPending(source)) return 'Updates are catching up.';
    if (source.mode === 'native_updates_with_reconciliation' && source.nativeStatus === 'live') return 'Telegram updates checked.';
    return 'Update checks scheduled.';
}
