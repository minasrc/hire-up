import { ClientJobContractError } from './client-job-contracts.js';
import { assertUuid } from './candidate-profile-contracts.js';
import { historyProof } from './telegram-history-contracts.js';
export const TELEGRAM_CV_MAX_BYTES = 4194304;
export const TELEGRAM_CV_CHUNK_BYTES = 524288;
export const TELEGRAM_CV_PROOF_HEADER = 'x-telegram-cv-proof';
const invalid = key => { throw new ClientJobContractError({ [key]: 'Invalid Telegram CV request.' }); };
const exact = (v, keys) => { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) invalid('input'); };
const integer = (v, min, max, key) => { if (!Number.isSafeInteger(v) || v < min || v > max) invalid(key); return v; };
const messageId = v => { if (typeof v !== 'string' || !/^[1-9][0-9]{0,9}$/.test(v) || BigInt(v) > 2147483647n) invalid('messageId'); return v; };
const hash = v => { if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) invalid('sha256'); return v; };
const proofKeys = ['connectionId', 'generation', 'connectionLeaseToken', 'accountUserId'];
export function cvAttachmentCursor(value) {
    if (value == null) return null;
    if (typeof value !== 'string' || value.length > 64) invalid('after');
    const parts = value.split(':'); if (parts.length !== 3) invalid('after');
    return { jobId: assertUuid(parts[0], 'after'), messageId: messageId(parts[1]), attachmentIndex: integer(Number(parts[2]), 0, 15, 'after') };
}
export function cvStaffAction(input) {
    if (input?.action === 'retrieve') {
        exact(input, ['action', 'draftId', 'expectedDocumentRevision', 'extractionJobId', 'messageId', 'attachmentIndex']);
        return { action: input.action, draftId: assertUuid(input.draftId, 'draftId'), expectedDocumentRevision: integer(input.expectedDocumentRevision, 0, Number.MAX_SAFE_INTEGER, 'expectedDocumentRevision'), extractionJobId: assertUuid(input.extractionJobId, 'extractionJobId'), messageId: messageId(input.messageId), attachmentIndex: integer(input.attachmentIndex, 0, 15, 'attachmentIndex') };
    }
    if (['cancel', 'retry'].includes(input?.action)) { exact(input, ['action', 'jobId']); return { action: input.action, jobId: assertUuid(input.jobId, 'jobId') }; }
    invalid('action');
}
export function cvWorkerInput(action, input) {
    const proof = historyProof(input);
    if (action === 'claim') { exact(input, proofKeys); return { proof }; }
    if (action === 'defer') {
        exact(input, [...proofKeys, 'jobId', 'jobLeaseToken', 'code', 'retryAfterSeconds']);
        if (!['FLOOD_WAIT', 'TELEGRAM_UNAVAILABLE', 'SOURCE_CHANGED', 'SOURCE_UNAVAILABLE', 'FILE_TOO_LARGE', 'INVALID_FILE', 'WORKER_ERROR'].includes(input.code)) invalid('code');
        return { proof, jobId: assertUuid(input.jobId, 'jobId'), jobLeaseToken: assertUuid(input.jobLeaseToken, 'jobLeaseToken'), code: input.code, retryAfterSeconds: integer(input.retryAfterSeconds, 1, 604800, 'retryAfterSeconds') };
    }
    if (action === 'upload') {
        exact(input, [...proofKeys, 'jobId', 'jobLeaseToken', 'sourceDigest', 'sha256', 'sizeBytes']);
        return { proof, jobId: assertUuid(input.jobId, 'jobId'), jobLeaseToken: assertUuid(input.jobLeaseToken, 'jobLeaseToken'), sourceDigest: hash(input.sourceDigest), sha256: hash(input.sha256), sizeBytes: integer(input.sizeBytes, 1, TELEGRAM_CV_MAX_BYTES, 'sizeBytes') };
    }
    invalid('action');
}
export function decodeCvUploadProof(header) {
    if (typeof header !== 'string' || header.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(header)) invalid('proof');
    let value;
    try { const bytes = Buffer.from(header, 'base64url'); if (bytes.toString('base64url') !== header) invalid('proof'); value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { invalid('proof'); }
    cvWorkerInput('upload', value); return value;
}
