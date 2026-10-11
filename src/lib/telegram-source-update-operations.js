import { assertUuid } from './candidate-profile-contracts.js';
import { ClientJobContractError } from './client-job-contracts.js';
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

export function telegramSourceUpdateStatus(pool, identity, org, chatIds) {
 if (!Array.isArray(chatIds) || chatIds.length<1 || chatIds.length>50 || new Set(chatIds).size!==chatIds.length) throw new ClientJobContractError({chatIds:'Select between 1 and 50 chats.'});
 const ids=chatIds.map(id=>assertUuid(id,'chatIds'));
 return withStaffTransaction(pool, identity, org, ['candidates.read'], async ({client}) => (await client.query('select app.telegram_source_updates_status_v1($1::uuid[]) as result',[ids])).rows[0].result);
}
