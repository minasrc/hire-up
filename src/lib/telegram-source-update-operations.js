import { withStaffTransaction } from './staff-authorization.js';
import { sourceUpdateInput } from './telegram-source-update-contracts.js';
export async function telegramSourceUpdateWorkerOperation(pool, token, action, input) {
    if (!/^[A-Za-z0-9_-]{64}$/.test(token ?? '')) { const error = new Error('Unauthorized'); error.code = '42501'; throw error; }
    const parsed = sourceUpdateInput(action, input);
    const proof = parsed.proof;
    const args = [token, proof.connectionId, proof.generation, proof.connectionLeaseToken, proof.accountUserId];
    let sql;
    if (action === 'claim') sql = 'select app.telegram_source_updates_claim_v1($1,$2,$3,$4,$5) as result';
    else if (action === 'complete') {
        sql = 'select app.telegram_source_updates_complete_v1($1,$2,$3,$4,$5,$6,$7,$8::jsonb) as result';
        args.push(parsed.jobId, parsed.jobLeaseToken, JSON.stringify(parsed.payload));
    } else {
        sql = 'select app.telegram_source_updates_defer_v1($1,$2,$3,$4,$5,$6,$7,$8,$9) as result';
        args.push(parsed.jobId, parsed.jobLeaseToken, parsed.code, parsed.retryAfterSeconds);
    }
    const client = await pool.connect();
    try {
        await client.query("begin isolation level read committed; set local role app_telegram_worker; set local statement_timeout='10s'; set local lock_timeout='2s'");
        const { rows } = await client.query(sql, args); await client.query('commit'); return rows[0].result;
    } catch (error) { await client.query('rollback').catch(() => {}); throw error; }
    finally { client.release(); }
}

export function telegramSourceUpdateStatus(pool, identity, org) {
 return withStaffTransaction(pool, identity, org, ['candidates.read'], async ({client}) => (await client.query('select app.telegram_source_updates_status_v1() as result')).rows[0].result);
}
