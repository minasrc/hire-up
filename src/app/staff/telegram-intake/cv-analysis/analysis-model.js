export const analysisActive = status => ['queued', 'leased', 'waiting'].includes(status);
export function analysisStatus(job) {
    if (job.status === 'leased') return job.stage === 'parse' ? 'Reading CV text' : 'Extracting profile suggestions';
    return ({ queued: 'Queued for your Mac', waiting: 'Waiting to retry', failed: 'Analysis needs attention', cancelled: 'Analysis skipped', completed: 'Analysis complete' })[job.status] || 'Check analysis status';
}
export function analysisGuidance(code) {
    return ({ STORAGE_UNAVAILABLE: 'The CV file could not be read. Check the worker connection and retry.', PROVIDER_UNAVAILABLE: 'The model is unavailable. Check the Mac worker and model connection before retrying.', WORKER_ERROR: 'The Mac worker could not finish. Check it before retrying.', INVALID_DOCUMENT: 'This document could not be read. Upload a valid PDF or DOCX, or skip analysis and enter the profile manually.', ENCRYPTED_DOCUMENT: 'This CV is password protected. Upload an unprotected copy or skip analysis.', OCR_REQUIRED: 'No readable text was found. Image content is not extracted; review the original CV and enter details manually or upload a text-based version.', DOCUMENT_LIMIT: 'This document exceeds the supported parsing limits. Upload a simpler CV or skip analysis.', TEXT_LIMIT: 'The extracted text exceeds the limit. No text was truncated; upload a shorter CV or skip analysis.', INVALID_RESULT: 'The suggested facts did not pass validation. Check the model configuration before retrying.', UNSUPPORTED_VERSION: 'Update the Mac analysis worker before retrying.', ATTEMPTS_EXHAUSTED: 'Analysis stopped after repeated failures. Check the worker, then retry or skip analysis.' })[code] || (code ? 'Analysis could not finish. Check the worker, then retry or skip analysis.' : '');
}
export const analysisIssue = code => ({ NOT_A_CV: 'This document may not be a CV.', MULTIPLE_PEOPLE: 'This document appears to describe multiple people. Choose the correct person manually.', NO_CANDIDATE_INFORMATION: 'No candidate information was found. Complete the profile manually.' })[code] || 'Review the original CV before using its information.';
export function blockLabel(block) {
    if (block?.kind === 'pdf_page') return `PDF page ${block.page}`;
    if (block?.kind === 'docx_paragraph') return `${block.part === 'word/document.xml' ? 'Document' : block.part.replace(/^word\//, '').replace(/\.xml$/, '')} · Paragraph ${block.paragraph}`;
    return 'CV text reference';
}
export function mergeAnalysisDraft({ current, incoming, baselineFields, localFields, nextFields }) {
    if (current.id !== incoming.id || incoming.version < current.version) return { mode: 'ignore' };
    if (((incoming.status === 'approved' || incoming.status === 'discarded') && incoming.status !== current.status) || incoming.documentRevision !== current.documentRevision) return { mode: 'conflict' };
    const keys = [...new Set([...Object.keys(baselineFields), ...Object.keys(localFields), ...Object.keys(nextFields)])];
    if (keys.some(key => localFields[key] !== baselineFields[key] && nextFields[key] !== baselineFields[key] && localFields[key] !== nextFields[key])) return { mode: 'conflict' };
    return { mode: 'merge', fields: Object.fromEntries(keys.map(key => [key, localFields[key] !== baselineFields[key] ? localFields[key] : nextFields[key]])) };
}
