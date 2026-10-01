import { withStaffTransaction } from './staff-authorization.js';
import { assertUuid } from './candidate-profile-contracts.js';
import { ClientJobContractError } from './client-job-contracts.js';
import { normalizeTelegramDraftFields } from './telegram-intake-contracts.js';
import { extractionStaffAction, extractionWorkerInput, validateExtractionResult } from './telegram-extraction-contracts.js';
const staff = (pool, identity, org, fn) => withStaffTransaction(pool, identity, org, ['candidates.read', 'candidates.write'], fn);
const result = async (client, sql, args) => (await client.query(sql, args)).rows[0].result;
export function telegramExtractionStatus(pool, identity, org, filters = {}) {
    const { draftId = null, jobId = null, view = 'all', after = null } = filters;
    if (draftId && jobId) throw new ClientJobContractError({ query: 'Choose a draft or a batch.' });
    if (jobId) return staff(pool, identity, org, ({ client }) => result(client, 'select app.telegram_extraction_batch_v1($1) as result', [assertUuid(jobId, 'jobId')]));
    if (!['all', 'needs_review'].includes(view)) throw new ClientJobContractError({ view: 'Choose a supported view.' });
    return staff(pool, identity, org, ({ client }) => result(client, 'select app.telegram_extraction_status_v1($1,$2,$3) as result', [draftId == null ? null : assertUuid(draftId, 'draftId'), view, after == null ? null : assertUuid(after, 'after')]));
}
export function telegramExtractionAction(pool, identity, org, input) {
    const action = extractionStaffAction(input);
    return staff(pool, identity, org, async ({ client }) => {
        if (action.action === 'resolve' && action.decision === 'apply') {
            // Read only through the private status seam; SQL repeats the version
            // check under the draft lock before it changes any fields.
            const proposal = await result(client, 'select app.telegram_extraction_proposal_v1($1) as result', [action.proposalId]);
            normalizeTelegramDraftFields({ ...proposal.fields, [proposal.field]: proposal.value });
        }
        return result(client, 'select app.telegram_extraction_action_v1($1::jsonb) as result', [JSON.stringify(action)]);
    });
}
export async function telegramExtractionWorkerOperation(pool, token, action, input) {
    if (!/^[A-Za-z0-9_-]{64}$/.test(token ?? '')) { const error = new Error('Unauthorized'); error.code = '42501'; throw error; }
    const parsed = extractionWorkerInput(action, input);
    const client = await pool.connect();
    try {
        await client.query("begin isolation level read committed; set local role app_telegram_worker; set local statement_timeout='10s'; set local lock_timeout='2s'");
        let output;
        if (action === 'claim') output = await result(client, 'select app.telegram_extraction_claim_v1($1) as result', [token]);
        else if (action === 'fail') output = await result(client, 'select app.telegram_extraction_fail_v1($1,$2,$3,$4,$5) as result', [token, parsed.jobId, parsed.leaseToken, parsed.code, parsed.retryAfterSeconds]);
        else {
            const hasReceiptProbe = await result(client, "select to_regprocedure('app.telegram_extraction_receipt_v1(text,uuid,text,jsonb,jsonb)') is not null as result", []);
            const receipt = hasReceiptProbe ? await result(client, 'select app.telegram_extraction_receipt_v1($1,$2,$3,$4::jsonb,$5::jsonb) as result', [token, parsed.jobId, parsed.sourceDigest, JSON.stringify(parsed.result), JSON.stringify(parsed.metadata)]) : null;
            if (receipt) { await client.query('commit'); return receipt; }
            const source = await result(client, 'select app.telegram_extraction_source_v1($1,$2) as result', [token, parsed.jobId]);
            const validated = validateExtractionResult(parsed.result, source);
            output = await result(client, 'select app.telegram_extraction_complete_v1($1,$2,$3,$4,$5::jsonb,$6::jsonb) as result', [token, parsed.jobId, parsed.leaseToken, parsed.sourceDigest, JSON.stringify(validated), JSON.stringify(parsed.metadata)]);
        }
        await client.query('commit'); return output;
    } catch (error) { await client.query('rollback').catch(() => {}); throw error; }
    finally { client.release(); }
}
