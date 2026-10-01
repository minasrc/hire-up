import { createHash } from 'node:crypto';
import { withStaffTransaction } from './staff-authorization.js';
import { assertUuid } from './candidate-profile-contracts.js';
import { ClientJobContractError } from './client-job-contracts.js';
import { normalizeTelegramDraftFields } from './telegram-intake-contracts.js';
import { CANDIDATE_CV_BUCKET } from './candidate-upload-storage.js';
import { cvAnalysisStaffAction, cvAnalysisWorkerInput, validateCvParsedResult, validateCvFactsResult, CV_ANALYSIS_MAX_BYTES } from './cv-analysis-contracts.js';
const result = async (client, sql, args = []) => (await client.query(sql, args)).rows[0].result;
const staff = (pool, identity, org, fn) => withStaffTransaction(pool, identity, org, ['candidates.read', 'candidates.write', 'documents.download'], fn);
const bad = () => { throw new ClientJobContractError({ cvAnalysis: 'Invalid CV analysis request.' }); };
export function cvAnalysisStatus(pool, identity, org, filters = {}) {
    const { draftId = null, analysisId = null, after = null, proposalAfter = null, blockAfter = null } = filters;
    if (Boolean(draftId) === Boolean(analysisId)) bad();
    if (blockAfter !== null && (!Number.isSafeInteger(Number(blockAfter)) || Number(blockAfter) < -1 || Number(blockAfter) > 1999)) bad();
    return staff(pool, identity, org, ({ client }) => result(client, 'select app.cv_analysis_status_v1($1,$2,$3,$4,$5) result', [draftId ? assertUuid(draftId, 'draftId') : null, analysisId ? assertUuid(analysisId, 'analysisId') : null, after ? assertUuid(after, 'after') : null, proposalAfter ? assertUuid(proposalAfter, 'proposalAfter') : null, blockAfter === null ? null : Number(blockAfter)]));
}
export function cvAnalysisAction(pool, identity, org, input) {
    const parsed = cvAnalysisStaffAction(input);
    return staff(pool, identity, org, async ({ client }) => {
        if (parsed.action === 'resolve' && parsed.decision === 'apply') {
            const proposal = await result(client, 'select app.cv_analysis_proposal_v1($1,$2) result', [parsed.analysisId, parsed.proposalId]);
            normalizeTelegramDraftFields({ ...proposal.fields, [proposal.field]: proposal.value });
        }
        return result(client, 'select app.cv_analysis_action_v1($1::jsonb) result', [JSON.stringify(parsed)]);
    });
}
async function worker(pool, token, fn) {
    if (!/^[A-Za-z0-9_-]{64}$/.test(token ?? '')) { const e = new Error('Unauthorized'); e.code = '42501'; throw e; }
    const client = await pool.connect();
    try {
        await client.query("begin isolation level read committed; set local role app_telegram_worker; set local statement_timeout='10s'; set local lock_timeout='2s'");
        const output = await fn(client); await client.query('commit'); return output;
    } catch (e) { await client.query('rollback').catch(() => {}); throw e; } finally { client.release(); }
}
export function cvAnalysisWorkerOperation(pool, token, action, input) {
    if (!['claim', 'complete', 'fail'].includes(action)) bad();
    const parsed = cvAnalysisWorkerInput(action, input);
    return worker(pool, token, async client => {
        if (action === 'claim') return result(client, 'select app.cv_analysis_claim_v1($1) result', [token]);
        if (action === 'fail') return result(client, 'select app.cv_analysis_fail_v1($1,$2::jsonb) result', [token, JSON.stringify(parsed)]);
        const receipt = await result(client, 'select app.cv_analysis_receipt_v1($1,$2::jsonb) result', [token, JSON.stringify(parsed)]);
        if (receipt) return receipt;
        const source = await result(client, 'select app.cv_analysis_source_read_v1($1,$2,$3,$4) result', [token, parsed.jobId, parsed.leaseToken, parsed.sourceDigest]);
        const validated = parsed.stage === 'parse' ? validateCvParsedResult(parsed.result, source) : validateCvFactsResult(parsed.result, source.blocks);
        return result(client, 'select app.cv_analysis_complete_v1($1,$2::jsonb) result', [token, JSON.stringify({ ...parsed, result: validated })]);
    });
}
export async function readCvAnalysisContent(pool, token, input, storage) {
    const parsed = cvAnalysisWorkerInput('content', input);
    const check = () => worker(pool, token, client => result(client, 'select app.cv_analysis_content_v1($1,$2,$3,$4) result', [token, parsed.jobId, parsed.leaseToken, parsed.sourceDigest]));
    const source = await check();
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10000);
    let reader; const chunks = []; let size = 0;
    try {
        const download = storage.storage.from(CANDIDATE_CV_BUCKET).download(source.objectKey, {}, { signal: controller.signal });
        const response = await (typeof download.asStream === 'function' ? download.asStream() : download);
        if (response?.error || !response?.data) throw new Error('Storage unavailable');
        if (typeof response.data.size === 'number' && (response.data.size > CV_ANALYSIS_MAX_BYTES || response.data.size !== source.sizeBytes)) bad();
        const stream = typeof response.data.getReader === 'function' ? response.data : response.data.stream?.();
        if (!stream) throw new Error('Storage unavailable'); reader = stream.getReader();
        while (true) {
            const { value, done } = await reader.read(); if (done) break;
            size += value.byteLength;
            if (size > CV_ANALYSIS_MAX_BYTES || size > source.sizeBytes) { controller.abort(); await reader.cancel(); bad(); }
            chunks.push(Buffer.from(value));
        }
        const bytes = Buffer.concat(chunks);
        if (size !== source.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== source.sha256) bad();
        await check(); return new Uint8Array(bytes);
    } finally { clearTimeout(timer); reader?.releaseLock(); }
}
