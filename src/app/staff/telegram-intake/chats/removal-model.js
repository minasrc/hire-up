export function removalPending(state) {
    return state === 'pending' || state === 'device_pending';
}
export function removalStatus(state, receipt) {
    if (state === 'completed') return 'Imported history removed. Approved candidate profiles and reviewed documents are kept.';
    if (removalPending(state)) return receipt?.serverPurged
        ? 'Server history removed; device or storage cleanup is pending. Removal will finish when cleanup is confirmed.'
        : 'Removing imported history… Imports and sync are stopped for this chat.';
    return '';
}
export function removalError(status) {
    return status === 409 ? 'This chat changed. Refresh the removal details and review them before trying again.'
        : [401, 403, 428].includes(status) ? 'Verify your workspace access to continue.'
            : 'Unable to confirm this action. Refresh status before retrying; removal may already be in progress.';
}
export function removalPayload({ mode, preview, acknowledged, connected, operationId }) {
    if (!preview || !acknowledged || removalPending(preview.state)) throw new Error('Review and confirm the current chat details first.');
    if (mode === 'reimport' && (!connected || preview.state !== 'completed')) throw new Error('Reconnect the same account after removal completes before importing again.');
    if (mode === 'request' && preview.state === 'completed') throw new Error('This history has already been removed.');
    return { action: mode, chatId: preview.chatId, expectedVersion: preview.version, operationId, ...(mode === 'request' ? { confirmation: 'remove_imported_history' } : {}) };
}

export function removalOperation(previous, mode, preview, createId = () => crypto.randomUUID()) {
    const intent = `${mode}:${preview.chatId}:${preview.version}`;
    return previous?.intent === intent ? previous : { intent, operationId: createId() };
}
