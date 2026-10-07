import { createHash } from 'node:crypto';
import { assertUuid } from './candidate-profile-contracts.js';
import { ClientJobContractError } from './client-job-contracts.js';
import { normalizeTelegramDraftFields } from './telegram-intake-contracts.js';
import { EXTRACTION_FIELDS } from './telegram-extraction-contracts.js';

export const CV_ANALYSIS_PARSER_VERSION = 'pdfjs-6.2.108-docx-xml-0.8.15-v1';
export const CV_ANALYSIS_PROMPT_VERSION = 'cv-facts-prompt-v1';
export const CV_ANALYSIS_SCHEMA_VERSION = 'cv-facts-v1';
export const CV_ANALYSIS_TEXT_LIMIT = 65536;
export const CV_ANALYSIS_PARSE_BODY_LIMIT = 1048576;
export const CV_ANALYSIS_BODY_LIMIT = 131072;
export const CV_ANALYSIS_MAX_BYTES = 4194304;
export const CV_ANALYSIS_ISSUES = ['NOT_A_CV', 'MULTIPLE_PEOPLE', 'NO_CANDIDATE_INFORMATION'];
export const CV_ANALYSIS_FAILURE_CODES = ['STORAGE_UNAVAILABLE', 'PROVIDER_UNAVAILABLE', 'WORKER_ERROR', 'INVALID_DOCUMENT', 'ENCRYPTED_DOCUMENT', 'OCR_REQUIRED', 'DOCUMENT_LIMIT', 'TEXT_LIMIT', 'INVALID_RESULT', 'UNSUPPORTED_VERSION'];
const objectSchema = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const evidenceSchema = objectSchema({ blockOrdinal: { type: 'integer', minimum: 0, maximum: 1999 }, startByte: { type: 'integer', minimum: 0, maximum: 65535 }, endByte: { type: 'integer', minimum: 1, maximum: 65536 }, quote: { type: 'string', minLength: 1, maxLength: 2000 } });
export const CV_ANALYSIS_RESULT_SCHEMA = objectSchema({ facts: { type: 'array', maxItems: 12, items: objectSchema({ field: { type: 'string', enum: EXTRACTION_FIELDS }, value: { anyOf: [{ type: 'string', minLength: 1, maxLength: 8000 }, { type: 'array', minItems: 1, maxItems: 9, items: { type: 'string', maxLength: 254 } }] }, evidence: { type: 'array', minItems: 1, maxItems: 3, items: evidenceSchema } }) }, issues: { type: 'array', maxItems: 3, items: { type: 'string', enum: CV_ANALYSIS_ISSUES } } });
const invalid = (key = 'input') => { throw new ClientJobContractError({ [key]: 'Invalid CV analysis request.' }); };
const exact = (value, keys) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) invalid(); };
const integer = (v, min, max = Number.MAX_SAFE_INTEGER) => { if (!Number.isSafeInteger(v) || v < min || v > max) invalid(); return v; };
const hash = v => { if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) invalid(); return v; };
const text = (v, max, empty = false) => { if (typeof v !== 'string' || !v.isWellFormed() || v.includes('\0') || v.includes('\r') || v.length > max || (!empty && !v.trim())) invalid(); return v; };
const sha = v => createHash('sha256').update(v).digest('hex');
const list = (v, min, max) => { if (!Array.isArray(v) || v.length < min || v.length > max) invalid(); };

export function validateCvParsedResult(input, expected = {}) {
    exact(input, ['parserVersion', 'documentSha256', 'textSha256', 'blocks']);
    if (input.parserVersion !== CV_ANALYSIS_PARSER_VERSION || expected.documentSha256 && input.documentSha256 !== expected.documentSha256) invalid();
    hash(input.documentSha256); hash(input.textSha256); list(input.blocks, 1, 2000);
    let kind; let priorPart = ''; let paragraph = 0;
    const rank = part => part === 'word/document.xml' ? '0' : part === 'word/footnotes.xml' ? '2' : part === 'word/endnotes.xml' ? '3' : `1${part}`;
    for (const [ordinal, b] of input.blocks.entries()) {
        if (b?.kind === 'pdf_page') {
            exact(b, ['ordinal', 'kind', 'page', 'text', 'sha256']);
            if (input.blocks.length > 50 || b.page !== ordinal + 1 || expected.extension && expected.extension !== 'pdf') invalid();
        } else if (b?.kind === 'docx_paragraph') {
            exact(b, ['ordinal', 'kind', 'part', 'paragraph', 'text', 'sha256']);
            if (typeof b.part !== 'string' || !/^word\/(document|(?:header|footer)(?:[1-9][0-9]?|100)|footnotes|endnotes)\.xml$/.test(b.part) || expected.extension && expected.extension !== 'docx') invalid();
            if (b.part !== priorPart) { if (priorPart && rank(b.part) <= rank(priorPart) || !priorPart && b.part !== 'word/document.xml') invalid(); priorPart = b.part; paragraph = 0; }
            if (b.paragraph !== ++paragraph) invalid();
        } else invalid();
        if (kind && kind !== b.kind || b.ordinal !== ordinal) invalid(); kind = b.kind;
        text(b.text, CV_ANALYSIS_TEXT_LIMIT, true); if (sha(b.text) !== hash(b.sha256)) invalid();
    }
    const fullText = input.blocks.map(b => b.text).join('\n\n');
    if (!fullText.trim() || Buffer.byteLength(fullText) > CV_ANALYSIS_TEXT_LIMIT || sha(fullText) !== input.textSha256 || Buffer.byteLength(JSON.stringify(input)) > CV_ANALYSIS_PARSE_BODY_LIMIT) invalid();
    return input;
}

