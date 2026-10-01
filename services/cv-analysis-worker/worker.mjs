import { createHash } from 'node:crypto';
import { CV_ANALYSIS_PARSER_VERSION, CV_ANALYSIS_PROMPT_VERSION, CV_ANALYSIS_MAX_BYTES, CV_ANALYSIS_PARSE_BODY_LIMIT, CV_ANALYSIS_BODY_LIMIT, CV_ANALYSIS_FAILURE_CODES, cvAnalysisWorkerInput, validateCvParsedResult, validateCvFactsResult } from '../../src/lib/cv-analysis-contracts.js';
import { ParserError } from './errors.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const hash = /^[0-9a-f]{64}$/u;
function checkJob(job, now) {
    const source = job?.source;
    if (!uuid.test(job?.id) || !uuid.test(job?.leaseToken) || !hash.test(job?.sourceDigest) || !['parse', 'facts'].includes(job?.stage) || !Number.isFinite(Date.parse(job.leaseExpiresAt)) || Date.parse(job.leaseExpiresAt) < now + 75000 || !source || !uuid.test(source.draftId) || !Number.isSafeInteger(source.documentRevision) || source.documentRevision < 0 || !hash.test(source.documentSha256) || !Number.isInteger(source.sizeBytes) || source.sizeBytes < 1 || source.sizeBytes > CV_ANALYSIS_MAX_BYTES || !['pdf', 'docx'].includes(source.extension) || Buffer.byteLength(JSON.stringify(source)) > 1048576) throw new ParserError('INVALID_JOB');
    if (source.parserVersion !== CV_ANALYSIS_PARSER_VERSION || source.promptVersion !== CV_ANALYSIS_PROMPT_VERSION) throw new ParserError('UNSUPPORTED_VERSION');
    if (job.stage === 'parse' && source.blocks !== null || job.stage === 'facts' && !Array.isArray(source.blocks)) throw new ParserError('INVALID_JOB');
}
export function createCvAnalysisWorker({ host, readContent, parse, extract, vault, now = Date.now }) {
    let busy = false;
    const failure = (body, code) => ({ action: 'fail', body: { jobId: body.jobId, leaseToken: body.leaseToken, sourceDigest: body.sourceDigest, stage: body.stage, code, retryAfterSeconds: ['STORAGE_UNAVAILABLE', 'PROVIDER_UNAVAILABLE', 'WORKER_ERROR'].includes(code) ? 30 : 1 } });
    async function acknowledge(pending, signal) {
        if (signal?.aborted) throw new ParserError('STOPPED');
        try {
            const response = await host(pending.action, pending.body, { signal });
            if (response?.ok !== true) throw new ParserError('INVALID_RESPONSE');
            await vault.clear(); return pending.action === 'complete' ? 'completed' : 'failed';
        } catch (error) {
            if (error.status === 409) { await vault.clear(); return 'fenced'; }
            if (pending.action === 'complete' && [400, 413, 422].includes(error.status)) {
                const rejected = failure(pending.body, 'INVALID_RESULT'); await vault.save(rejected); return acknowledge(rejected, signal);
            }
            throw error;
        }
    }
    return { async tick({ signal } = {}) {
        if (busy) return 'busy'; busy = true;
        try {
            const pending = await vault.load();
            if (pending) { if (!['complete', 'fail'].includes(pending.action)) throw new ParserError('INVALID_LOCAL_STATE'); cvAnalysisWorkerInput(pending.action, pending.body); return await acknowledge(pending, signal); }
            if (signal?.aborted) throw new ParserError('STOPPED');
            const response = await host('claim', {}, { signal }); if (response?.job === null) return 'idle';
            const job = response?.job;
            // Invalid authority/identity is never echoed as an arbitrary failure.
            if (!uuid.test(job?.id) || !uuid.test(job?.leaseToken) || !hash.test(job?.sourceDigest) || !['parse', 'facts'].includes(job?.stage)) throw new ParserError('INVALID_JOB');
            const proof = { jobId: job.id, leaseToken: job.leaseToken, sourceDigest: job.sourceDigest, stage: job.stage };
            let completion;
            try {
                checkJob(job, now());
                const stageSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(100000)]) : AbortSignal.timeout(100000);
                let result; let metadata;
                if (job.stage === 'parse') {
                    let bytes;
                    try { bytes = await readContent({ jobId: job.id, leaseToken: job.leaseToken, sourceDigest: job.sourceDigest }, { signal: stageSignal }); }
                    catch (error) { if ([401, 403, 409].includes(error.status) || stageSignal.aborted || error.code === 'INVALID_DOCUMENT') throw error; throw new ParserError('STORAGE_UNAVAILABLE'); }
                    bytes = Buffer.from(bytes);
                    if (bytes.length !== job.source.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== job.source.documentSha256) throw new ParserError('INVALID_DOCUMENT');
                    try { result = validateCvParsedResult(await parse(bytes, { extension: job.source.extension, signal: stageSignal }), job.source); }
                    finally { bytes.fill(0); }
                } else {
                    const produced = await extract(job.source, { signal: stageSignal });
                    result = validateCvFactsResult(produced.result, job.source.blocks); metadata = produced.metadata;
                }
                if (signal?.aborted) throw new ParserError('STOPPED');
                const body = cvAnalysisWorkerInput('complete', { ...proof, result, ...(metadata ? { metadata } : {}) });
                if (Buffer.byteLength(JSON.stringify(body)) > (job.stage === 'parse' ? CV_ANALYSIS_PARSE_BODY_LIMIT : CV_ANALYSIS_BODY_LIMIT)) throw new ParserError('INVALID_RESULT');
                completion = { action: 'complete', body };
            } catch (error) {
                if (signal?.aborted || error.code === 'STOPPED') throw new ParserError('STOPPED');
                if ([401, 403].includes(error.status)) throw error;
                if (error.status === 409) return 'fenced';
                completion = failure(proof, CV_ANALYSIS_FAILURE_CODES.includes(error.code) ? error.code : 'INVALID_RESULT');
            }
            await vault.save(completion); return await acknowledge(completion, signal);
        } finally { busy = false; }
    } };
}
