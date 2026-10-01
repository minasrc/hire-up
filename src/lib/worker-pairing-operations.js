import { withStaffTransaction } from './staff-authorization.js';
import { workerDeviceInput, workerDeviceFilters, workerPairingInput, WorkerPairingError } from './worker-pairing-contracts.js';
const status = Symbol('httpStatus');
export const workerPairingStatus = result => result?.[status] ?? 200;
function unwrap(value) {
    if (!value?.ok) throw new WorkerPairingError(value?.code ?? 'PAIRING_UNAVAILABLE', value?.httpStatus ?? 503, value?.retryAfterSeconds);
    const data = value.data;
    Object.defineProperty(data, status, { value: value.httpStatus ?? 200 });
    if (data.nextAfter && typeof data.nextAfter === 'object') data.nextAfter = Buffer.from(JSON.stringify(data.nextAfter)).toString('base64url');
    return data;
}
const query = async (client, sql, args) => (await client.query(sql, args)).rows[0].result;
export async function workerDeviceStatus(pool, identity, org, filters = {}) {
    const parsed = workerDeviceFilters(filters);
    const result = await withStaffTransaction(pool, identity, org, ['candidates.read', 'candidates.write'], ({ client }) => query(client, 'select app.worker_device_status_v1($1,$2::jsonb) result', [parsed.pairingId, parsed.after && JSON.stringify(parsed.after)]));
    return unwrap(result);
}
export async function workerDeviceAction(pool, identity, org, input) {
    const parsed = workerDeviceInput(input);
    const result = await withStaffTransaction(pool, identity, org, ['candidates.read', 'candidates.write'], ({ client }) => query(client, 'select app.worker_device_action_v1($1::jsonb) result', [JSON.stringify(parsed)]));
    return unwrap(result); // Expected rejections are raised only AFTER COMMIT.
}
export async function workerPairingOperation(pool, action, proof, input) {
    if (!['claim', 'poll'].includes(action)) throw new WorkerPairingError('INVALID_INPUT');
    // SQL debits the global budget before validating input/proof. Do not throw
    // for malformed public input here, or failed guesses would be uncharged.
    let parsed;
    try { parsed = workerPairingInput(action, input); } catch { parsed = null; }
    const safeProof = typeof proof === 'string' && /^[A-Za-z0-9_-]{43}$/.test(proof) ? proof : '';
    const client = await pool.connect(); let result;
    try {
        await client.query("begin;set local role app_worker_pairing;set local statement_timeout='2s';set local lock_timeout='500ms'");
        result = await query(client, `select app.worker_pairing_${action}_v1($1,$2::jsonb) result`, [safeProof, JSON.stringify(parsed)]);
        await client.query('commit');
    } catch (error) { await client.query('rollback').catch(() => {}); throw error; }
    finally { client.release(); }
    return unwrap(result);
}
