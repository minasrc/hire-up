import { withStaffTransaction } from './staff-authorization.js';
import { ClientJobContractError } from './client-job-contracts.js';
import { validateConnectorPublicKey, validateTelegramConnectionAction, validateTelegramConnectionReport } from './telegram-connection-contracts.js';

export function telegramConnectionStatus(pool, identity, org) {
    return withStaffTransaction(pool, identity, org, ['candidates.read', 'candidates.write'], async ({ client }) =>
        (await client.query('select app.telegram_connection_status_v1() as result')).rows[0].result);
}
export function telegramConnectionAction(pool, identity, org, input) {
    const action = validateTelegramConnectionAction(input);
    const [sql, args] = action.action === 'connect'
        ? ['select app.telegram_connection_start_v1($1) as result', [action.workerId]]
        : action.action === 'disconnect'
            ? ['select app.telegram_connection_disconnect_v1($1,$2) as result', [action.connectionId, action.generation]]
            : ['select app.telegram_connection_password_v1($1,$2,$3,$4) as result', [action.connectionId, action.generation, action.challengeId, action.ciphertext]];
    return withStaffTransaction(pool, identity, org, ['candidates.read', 'candidates.write'], async ({ client }) =>
        (await client.query(sql, args)).rows[0].result);
}
export async function telegramConnectorOperation(pool, token, action, input) {
    if (!/^[A-Za-z0-9_-]{64}$/.test(token ?? '')) { const error = new Error('Unauthorized'); error.code = '42501'; throw error; }
    let sql; let args;
    if (action === 'heartbeat') {
        if (!input || Object.keys(input).some((key) => key !== 'publicKeySpki')) throw new ClientJobContractError({ input: 'Invalid heartbeat.' });
        sql = 'select app.telegram_connection_heartbeat_v1($1,$2) as result'; args = [token, validateConnectorPublicKey(input.publicKeySpki)];
    } else if (action === 'claim') {
        if (!input || Object.keys(input).length) throw new ClientJobContractError({ input: 'Invalid claim.' });
        sql = 'select app.telegram_connection_claim_v1($1) as result'; args = [token];
    } else if (action === 'update') {
        const report = validateTelegramConnectionReport(input);
        sql = 'select app.telegram_connection_update_v1($1,$2,$3,$4,$5::jsonb) as result';
        args = [token, report.connectionId, report.generation, report.leaseToken, JSON.stringify(report.report)];
    } else throw new ClientJobContractError({ action: 'Unsupported connector action.' });
    const client = await pool.connect();
    try {
        await client.query("begin isolation level read committed; set local role app_telegram_worker; set local statement_timeout='10s'; set local lock_timeout='2s'");
        const { rows } = await client.query(sql, args);
        await client.query('commit');
        return rows[0].result;
    } catch (error) {
        await client.query('rollback').catch(() => {}); throw error;
    } finally { client.release(); }
}
