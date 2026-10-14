import { withStaffTransaction } from './staff-authorization.js';
import { ClientJobContractError } from './client-job-contracts.js';
import { assertUuid } from './candidate-profile-contracts.js';
import { historyStaffAction, historyWorkerInput } from './telegram-history-contracts.js';
const staff = (pool, identity, org, fn) => withStaffTransaction(pool, identity, org, ['candidates.read', 'candidates.write'], fn);
export function telegramHistoryStatus(pool, identity, org, filters = {}) {
    const { view = 'all', q = '', after = null } = filters;
    if (!['all', 'selected', 'active', 'paused', 'available', 'connected'].includes(view) || typeof q !== 'string' || !q.isWellFormed() || q.length > 100) throw new ClientJobContractError({ query: 'Invalid history filter.' });
    return staff(pool, identity, org, async ({ client }) => (await client.query('select app.telegram_history_status_v1($1,$2,$3) as result', [view, q, after == null ? null : assertUuid(after, 'after')])).rows[0].result);
}
// Keep the UUID-based entry point for older worker/database consumers.
export function telegramHistoryRecentStatus(pool, identity, org, filters = {}) {
    const { view = 'all', q = '', after = null } = filters;
    if (!['all', 'selected', 'active', 'paused', 'available', 'connected'].includes(view) || typeof q !== 'string' || !q.isWellFormed() || q.length > 100) throw new ClientJobContractError({ query: 'Invalid history filter.' });
    const cursor = decodeHistoryCursor(after);
    return staff(pool, identity, org, async ({ client }) => {
        const result = (await client.query('select app.telegram_history_status_v2($1,$2,$3::jsonb) as result', [view, q, cursor == null ? null : JSON.stringify(cursor)])).rows[0].result;
        return { ...result, nextCursor: result.nextCursor == null ? null : Buffer.from(JSON.stringify(result.nextCursor)).toString('base64url') };
    }).catch(error => {
        // Website and migrations roll out independently. Only a missing v2
        // entry point permits the existing scoped reader during that interval;
        // permission, cursor and nested-function failures remain failures.
        if (error?.code !== '42883' || !error.message?.startsWith('function app.telegram_history_status_v2(')) throw error;
        return telegramHistoryStatus(pool, identity, org, { view, q, after: cursor?.legacyId ?? cursor?.id ?? null });
    });
}
export function decodeHistoryCursor(value) {
    if (value == null) return null;
    const invalid = () => { throw new ClientJobContractError({ after: 'Invalid history cursor.' }); };
    if (typeof value !== 'string' || value.length > 2048) return invalid();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) return { legacyId: assertUuid(value, 'after') };
    if (!/^[A-Za-z0-9_-]+$/.test(value)) return invalid();
    let parsed;
    try { const bytes = Buffer.from(value, 'base64url'); if (bytes.toString('base64url') !== value) return invalid(); parsed = JSON.parse(bytes.toString('utf8')); } catch { return invalid(); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).sort().join(',') !== 'accountId,id,lastMessageAt,q,v,view' || parsed.v !== 1 || !['all','selected','active','paused','available','connected'].includes(parsed.view) || typeof parsed.q !== 'string' || !parsed.q.isWellFormed() || parsed.q.length > 100 || (parsed.lastMessageAt !== null && (typeof parsed.lastMessageAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(parsed.lastMessageAt) || !Number.isFinite(Date.parse(parsed.lastMessageAt))))) return invalid();
    if (assertUuid(parsed.accountId, 'after') !== parsed.accountId || assertUuid(parsed.id, 'after') !== parsed.id) return invalid();
    if (Buffer.from(JSON.stringify(parsed)).toString('base64url') !== value) return invalid();
    return parsed;
}
export function telegramHistoryAction(pool, identity, org, input) {
    const action = historyStaffAction(input);
    return staff(pool, identity, org, async ({ client }) => {
        const modern = (await client.query("select to_regprocedure('app.telegram_candidate_start_v1(jsonb)') is not null as ready")).rows[0].ready;
        const coordinatedPause = action.action === 'pause' && (await client.query("select to_regprocedure('app.telegram_candidate_pause_v1(jsonb)') is not null as ready")).rows[0].ready;
        const result = (await client.query(coordinatedPause ? 'select app.telegram_candidate_pause_v1($1::jsonb) as result' : action.action === 'start' && modern ? 'select app.telegram_candidate_start_v1($1::jsonb) as result' : 'select app.telegram_history_action_v1($1::jsonb) as result', [JSON.stringify(action)])).rows[0].result;
        if (action.action === 'resume' && modern) await client.query('select app.telegram_extraction_action_v1($1::jsonb)', [JSON.stringify({ action: 'enqueue', chatIds: [action.chatId] })]);
        return result;
    });
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

export function telegramOnboardingComplete(pool, identity, org) {
    return staff(pool, identity, org, async ({ client }) =>
        (await client.query('select app.telegram_onboarding_complete_v1() as complete')).rows[0].complete);
}
