export const searchScopeLabels = { all: 'Approved candidates and my drafts', approved: 'Approved candidates', my_drafts: 'My private drafts' };
export const searchIsActive = status => status === 'queued' || status === 'running';
export function searchStatusLabel(status, workerAvailable) {
    if (searchIsActive(status) && !workerAvailable) return 'Waiting for the Mac search worker';
    return ({ queued: 'Search queued', running: 'Searching profiles', completed: 'Search complete', failed: 'Search needs attention', cancelled: 'Search cancelled', expired: 'Search expired' })[status] || 'Preparing search';
}
export function searchGuidance(code) {
    return ({
        CV_ACCESS_CHANGED: 'Your access to CV text changed. Previous results were cleared. Search profiles only, or start a new CV search after access is restored.',
        CV_RESULTS_CHANGED: 'A CV used by this search changed or became unavailable. Previous results were cleared. Run the search again for current results.',
        SEARCH_CAPACITY: 'CV search exceeds the supported search capacity. Search profiles only, or ask your administrator to review capacity.',
        WORKER_UNAVAILABLE: 'Keep the Mac search worker online, then retry this search.',
        EMBEDDING_UNAVAILABLE: 'The embedding service is unavailable. Check the Mac search worker before retrying.',
        INVALID_RESULT: 'The search worker returned an invalid result. Check the worker configuration before retrying.',
        INDEX_VERSION_MISMATCH: 'The search model and index versions do not match. Ask your administrator to finish reindexing.',
        ATTEMPTS_EXHAUSTED: 'The search stopped after repeated attempts. Check the Mac search worker, then retry.',
        SEARCH_TIMEOUT: 'The search exceeded its time limit. Try a narrower scope or contact your workspace administrator.',
        SOURCE_TOO_LARGE: 'A profile exceeds the indexing limit. Ask your workspace administrator to review it.',
        WORKER_ERROR: 'The search worker could not finish this request. Check the Mac worker, then retry.',
        INPUT_TOO_LONG: 'Shorten the search description and try again.',
    })[code] || (code ? 'The search could not finish. Refresh its status or try again after checking the Mac search worker.' : '');
}
export function validResultHref(result) {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuid.test(result.sourceId ?? '')) return null;
    if (result.sourceType === 'candidate') return `/staff/candidates/${result.sourceId}`;
    if (result.sourceType === 'draft') return `/staff/telegram-intake?draft=${result.sourceId}`;
    return null;
}
export function hasIncompleteCoverage(coverage) {
    return coverage.pending > 0 || coverage.failed > 0 || (coverage.fullyIndexed ?? coverage.indexed) < coverage.eligible;
}
export const cvSearchInvalidated = code => code === 'CV_ACCESS_CHANGED' || code === 'CV_RESULTS_CHANGED';
export function safeSearchSnapshot(snapshot) {
    if (!cvSearchInvalidated(snapshot.errorCode)) return snapshot;
    return { ...snapshot, status: 'failed', results: [], nextAfter: null, capacity: null, coverage: { ...snapshot.coverage, cv: null } };
}
export function searchCvMode(scope, includeCv) { return scope !== 'my_drafts' && includeCv === true; }
