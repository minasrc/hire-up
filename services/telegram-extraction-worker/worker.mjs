import { EXTRACTION_SCHEMA_VERSION, EXTRACTION_PROMPT_VERSION, EXTRACTION_MESSAGE_LIMIT, EXTRACTION_SOURCE_LIMIT, EXTRACTION_SINGLE_SOURCE_LIMIT, EXTRACTION_BODY_LIMIT, validateExtractionResult, extractionWorkerInput } from '../../src/lib/telegram-extraction-contracts.js';
import { ExtractionWorkerError } from './config.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const failCodes = new Set(['PROVIDER_UNAVAILABLE', 'INVALID_RESULT', 'WORKER_ERROR']);
function checkJob(job, now) {
  const sourceLimit = job?.sourceLimitBytes ?? EXTRACTION_SOURCE_LIMIT;
  const messages = job?.source?.messages;
  const validLimit = sourceLimit === EXTRACTION_SOURCE_LIMIT || (sourceLimit === EXTRACTION_SINGLE_SOURCE_LIMIT && Array.isArray(messages) && messages.length === 1);
  // The host applies canonical PostgreSQL JSON bounds. The worker independently
  // bounds its actual wire JSON, and never widens a normal multi-message batch.
  if (!job || !uuid.test(job.id) || !uuid.test(job.leaseToken) || !/^[0-9a-f]{64}$/.test(job.sourceDigest) || job.schemaVersion !== EXTRACTION_SCHEMA_VERSION || job.promptVersion !== EXTRACTION_PROMPT_VERSION || !Number.isFinite(Date.parse(job.leaseExpiresAt)) || Date.parse(job.leaseExpiresAt) < now + 75000 || !job.source?.chat || !Array.isArray(messages) || messages.length < 1 || messages.length > EXTRACTION_MESSAGE_LIMIT || !validLimit || Buffer.byteLength(JSON.stringify(job.source)) > sourceLimit) throw new ExtractionWorkerError('INVALID_JOB');
}

// A pending ACK is durable before the first submission. In particular a network
// failure must never turn a possibly committed completion into a failure report.
export function createExtractionWorker({ host, provider, pendingStore, now = Date.now }) {
  let busy = false;
  async function acknowledge(pending, signal) {
    if (signal?.aborted) throw new ExtractionWorkerError('STOPPED');
    try {
      const response = await host(pending.action, pending.body, { signal });
      if (response?.ok !== true) throw new ExtractionWorkerError('INVALID_RESPONSE');
      await pendingStore.clear();
      return pending.action === 'complete' ? 'completed' : 'failed';
    } catch (error) {
      if (error.status === 409) {
        // The server checks an exact committed receipt before its lease fence.
        // A conflict therefore cannot acknowledge this result; server truth wins.
        await pendingStore.clear();
        return 'fenced';
      }
      if (pending.action === 'complete' && [400, 422].includes(error.status)) {
        const rejected = { action: 'fail', body: { jobId: pending.body.jobId, leaseToken: pending.body.leaseToken, code: 'INVALID_RESULT', retryAfterSeconds: 1 } };
        await pendingStore.save(rejected);
        return acknowledge(rejected, signal);
      }
      throw error;
    }
  }
  return {
    async tick({ signal } = {}) {
      if (busy) return 'busy';
      busy = true;
      try {
        const pending = await pendingStore.load();
        if (pending) {
          if (!['complete', 'fail'].includes(pending.action)) throw new ExtractionWorkerError('INVALID_LOCAL_STATE');
          extractionWorkerInput(pending.action, pending.body);
          return await acknowledge(pending, signal);
        }
        if (signal?.aborted) throw new ExtractionWorkerError('STOPPED');
        const response = await host('claim', {}, { signal });
        if (response?.job === null) return 'idle';
        const job = response?.job;
        checkJob(job, now());
        let completion;
        try {
          const produced = await provider(job.source, { signal });
          if (signal?.aborted) throw new ExtractionWorkerError('STOPPED');
          const result = validateExtractionResult(produced.result, job.source);
          const body = extractionWorkerInput('complete', { jobId: job.id, leaseToken: job.leaseToken, sourceDigest: job.sourceDigest, result, metadata: produced.metadata });
          if (Buffer.byteLength(JSON.stringify(body)) > EXTRACTION_BODY_LIMIT) throw new ExtractionWorkerError('INVALID_RESULT');
          completion = { action: 'complete', body };
        } catch (error) {
          if (error.code === 'STOPPED' || signal?.aborted) throw new ExtractionWorkerError('STOPPED');
          const code = failCodes.has(error.code) ? error.code : 'INVALID_RESULT';
          completion = { action: 'fail', body: { jobId: job.id, leaseToken: job.leaseToken, code, retryAfterSeconds: code === 'INVALID_RESULT' ? 1 : 30 } };
        }
        await pendingStore.save(completion);
        return await acknowledge(completion, signal);
      } finally { busy = false; }
    },
  };
}
