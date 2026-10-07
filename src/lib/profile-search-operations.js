import { withStaffTransaction } from './staff-authorization.js';
import { assertUuid } from './candidate-profile-contracts.js';
import { ClientJobContractError } from './client-job-contracts.js';
import { profileSearchScope, profileSearchStaffInput, profileSearchWorkerInput, profileSearchCursor, validateProfileManifest } from './profile-search-contracts.js';
const staff = (pool, identity, org, fn) => withStaffTransaction(pool, identity, org, ['candidates.read', 'candidates.write'], fn);
const result = async (client, sql, args) => (await client.query(sql, args)).rows[0].result;
export function profileSearchStatus(pool, identity, org, { scope = 'approved', readyOnly = false, queryId = null, after = null } = {}) {
    profileSearchScope(scope); if (typeof readyOnly !== 'boolean') throw new ClientJobContractError({ readyOnly: 'Choose a valid filter.' });
    if (queryId) assertUuid(queryId, 'queryId');
    const cursor = profileSearchCursor(after, queryId);
    return staff(pool, identity, org, async ({ client }) => {
        const response = await result(client, 'select app.profile_search_status_v1($1,$2,$3,$4::jsonb) as result', [scope, readyOnly, queryId, cursor && JSON.stringify(cursor)]);
        if (response.nextAfter) response.nextAfter = Buffer.from(JSON.stringify(response.nextAfter)).toString('base64url'); return response;
    });
}
export function profileSearchAction(pool, identity, org, input) {
    const parsed = profileSearchStaffInput(input);
    return staff(pool, identity, org, ({ client }) => result(client, 'select app.profile_search_action_v1($1::jsonb) as result', [JSON.stringify(parsed)]));
}
async function workerTransaction(pool, fn) {
    const client = await pool.connect();
    try {
        await client.query("begin isolation level read committed; set local role app_telegram_worker; set local statement_timeout='10s'; set local lock_timeout='2s'; set local jit=off");
        const output = await fn(client); await client.query('commit'); return output;
    } catch (error) { await client.query('rollback').catch(() => {}); throw error; }
    finally { client.release(); }
}
export async function profileSearchWorkerOperation(pool, token, action, input = {}) {
    if (!/^[A-Za-z0-9_-]{64}$/.test(token ?? '')) { const error = new Error('Unauthorized'); error.code = '42501'; throw error; }
    const parsed = profileSearchWorkerInput(action, input);
    const output = await workerTransaction(pool, async client => {
        if (action === 'claim') return result(client, 'select app.profile_search_worker_claim_v1($1) as result', [token]);
        if (action === 'complete' && parsed.kind === 'plan') {
            const text = await result(client, 'select app.profile_search_worker_source_v1($1,$2,$3,$4) as result', [token, parsed.jobId, parsed.sourceRevision, parsed.sourceSha256]);
            // SQL independently repeats coverage/hash checks for the restricted role.
            if (text != null) validateProfileManifest(text, parsed.result);
        }
        return result(client, `select app.profile_search_worker_${action}_v1($1,$2::jsonb) as result`, [token, JSON.stringify(parsed)]);
    });
    if (output.status !== 'scoring') return output;
    // Separate frontend command arms the actual scoring deadline. Persist a
    // terminal timeout in a new authenticated transaction after rollback.
    try { return await workerTransaction(pool, client => result(client, 'select app.profile_search_score_v1($1,$2,$3) as result', [token, parsed.jobId, parsed.leaseToken])); }
    catch (error) {
        if (error.code !== '57014') throw error;
        return workerTransaction(pool, client => result(client, 'select app.profile_search_timeout_v1($1,$2,$3) as result', [token, parsed.jobId, parsed.leaseToken]));
    }
}
