import { ClientJobContractError } from './client-job-contracts.js';
import { assertUuid } from './candidate-profile-contracts.js';
import { TELEGRAM_INDEX_VERSION } from './telegram-intake-operations.js';

export function validateWorkerResult(input) {
    if (!input || Object.keys(input).some((key) => !['indexVersion', 'embeddings'].includes(key))
        || input.indexVersion !== TELEGRAM_INDEX_VERSION || !Array.isArray(input.embeddings) || input.embeddings.length !== 1) {
        throw new ClientJobContractError({ result: 'Invalid embedding result.' });
    }
    for (const vector of input.embeddings) {
        if (!Array.isArray(vector) || vector.length !== 384 || !vector.every((v) => typeof v === 'number' && Number.isFinite(v))) {
            throw new ClientJobContractError({ result: 'Invalid embedding vector.' });
        }
        const norm = vector.reduce((sum, v) => sum + v * v, 0);
        if (norm < 0.98 || norm > 1.02) throw new ClientJobContractError({ result: 'Embedding must be normalized.' });
    }
    return input;
}

// Called only by the hosted API. The Mac holds a scoped token, never this pool.
export async function telegramWorkerOperation(pool, token, action, input = {}) {
    if (!/^[A-Za-z0-9_-]{64}$/.test(token ?? '')) {
        const error = new Error('Worker unauthorized'); error.code = '42501'; throw error;
    }
    let sql; let args;
    if (action === 'claim') {
        sql = 'select app.telegram_claim_job_v1($1) as result'; args = [token];
    } else if (action === 'complete') {
        sql = 'select app.telegram_complete_job_v1($1,$2,$3,$4::jsonb) as result';
        args = [token, assertUuid(input.jobId, 'jobId'), assertUuid(input.leaseToken, 'leaseToken'), JSON.stringify(validateWorkerResult(input.result))];
    } else if (action === 'fail') {
        if (!['EMBEDDING_UNAVAILABLE', 'INVALID_JOB', 'WORKER_ERROR'].includes(input.code)) throw new ClientJobContractError({ code: 'Invalid failure code.' });
        sql = 'select app.telegram_fail_job_v1($1,$2,$3,$4) as result';
        args = [token, assertUuid(input.jobId, 'jobId'), assertUuid(input.leaseToken, 'leaseToken'), input.code];
    } else throw new ClientJobContractError({ action: 'Unsupported worker action.' });
    const client = await pool.connect();
    try {
        await client.query("begin isolation level read committed; set local role app_telegram_worker; set local statement_timeout='10s'; set local lock_timeout='2s'");
        const { rows } = await client.query(sql, args);
        await client.query('commit');
        return rows[0].result;
    } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
    } finally { client.release(); }
}
