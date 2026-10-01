const sameFields = (left, right) => [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .every(key => left[key] === right[key]);

// CV polling may advance the document/version without replacing local profile edits.
export function classifyCvDraftRefresh({ current, incoming, baselineFields, localFields, nextFields }) {
    if (current.id !== incoming.id || incoming.version <= current.version) return 'ignore';
    if (incoming.status === 'approved' || incoming.status === 'discarded') return 'closed';
    if (current.status === 'approved' || current.status === 'discarded') return 'ignore';
    const dirty = !sameFields(baselineFields, localFields);
    if (dirty && !sameFields(baselineFields, nextFields)) return 'conflict';
    return dirty ? 'preserve_edits' : 'replace_fields';
}

export const activeCvStatus = status => ['queued', 'leased', 'waiting'].includes(status);
export function cvStatusLabel(status) {
    return ({ queued: 'Queued for your Mac', leased: 'Downloading and validating', waiting: 'Waiting to retry', failed: 'Retrieval needs attention', cancelled: 'Retrieval cancelled', completed: 'CV validated and attached' })[status] || 'Check retrieval status';
}
export function cvGuidance(code) {
    return ({
        CONNECTION_REQUIRED: 'Connect Telegram on your Mac to retrieve this file.',
        ACCOUNT_MISMATCH: 'Reconnect the Telegram account that imported this conversation to retrieve its file.',
        CONNECTION_CHANGED: 'The Telegram connection changed. Reconnect the same account, then retry this retrieval.',
        UNSUPPORTED_FILE: 'Only PDF and DOCX documents can be retrieved as a CV.',
        FILE_TOO_LARGE: 'This file exceeds the 4 MB CV limit. Request a smaller PDF or DOCX.',
        SOURCE_UNAVAILABLE: 'This attachment is no longer available for retrieval. Upload the CV manually or request a new file.',
        SOURCE_CHANGED: 'The Telegram attachment changed. This retrieval will not substitute a different file. Review a new attachment or upload the CV manually.',
        INVALID_FILE: 'The downloaded file did not pass CV validation. Request another PDF or DOCX, or upload a valid CV manually.',
        TELEGRAM_UNAVAILABLE: 'Telegram is temporarily unavailable. Keep the connected Mac running; retrieval will retry.',
        WORKER_ERROR: 'Your Mac could not finish this retrieval. Check the worker before retrying.',
        FLOOD_WAIT: 'Telegram requested a pause. Retrieval resumes after the wait below.',
        DRAFT_CLOSED: 'This draft is closed. No retrieved file can be attached.',
        DRAFT_DOCUMENT_CHANGED: 'A CV was uploaded or changed. This retrieval was cancelled to protect the chosen file.',
        CANCELLED: 'You cancelled this retrieval. Retry only if you still need this attachment.',
        ATTEMPTS_EXHAUSTED: 'Retrieval stopped after repeated attempts. Check the Mac worker and connection before retrying.',
        CV_EXISTS: 'A CV is already attached. Telegram retrieval will not replace it.',
    })[code] || (code ? 'This retrieval needs attention. Refresh its status before retrying.' : '');
}
