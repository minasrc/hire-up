export function retentionLabel(retention) {
    return ({ kept: 'Context kept', release_pending: 'Release requested', purged: 'Source messages deleted' })[retention?.state] || 'Context kept';
}
export function retentionHolds(holds) {
    return [
        holds.openDrafts ? `${holds.openDrafts} open draft${holds.openDrafts === 1 ? '' : 's'}` : '',
        holds.pendingProposals ? `${holds.pendingProposals} unresolved suggestion${holds.pendingProposals === 1 ? '' : 's'}` : '',
        holds.activeCv ? `${holds.activeCv} active CV retrieval${holds.activeCv === 1 ? '' : 's'}` : '',
    ].filter(Boolean).join(' · ');
}
export function extractionSelection(chats, markedIds, enabled) {
    const marked = new Set(markedIds);
    return chats.filter(chat => marked.has(chat.id) && chat.extractionEnabled !== enabled)
        .slice(0, 50).map(chat => ({ chatId: chat.id, expectedVersion: chat.version }));
}
export function canReleaseContext({ retention, sourceLoaded, acknowledged, busy }) {
    return retention?.canRelease === true && sourceLoaded && acknowledged && !busy;
}
