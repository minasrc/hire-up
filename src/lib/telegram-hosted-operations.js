import { withStaffTransaction } from './staff-authorization.js';
import { hostedUuid, hostedStaffInput, hostedControlInput } from './telegram-hosted-contracts.js';
export function telegramHostedStatus(pool, identity, org, serviceId) {
    hostedUuid(serviceId);
    return withStaffTransaction(pool, identity, org, ['candidates.read', 'candidates.write'], async ({ client }) =>
        (await client.query('select app.telegram_hosted_status_v1($1) result', [serviceId])).rows[0].result);
}
export function telegramHostedPrepare(pool, identity, org, serviceId, input) {
    hostedUuid(serviceId); hostedStaffInput(input);
    return withStaffTransaction(pool, identity, org, ['candidates.read', 'candidates.write'], async ({ client }) =>
        (await client.query('select app.telegram_hosted_prepare_v1($1) result', [serviceId])).rows[0].result);
}
export async function telegramHostedControl(pool, serviceId, input) {
    hostedUuid(serviceId); const p = hostedControlInput(input);
    const args = [serviceId, p.instanceId, p.leaseToken ?? null];
    let sql;
    if (p.action === 'heartbeat') sql = 'select app.telegram_hosted_heartbeat_v1($1,$2,$3) result';
    else if (p.action === 'list') { sql = 'select app.telegram_hosted_list_v1($1,$2,$3,$4) result'; args.push(p.after ?? null); }
    else { sql = 'select app.telegram_hosted_register_v1($1,$2,$3,$4,$5,$6) result'; args.push(p.requestId, p.workerId, p.tokenSha256); }
    const client = await pool.connect();
    try {
        await client.query("begin;set local role app_telegram_hosted_service;set local statement_timeout='10s';set local lock_timeout='2s'");
        const result = (await client.query(sql, args)).rows[0].result;
        await client.query('commit'); return result;
    } catch (error) { await client.query('rollback').catch(() => {}); throw error; }
    finally { client.release(); }
}
