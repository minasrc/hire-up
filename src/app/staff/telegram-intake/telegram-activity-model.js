export function activeExtractionCount(result) {
    if (Number.isFinite(result?.counts?.active)) return result.counts.active;
    const counts = result?.counts;
    if (!counts) return 0;
    // Compatibility while the application and additive migration roll out.
    const paused = result.jobs?.filter(job => job.extractionEnabled === false && ['queued', 'waiting'].includes(job.status)).length ?? 0;
    return Math.max(0, counts.queued + counts.leased + counts.waiting - paused);
}
export function telegramImportInProgress(chats) {
    return chats.some(chat => chat.historyCompleted !== true && ['queued', 'leased', 'waiting'].includes(chat.import?.status));
}
