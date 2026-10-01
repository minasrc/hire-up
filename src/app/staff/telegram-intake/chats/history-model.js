export const historyViews = { all: 'All chats', selected: 'Selected', active: 'Importing', paused: 'Needs attention' };
const activeStatuses = new Set(['queued', 'leased', 'waiting']);
const pausedStatuses = new Set(['paused', 'capacity_paused', 'failed']);

export function importStatus(job) {
    if (!job) return 'Not imported';
    return ({ queued: 'Queued', leased: 'Importing', waiting: 'Waiting', paused: 'Paused', capacity_paused: 'Capacity reached', failed: 'Needs attention', cancelled: 'Cancelled', completed: 'History imported' })[job.status] || 'Needs attention';
}

export function importGuidance(job) {
    if (!job) return '';
    if (job.status === 'capacity_paused') return 'Capacity reached. Ask your administrator to increase the limit, then resume from the saved position.';
    return ({
        CONNECTION_CHANGED: 'The Telegram connection changed. Reconnect the same account, then resume from the saved position.',
        FLOOD_WAIT: 'Telegram requested a wait. Imports will continue automatically after the wait ends.',
        TELEGRAM_UNAVAILABLE: 'Telegram is temporarily unavailable. Retrying automatically unless this import needs attention.',
        PEER_UNAVAILABLE: 'This chat is unavailable to your Telegram account. Check access in Telegram before resuming.',
        PEER_CACHE_MISSING: 'The Mac needs to discover this chat again. Refresh the chat list, then resume.',
        MESSAGE_TOO_LARGE: 'A message exceeds the import limit. Import is paused before that message; ask your administrator for help.',
    })[job.errorCode] || (job.errorCode ? 'Import needs attention. Refresh the status before trying again.' : '');
}

export function importActions(chat) {
    const status = chat.import?.status;
    if (!status) return [{ action: 'select', selected: true, label: 'Import full history' }];
    if (activeStatuses.has(status)) return [{ action: 'pause', label: 'Pause' }, { action: 'cancel', label: 'Cancel import' }];
    if (pausedStatuses.has(status) || status === 'cancelled') return [
        { action: 'resume', label: 'Resume import' },
        ...(chat.selected ? [{ action: 'cancel', label: 'Cancel import' }] : []),
    ];
    return [{ action: 'select', selected: !chat.selected, label: chat.selected ? 'Deselect chat' : 'Select chat' }];
}

export function selectionPayload(chats, markedIds, selected) {
    const ids = new Set(markedIds);
    const rows = chats.filter(chat => ids.has(chat.id));
    if (!rows.length || rows.length > 50 || rows.length !== ids.size) throw new Error('Mark up to 50 chats on this page before continuing.');
    return { action: 'selectMany', selected, chats: rows.map(chat => ({ chatId: chat.id, expectedVersion: chat.version })) };
}

export function historyPollingDelay(snapshot) {
    return snapshot?.discovery?.status === 'active' || snapshot?.chats?.some(chat => activeStatuses.has(chat.import?.status)) ? 3000 : 15000;
}

export function byteLabel(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.ceil(bytes / 1024)} KB`;
}
