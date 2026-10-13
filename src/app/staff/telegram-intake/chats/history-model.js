export const historyViews = { all: 'All chats', selected: 'Selected', active: 'Importing / syncing', paused: 'Needs attention' };
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
        PEER_CACHE_MISSING: 'This chat needs to be discovered again. Refresh the chat list, then resume.',
        MESSAGE_TOO_LARGE: 'A message exceeds the import limit. Import is paused before that message; ask your administrator for help.',
    })[job.errorCode] || (job.errorCode ? 'Import needs attention. Refresh the status before trying again.' : '');
}

export function importActions(chat) {
    const status = chat.import?.status;
    const historyCompleted = chat.historyCompleted || status === 'completed';
    if (!status) return [{ action: 'select', selected: true, label: 'Import full history' }];
    if (chat.sync?.enabled && status === 'completed') return [{ action: 'pause', label: 'Pause sync' }, { action: 'cancel', label: 'Deselect chat' }];
    if (activeStatuses.has(status)) return [{ action: 'pause', label: historyCompleted ? 'Pause sync' : 'Pause' }, { action: 'cancel', label: historyCompleted ? 'Deselect chat' : 'Cancel import' }];
    if (pausedStatuses.has(status) || status === 'cancelled') return [
        { action: 'resume', label: historyCompleted ? 'Resume sync' : 'Resume import' },
        ...(chat.selected ? [{ action: 'cancel', label: historyCompleted ? 'Deselect chat' : 'Cancel import' }] : []),
    ];
    return [{ action: 'select', selected: !chat.selected, label: chat.selected ? 'Deselect chat' : 'Select chat' }];
}

export function selectionPayload(chats, markedIds, selected) {
    const ids = new Set(markedIds);
    const rows = chats.filter(chat => ids.has(chat.id));
    if (!rows.length || rows.length > 50 || rows.length !== ids.size) throw new Error('Mark up to 50 chats on this page before continuing.');
    return { action: 'selectMany', selected, chats: rows.map(chat => ({ chatId: chat.id, expectedVersion: chat.version })) };
}

export function connectionGuidance(snapshot) {
    if (snapshot?.canImport) return null;
    if (snapshot?.blockedReason === 'NOT_CONNECTED') {
        const guidance = {
            requested: { description: 'Your sign-in is being prepared above. Approve it in Telegram on your phone before discovering chats.' },
            qr_pending: { description: 'Scan the QR code above and approve the sign-in in Telegram on your phone before discovering chats.' },
            awaiting_password: { description: 'Phone approval is complete. Enter your Telegram two-step verification password above to enable chat discovery.' },
            failed: { description: 'Retry sign-in above to enable chat discovery. Your imported history remains available.' },
        }[snapshot.connection?.status];
        if (guidance) return { ...guidance, empty: 'Finish Telegram sign-in, then discover your chats. Discovery does not import messages; choose chats to import afterward.' };
    }
    return { description: 'Connect Telegram above to discover chats. Your existing private history remains available; reconnect the same account to resume its imports.', empty: 'Connect Telegram, then discover your chats. Choose chats to import their messages.' };
}

export function historyPollingDelay(snapshot, elapsedMs = Infinity) {
    // The inline connection controller immediately refreshes history on status changes.
    // History itself only needs frequent polling while discovery/imports are running.
    if (snapshot?.discovery?.status === 'active' && elapsedMs < 10000) return 1000;
    return snapshot?.discovery?.status === 'active' || snapshot?.chats?.some(chat => activeStatuses.has(chat.import?.status)) ? 3000 : 15000;
}

export function chatDisplayTitle(chat, accountUserId) {
    if (accountUserId && chat.peer?.kind === 'user' && chat.peer.id === accountUserId) return 'Saved messages';
    if (chat.title && chat.title !== 'Unavailable chat') return chat.title;
    if (chat.username) return `@${chat.username}`;
    const kind = ({ user: 'contact', chat: 'group', channel: 'channel' })[chat.peer?.kind] || 'chat';
    return `Unnamed ${kind} (${chat.peer?.id ?? 'unknown'})`;
}

export function byteLabel(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.ceil(bytes / 1024)} KB`;
}

export function syncStatus(sync, hostedEnabled = false) {
    if (!sync) return '';
    return ({ off: 'Sync off', waiting_for_history: 'Sync starts after history import', reconnect_required: 'Reconnect Telegram to sync', worker_offline: hostedEnabled ? 'Telegram service offline · Sync resumes when it returns' : 'Mac offline · Sync resumes when it returns', up_to_date: 'Sync up to date', queued: 'Sync queued', syncing: 'Syncing new messages', waiting: 'Sync waiting', paused: 'Sync paused', failed: 'Sync needs attention', capacity_paused: 'Sync capacity reached' })[sync.status] || 'Sync needs attention';
}

export function discoveryPresentation(snapshot) {
    const hasChats = (snapshot?.totals?.chats ?? 0) > 0;
    const active = snapshot?.discovery?.status === 'active';
    const completed = snapshot?.discovery?.status === 'completed';
    return {
        hasChats,
        button: active ? 'Discovering chats…' : hasChats || completed ? 'Refresh chat list' : 'Discover chats',
        connectionButton: hasChats ? 'Choose chats to import' : null,
        description: active ? 'Looking for your Telegram chats. Chats appear here as discovery progresses; you can choose which ones to import.'
            : hasChats ? 'Choose a chat below or mark several chats to import their messages.'
                : completed ? 'No chats were found for this account. Check that this is the Telegram account you intended to connect, then refresh the chat list.'
                    : 'Your Telegram account is connected. Discover your chats first, then choose which conversations to import.',
    };
}
