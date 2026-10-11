export type Attachment = { id: string; kind: string; filename: string | null; mimeType: string | null; sizeBytes: number | null };
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
export function forwardedLabel(value: unknown): string | null {
    if (!value) return null;
    if (typeof value === 'string') return value;
    if (typeof value !== 'object') return 'Forwarded message';
    const record = value as Record<string, unknown>;
    return typeof record.displayName === 'string' && record.displayName ? record.displayName : 'Forwarded message';
}
