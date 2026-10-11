export type BatchMessage = { messageId: string; kind: string; text: string | null; sentAt?: string | null; editedAt?: string | null; sender?: { displayName?: string | null; firstName?: string | null; lastName?: string | null; username?: string | null } | null; forwardedFrom?: { displayName: string | null } | null; attachments: { kind: string; filename?: string | null }[] };
export type BatchSnapshot = { chat: { title: string }; messages: BatchMessage[]; contextOnly?: BatchMessage[] };
export function batchAuthor(message: BatchMessage) {
    return message.sender?.displayName || [message.sender?.firstName, message.sender?.lastName].filter(Boolean).join(' ') || (message.sender?.username ? `@${message.sender.username.replace(/^@/, '')}` : 'Unknown original author');
}
export function primaryHasAttachments(source: BatchSnapshot | null) { return Boolean(source?.messages.some(message => message.attachments.length)); }
