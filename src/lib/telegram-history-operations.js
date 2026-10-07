import { withStaffTransaction } from './staff-authorization.js';
import { ClientJobContractError } from './client-job-contracts.js';
import { assertUuid } from './candidate-profile-contracts.js';
import { historyStaffAction, historyWorkerInput } from './telegram-history-contracts.js';
const staff = (pool, identity, org, fn) => withStaffTransaction(pool, identity, org, ['candidates.read', 'candidates.write'], fn);
export function telegramHistoryStatus(pool, identity, org, filters = {}) {
    const { view = 'all', q = '', after = null } = filters;
    if (!['all', 'selected', 'active', 'paused'].includes(view) || typeof q !== 'string' || !q.isWellFormed() || q.length > 100) throw new ClientJobContractError({ query: 'Invalid history filter.' });
    return staff(pool, identity, org, async ({ client }) => (await client.query('select app.telegram_history_status_v1($1,$2,$3) as result', [view, q, after == null ? null : assertUuid(after, 'after')])).rows[0].result);
}
export function telegramHistoryAction(pool, identity, org, input) {
    const action = historyStaffAction(input);
    return staff(pool, identity, org, async ({ client }) => (await client.query('select app.telegram_history_action_v1($1::jsonb) as result', [JSON.stringify(action)])).rows[0].result);
}
export async function telegramHistoryWorkerOperation(pool, token, action, input) {
    if (!/^[A-Za-z0-9_-]{64}$/.test(token ?? '')) { const error = new Error('Unauthorized'); error.code = '42501'; throw error; }
    const parsed = historyWorkerInput(action, input);
    const proof = parsed.proof;
    const args = [token, proof.connectionId, proof.generation, proof.connectionLeaseToken, proof.accountUserId];
    let sql;
    if (action === 'claim') sql = 'select app.telegram_history_claim_v1($1,$2,$3,$4,$5) as result';
    else if (action === 'complete') {
        sql = 'select app.telegram_history_complete_v1($1,$2,$3,$4,$5,$6,$7,$8::jsonb) as result';
        args.push(parsed.jobId, parsed.jobLeaseToken, JSON.stringify(parsed.payload));
    } else {
        sql = 'select app.telegram_history_defer_v1($1,$2,$3,$4,$5,$6,$7,$8,$9) as result';
        args.push(parsed.jobId, parsed.jobLeaseToken, parsed.code, parsed.retryAfterSeconds);
    }
    const client = await pool.connect();
    try {
        await client.query("begin isolation level read committed; set local role app_telegram_worker; set local statement_timeout='10s'; set local lock_timeout='2s'");
        const { rows } = await client.query(sql, args); await client.query('commit'); return rows[0].result;
    } catch (error) { await client.query('rollback').catch(() => {}); throw error; }
    finally { client.release(); }
}
