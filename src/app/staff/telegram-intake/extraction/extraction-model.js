export function extractionStatus(job) {
    if (job.status === 'completed') return job.reviewedAt ? 'Review acknowledged' : 'Ready for review';
    return ({ queued: 'Queued', leased: 'Extracting', waiting: 'Waiting to retry', failed: 'Needs attention' })[job.status] || 'Needs attention';
}
export function extractionGuidance(code) {
    return ({
        PROVIDER_UNAVAILABLE: 'The configured model is unavailable. Check the Mac extraction worker and model connection.',
        INVALID_RESULT: 'The model response did not pass validation. Source messages were retained; retry after checking the model configuration.',
        INPUT_TOO_LARGE: 'A source message exceeds the extraction limit. Ask your administrator to review it before retrying; the message has not been skipped or deleted.',
        WORKER_ERROR: 'The extraction worker could not finish this batch. Check the Mac worker before retrying.',
    })[code] || (code ? 'This extraction needs attention. Source messages were retained.' : '');
}
export function suggestionValue(value) {
    if (Array.isArray(value)) return value.length ? value.join(', ') : 'Not provided';
    return typeof value === 'string' && value.trim() ? value : 'Not provided';
}
export function extractionChatIds(chats, markedIds) {
    const marked = new Set(markedIds);
    return chats.filter(chat => marked.has(chat.id) && (chat.import?.importedMessages ?? 0) > 0).map(chat => chat.id).slice(0, 50);
}
export function canResolveSuggestion({ dirty, busy, conflict, terminal }, decision) {
    return !dirty && !busy && !conflict && (decision === 'dismiss' || !terminal);
}
