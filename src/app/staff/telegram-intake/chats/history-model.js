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
            requested: { title: 'Preparing Telegram sign-in', description: 'Your sign-in is being prepared. Continue on the connection page, then approve the sign-in in Telegram on your phone.', action: 'Continue sign-in' },
            qr_pending: { title: 'Finish Telegram approval on your phone', description: 'Scan the QR code and approve the sign-in in Telegram on your phone. If Telegram asks for a two-step verification password, complete it on the connection page.', action: 'Continue sign-in' },
            awaiting_password: { title: 'Complete Telegram two-step verification', description: 'Phone approval is complete. Enter your Telegram two-step verification password on the connection page to finish signing in.', action: 'Continue sign-in' },
            failed: { title: 'Telegram sign-in needs a retry', description: 'Open the connection page to retry sign-in, then approve it in Telegram on your phone.', action: 'Retry sign-in' },
        }[snapshot.connection?.status];
        if (guidance) return { ...guidance, empty: 'Finish Telegram sign-in, then discover your chats. Discovery does not import messages; choose chats to import afterward.' };
    }
    return { title: 'Connect Telegram to import chats', description: 'Your existing private history remains available. Reconnect the same Telegram account to resume its interrupted imports. A different account has its own separate chat list.', action: 'Connect Telegram', empty: 'Connect Telegram, then discover your chats. Choose chats to import their messages.' };
}

export function historyPollingDelay(snapshot) {
    if (snapshot?.blockedReason === 'NOT_CONNECTED' && ['requested', 'qr_pending', 'awaiting_password'].includes(snapshot.connection?.status)) return 2000;
    return snapshot?.discovery?.status === 'active' || snapshot?.chats?.some(chat => activeStatuses.has(chat.import?.status)) ? 3000 : 15000;
}

export function byteLabel(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.ceil(bytes / 1024)} KB`;
}

export function syncStatus(sync, hostedEnabled = false) {
    if (!sync) return '';
    return ({ off: 'Sync off', waiting_for_history: 'Sync starts after history import', reconnect_required: 'Reconnect Telegram to sync', worker_offline: hostedEnabled ? 'Telegram service offline · Sync resumes when it returns' : 'Mac offline · Sync resumes when it returns', up_to_date: 'Sync up to date', queued: 'Sync queued', syncing: 'Syncing new messages', waiting: 'Sync waiting', paused: 'Sync paused', failed: 'Sync needs attention', capacity_paused: 'Sync capacity reached' })[sync.status] || 'Sync needs attention';
}
