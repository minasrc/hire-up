export type Attachment = { id: string | null; kind: string; filename: string | null; mimeType: string | null; sizeBytes: number | null };
export type Message = { chatId: string; messageId: string; chatTitle: string; text: string | null; sentAt: string; editedAt: string | null; sender: { peer: unknown; username: string | null; displayName: string | null } | null; attachments: Attachment[]; replyToMessageId: string | null; forwardedFrom: { peer: { kind: string; id: string } | null; displayName: string | null } | null };
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
export function pendingFilterChanges(filters: SearchFilters, submitted: SearchFilters | null) {
    return submitted !== null && JSON.stringify(searchPayload(filters)) !== JSON.stringify(searchPayload(submitted));
}
export function conversationDeepLink(chatId: string | null, anchor: string | null) {
    if (!chatId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(chatId)) return null;
    if (anchor !== null && (!/^[1-9][0-9]{0,9}$/.test(anchor) || Number(anchor) > 2147483647)) return null;
    return { chatId, ...(anchor ? { anchor } : {}) };
}
