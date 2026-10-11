export type TelegramSource = { id: string; chatId: string; messageId: string; extractionJobId: string; available: boolean; sourceChanged: boolean };
export type TelegramProvenance = { sources: TelegramSource[]; nextAfter: string | null; provenanceUnavailable: boolean };
export function provenanceVisible(snapshot: TelegramProvenance | null) {
    return Boolean(snapshot && (snapshot.sources.length || snapshot.provenanceUnavailable));
}
export function provenanceLink(source: TelegramSource) {
    return `/staff/telegram-intake/context?${new URLSearchParams({ chatId: source.chatId, messageId: source.messageId })}`;
}
export function provenanceSourceLabel(source: TelegramSource) {
    return source.available ? 'View original message' : 'Source unavailable · Open retained conversation';
}
