import { createHash } from 'node:crypto';
import { assertUuid } from './candidate-profile-contracts.js';
import { ClientJobContractError } from './client-job-contracts.js';
export const PROFILE_INDEX_VERSION = 'intfloat/multilingual-e5-small@614241f622f53c4eeff9890bdc4f31cfecc418b3:e5-prefix:l2:384:v1';
export const PROFILE_PROJECTION_VERSION = 'candidate-profile-v1';
export const PROFILE_CHUNKER_VERSION = 'e5-utf8-448-v1';
export const PROFILE_SOURCE_BYTE_LIMIT = 65536;
export const PROFILE_WORKER_BODY_LIMIT = 262144;
const bad = field => { throw new ClientJobContractError({ [field]: 'Invalid search input.' }); };
const object = (v, keys) => { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) bad('input'); return v; };
export function profileSearchScope(scope = 'approved') { if (!['approved', 'my_drafts', 'all'].includes(scope)) bad('scope'); return scope; }
export function profileSearchStaffInput(input) {
    object(input, ['action', 'operationId', 'query', 'scope', 'readyOnly', 'queryId']);
    if (input.action === 'cancel') return { action: 'cancel', queryId: assertUuid(input.queryId, 'queryId') };
    if (input.action === 'retryIndex') {
        object(input, ['action', 'scope', 'readyOnly']);
        if (input.readyOnly != null && typeof input.readyOnly !== 'boolean') bad('readyOnly');
        return { action: 'retryIndex', scope: profileSearchScope(input.scope), readyOnly: input.readyOnly ?? false };
    }
    if (input.action !== 'search') bad('action');
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if (!query || !query.isWellFormed() || query.length > 2000 || Buffer.byteLength(query) > 8000 || /[\u0000]/u.test(query)) bad('query');
    if (input.readyOnly != null && typeof input.readyOnly !== 'boolean') bad('readyOnly');
    return { action: 'search', operationId: assertUuid(input.operationId, 'operationId'), query, scope: profileSearchScope(input.scope), readyOnly: input.readyOnly ?? false };
}
export function validateProfileVector(vector) {
    if (!Array.isArray(vector) || vector.length !== 384 || !vector.every(v => typeof v === 'number' && Number.isFinite(v))) bad('embedding');
    const norm = vector.reduce((sum, v) => sum + v * v, 0); if (norm < 0.98 || norm > 1.02) bad('embedding');
    return vector;
}
export function profileSearchWorkerInput(action, input = {}) {
    if (action === 'claim') return object(input, []);
    const common = ['jobId', 'leaseToken', 'kind'];
    if (action === 'fail') {
        object(input, [...common, 'code', 'retryAfterSeconds']);
        if (!['EMBEDDING_UNAVAILABLE', 'INVALID_RESULT', 'INPUT_TOO_LONG', 'WORKER_ERROR'].includes(input.code) || !Number.isInteger(input.retryAfterSeconds) || input.retryAfterSeconds < 1 || input.retryAfterSeconds > 3600) bad('code');
    } else if (action === 'complete') {
        object(input, [...common, 'indexVersion', 'projectionVersion', 'chunkerVersion', 'querySha256', 'sourceRevision', 'sourceSha256', 'manifestSha256', 'result']);
        if (input.indexVersion !== PROFILE_INDEX_VERSION || input.projectionVersion !== PROFILE_PROJECTION_VERSION || input.chunkerVersion !== PROFILE_CHUNKER_VERSION) bad('version');
        if (input.kind === 'query') { object(input.result, ['embedding']); validateProfileVector(input.result.embedding); if (!/^[a-f0-9]{64}$/.test(input.querySha256)) bad('querySha256'); }
        else {
            if (!Number.isSafeInteger(input.sourceRevision) || input.sourceRevision < 1 || !/^[a-f0-9]{64}$/.test(input.sourceSha256)) bad('source');
            if (input.kind === 'plan') {
                object(input.result, ['byteLength', 'chunks']);
                if (!Number.isInteger(input.result.byteLength) || input.result.byteLength < 1 || input.result.byteLength > PROFILE_SOURCE_BYTE_LIMIT || !Array.isArray(input.result.chunks) || input.result.chunks.length < 1 || input.result.chunks.length > 256) bad('manifest');
                let end = 0;
                input.result.chunks.forEach((c, ordinal) => {
                    object(c, ['ordinal', 'startByte', 'endByte', 'sha256', 'tokenCount']);
                    if (c.ordinal !== ordinal || c.startByte !== end || !Number.isInteger(c.endByte) || c.endByte <= end || c.endByte - end > 16384 || !Number.isInteger(c.tokenCount) || c.tokenCount < 1 || c.tokenCount > 448 || !/^[a-f0-9]{64}$/.test(c.sha256)) bad('manifest'); end = c.endByte;
                });
                if (end !== input.result.byteLength) bad('manifest');
            } else if (input.kind === 'embed') {
                object(input.result, ['embeddings']);
                if (!/^[a-f0-9]{64}$/.test(input.manifestSha256) || !Array.isArray(input.result.embeddings) || input.result.embeddings.length < 1 || input.result.embeddings.length > 8) bad('embeddings');
                const ordinals = new Set();
                for (const e of input.result.embeddings) { object(e, ['ordinal', 'embedding']); if (!Number.isInteger(e.ordinal) || e.ordinal < 0 || e.ordinal > 255 || ordinals.has(e.ordinal)) bad('ordinal'); ordinals.add(e.ordinal); validateProfileVector(e.embedding); }
            }
        }
    } else bad('action');
    assertUuid(input.jobId, 'jobId'); assertUuid(input.leaseToken, 'leaseToken');
    if (!['query', 'plan', 'embed'].includes(input.kind)) bad('kind'); return input;
}
export function validateProfileManifest(text, manifest) {
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length !== manifest.byteLength) bad('manifest');
    for (const chunk of manifest.chunks) {
        const slice = bytes.subarray(chunk.startByte, chunk.endByte); let decoded;
        try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(slice); } catch { bad('manifest'); }
        if ([...decoded].length > 16000 || createHash('sha256').update(slice).digest('hex') !== chunk.sha256) bad('manifest');
    }
    return manifest;
}
export function profileSearchCursor(after, queryId) {
    if (after == null) return null;
    try {
        if (typeof after !== 'string' || after.length > 512 || !/^[A-Za-z0-9_-]+$/.test(after)) bad('after');
        const c = JSON.parse(Buffer.from(after, 'base64url').toString()); object(c, ['queryId', 'score', 'sourceType', 'sourceId']);
        if (c.queryId !== queryId || typeof c.score !== 'number' || !Number.isFinite(c.score) || !['candidate', 'draft'].includes(c.sourceType)) bad('after');
        assertUuid(c.sourceId, 'after'); return c;
    } catch { bad('after'); }
}