export function validateCvFactsResult(input, blocks) {
    exact(input, ['facts', 'issues']); list(input.facts, 0, 12); list(input.issues, 0, 3);
    if (new Set(input.issues).size !== input.issues.length || input.issues.some(v => !CV_ANALYSIS_ISSUES.includes(v)) || input.issues.length && input.facts.length || !Array.isArray(blocks)) invalid();
    const fields = new Set();
    const facts = input.facts.map(f => {
        exact(f, ['field', 'value', 'evidence']);
        if (!EXTRACTION_FIELDS.includes(f.field) || fields.has(f.field)) invalid(); fields.add(f.field); list(f.evidence, 1, 3);
        const value = normalizeTelegramDraftFields({ [f.field]: f.value }, { partial: true })[f.field];
        if (value == null || value === '' || Array.isArray(value) && value.length === 0) invalid();
        const evidence = f.evidence.map(e => {
            exact(e, ['blockOrdinal', 'startByte', 'endByte', 'quote']); integer(e.blockOrdinal, 0, 1999); integer(e.startByte, 0, 65535); integer(e.endByte, e.startByte + 1, 65536); text(e.quote, 2000);
            const b = blocks[e.blockOrdinal]; if (!b || b.ordinal !== e.blockOrdinal) invalid();
            const bytes = Buffer.from(b.text), selected = bytes.subarray(e.startByte, e.endByte);
            if (e.endByte > bytes.length || Buffer.byteLength(e.quote) > 8000 || !Buffer.from(e.quote).equals(selected)) invalid();
            return e;
        });
        if (['firstName', 'lastName', 'primaryEmail', 'secondaryEmails'].includes(f.field)) {
            const quotes = evidence.map(e => e.quote.toLowerCase());
            for (const v of Array.isArray(value) ? value : [value]) if (!quotes.some(q => q.includes(v.toLowerCase()))) invalid();
        }
        return { field: f.field, value, evidence };
    });
    normalizeTelegramDraftFields(Object.fromEntries(facts.map(f => [f.field, f.value])), { partial: true });
    return { facts, issues: input.issues };
}

export function cvAnalysisStaffAction(input) {
    if (input?.action === 'analyze') {
        exact(input, ['action', 'draftId', 'expectedDocumentRevision', 'operationId']);
        return { ...input, draftId: assertUuid(input.draftId, 'draftId'), expectedDocumentRevision: integer(input.expectedDocumentRevision, 0), operationId: assertUuid(input.operationId, 'operationId') };
    }
    if (['cancel', 'retry', 'reviewText'].includes(input?.action)) {
        exact(input, input.action === 'reviewText' ? ['action', 'analysisId', 'expectedAnalysisVersion', 'decision'] : ['action', 'analysisId', 'expectedAnalysisVersion']);
        if (input.action === 'reviewText' && !['include', 'exclude'].includes(input.decision)) invalid();
        return { ...input, analysisId: assertUuid(input.analysisId, 'analysisId'), expectedAnalysisVersion: integer(input.expectedAnalysisVersion, 1) };
    }
    if (input?.action === 'resolve') {
        exact(input, ['action', 'analysisId', 'proposalId', 'expectedDraftVersion', 'decision']); if (!['apply', 'dismiss'].includes(input.decision)) invalid();
        return { ...input, analysisId: assertUuid(input.analysisId, 'analysisId'), proposalId: assertUuid(input.proposalId, 'proposalId'), expectedDraftVersion: integer(input.expectedDraftVersion, 1) };
    }
    invalid();
}
export function cvAnalysisWorkerInput(action, input) {
    if (action === 'claim') { exact(input, []); return {}; }
    const keys = ['jobId', 'leaseToken', 'sourceDigest'];
    if (action === 'complete') exact(input, input?.stage === 'facts' ? [...keys, 'stage', 'result', 'metadata'] : [...keys, 'stage', 'result']);
    else if (action === 'fail') exact(input, [...keys, 'stage', 'code', 'retryAfterSeconds']);
    else if (action === 'content') exact(input, keys); else invalid();
    const parsed = { ...input, jobId: assertUuid(input.jobId, 'jobId'), leaseToken: assertUuid(input.leaseToken, 'leaseToken'), sourceDigest: hash(input.sourceDigest) };
    if (action !== 'content' && !['parse', 'facts'].includes(input.stage)) invalid();
    if (action === 'fail') { if (!CV_ANALYSIS_FAILURE_CODES.includes(input.code)) invalid(); integer(input.retryAfterSeconds, 1, 3600); }
    if (action === 'complete' && Buffer.byteLength(JSON.stringify(input)) > (input.stage === 'parse' ? CV_ANALYSIS_PARSE_BODY_LIMIT : CV_ANALYSIS_BODY_LIMIT)) invalid();
    if (action === 'complete' && input.stage === 'facts') {
        exact(input.metadata, ['model', 'promptVersion', 'reportedModel']);
        if (input.metadata.promptVersion !== CV_ANALYSIS_PROMPT_VERSION) invalid();
        for (const v of [input.metadata.model, input.metadata.reportedModel]) if (v !== null && (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,119}$/.test(v) || v.includes('://'))) invalid();
        if (input.metadata.model === null) invalid();
    }
    return parsed;
}
