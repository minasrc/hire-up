export const searchScopeLabels = { all: 'Candidates and drafts', approved: 'Candidates', my_drafts: 'My drafts' };
export const searchIsActive = status => status === 'queued' || status === 'running';
export function searchStatusLabel(status, workerAvailable) {
    if (searchIsActive(status) && !workerAvailable) return 'Waiting for search service';
    return ({ queued: 'Search queued', running: 'Searching…', completed: 'Search complete', failed: 'Search needs attention', cancelled: 'Search cancelled', expired: 'Search expired' })[status] || 'Preparing search';
}
export function searchGuidance(code) {
    return ({
        INDEX_CHANGED: 'Search updated. Search again.',
        CV_ACCESS_CHANGED: 'CV access changed. Search again without CVs.',
        CV_RESULTS_CHANGED: 'A CV changed. Search again.',
        SEARCH_CAPACITY: 'Too many CVs. Search without CVs.',
        WORKER_UNAVAILABLE: 'Search unavailable. Try again shortly.',
        EMBEDDING_UNAVAILABLE: 'Search unavailable. Try again shortly.',
        INVALID_RESULT: 'Search failed. Try again.',
        INDEX_VERSION_MISMATCH: 'Search is updating. Try again shortly.',
        ATTEMPTS_EXHAUSTED: 'Search failed. Try again.',
        SEARCH_TIMEOUT: 'Search timed out. Try a shorter description.',
        SOURCE_TOO_LARGE: 'A profile or CV is too large to search.',
        WORKER_ERROR: 'Search failed. Try again.',
        INPUT_TOO_LONG: 'Shorten the description and try again.',

    })[code] || (code ? 'Search failed. Try again.' : '');
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
export const searchInvalidated = code => ['CV_ACCESS_CHANGED', 'CV_RESULTS_CHANGED', 'INDEX_CHANGED'].includes(code);
export function safeSearchSnapshot(snapshot) {
    if (!searchInvalidated(snapshot.errorCode)) return snapshot;
    return { ...snapshot, status: 'failed', results: [], nextAfter: null, capacity: null, coverage: { ...snapshot.coverage, cv: null } };
}
export function searchCvMode(scope, includeCv) { return scope !== 'my_drafts' && includeCv === true; }

export function searchIndexingStatus(coverage) {
    if (!coverage) return null;
    const pending = Math.max(0, coverage.pending ?? 0);
    const failed = Math.max(0, coverage.failed ?? 0);
    const missing = Math.max(0, (coverage.eligible ?? 0) - (coverage.fullyIndexed ?? coverage.indexed ?? 0));
    const changed = coverage.corpusChanged === true;
    if (!pending && !failed && !missing && !changed) return null;
    const labels = [];
    if (pending) labels.push(`Indexing ${pending} profile${pending === 1 ? '' : 's'}`);
    if (failed) labels.push(`${failed} profile${failed === 1 ? '' : 's'} need${failed === 1 ? 's' : ''} attention`);
    if (!pending && !failed && missing) labels.push(`${missing} profile${missing === 1 ? '' : 's'} awaiting indexing`);
    return { pending, failed, incomplete: Boolean(pending || failed || missing), label: labels.join(' · ') || 'Profiles updated' };
}
