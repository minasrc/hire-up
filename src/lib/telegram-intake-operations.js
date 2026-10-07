import { randomBytes, randomUUID } from 'node:crypto';
import { withStaffTransaction } from './staff-authorization.js';
import { assertUuid } from './candidate-profile-contracts.js';
import { ClientJobContractError } from './client-job-contracts.js';
import { normalizeTelegramDraftFields, assessTelegramDraft, draftEmbeddingText } from './telegram-intake-contracts.js';

export const TELEGRAM_INDEX_VERSION = 'intfloat/multilingual-e5-small@614241f622f53c4eeff9890bdc4f31cfecc418b3:e5-prefix:l2:384:v1';
const permissions = ['candidates.read', 'candidates.write'];
const invalid = (key, message) => { throw new ClientJobContractError({ [key]: message }); };
const version = (value) => {
    if (!Number.isSafeInteger(value) || value < 1) invalid('expectedVersion', 'Refresh the draft before saving.');
    return value;
};
const transact = (pool, identity, org, operation, required = permissions) => withStaffTransaction(pool, identity, org, required, operation);
const result = async (client, sql, args) => (await client.query(sql, args)).rows[0].result;
const read = (client, id) => result(client, 'select app.telegram_get_draft_v1($1::uuid) as result', [assertUuid(id, 'draftId')]);

export function listTelegramDrafts(pool, identity, org, filters = {}) {
    const { view = 'ready', missing = null, q = '', page = 1 } = filters;
    if (!['ready', 'needs_information', 'snoozed', 'duplicates', 'all'].includes(view)) invalid('view', 'Choose a supported view.');
    if (missing != null && !['firstName', 'lastName', 'primaryEmail', 'cv'].includes(missing)) invalid('missing', 'Choose a required field.');
    if (typeof q !== 'string' || q.length > 200 || !Number.isInteger(page) || page < 1 || page > 10000) invalid('query', 'Invalid inbox query.');
    return transact(pool, identity, org, ({ client }) => result(client, 'select app.telegram_list_drafts_v1($1,$2,$3,$4) as result', [view, missing, q, page]));
}
export function getTelegramDraft(pool, identity, org, draftId) {
    return transact(pool, identity, org, ({ client }) => read(client, draftId));
}
export function createTelegramDraft(pool, identity, org, input) {
    const fields = normalizeTelegramDraftFields(input.fields);
    const title = input.sourceTitle ?? 'Manual draft';
    if (typeof title !== 'string' || !title.trim() || title.length > 200) invalid('sourceTitle', 'Enter a source title of 1–200 characters.');
    return transact(pool, identity, org, ({ client }) => result(client, 'select app.telegram_create_draft_v1($1,$2::jsonb,$3) as result', [randomUUID(), JSON.stringify(fields), title.trim()]));
}
export function updateTelegramDraft(pool, identity, org, draftId, input) {
    const patch = normalizeTelegramDraftFields(input.fields, { partial: true });
    return transact(pool, identity, org, async ({ client }) => {
        const current = await read(client, draftId);
        const fields = normalizeTelegramDraftFields({ ...current.fields, ...patch });
        return result(client, 'select app.telegram_update_draft_v1($1,$2,$3::jsonb) as result', [draftId, version(input.expectedVersion), JSON.stringify(fields)]);
    });
}
export function decideTelegramDraft(pool, identity, org, draftId, input) {
    if (!['approve', 'discard', 'snooze', 'reopen'].includes(input.action)) invalid('action', 'Choose a supported action.');
    const expected = version(input.expectedVersion);
    const operation = assertUuid(input.operationId, 'operationId');
    return transact(pool, identity, org, async ({ client }) => {
        const current = await read(client, draftId);
        if (input.action === 'approve' && current.status !== 'approved') {
            const assessment = assessTelegramDraft(current.fields, current.cv);
            if (current.pendingProposalCount > 0) {
                assessment.ready = false;
                assessment.fieldErrors.proposals = 'Apply or dismiss the pending extraction suggestions before approval.';
            }
            if (!assessment.ready) {
                const error = new ClientJobContractError(assessment.fieldErrors);
                error.code = 'DRAFT_INCOMPLETE';
                throw error;
            }
        }
        return result(client, 'select app.telegram_decide_draft_v1($1,$2,$3,$4) as result', [draftId, expected, input.action, operation]);
    }, input.action === 'approve' ? [...permissions, 'documents.write'] : permissions);
}
export function telegramCvTarget(pool, identity, org, draftId) {
    return transact(pool, identity, org, ({ client }) => result(client, 'select app.telegram_cv_target_v1($1) as result', [assertUuid(draftId, 'draftId')]), [...permissions, 'documents.write']);
}
export function telegramCvDocument(pool, identity, org, draftId) {
    return transact(pool, identity, org, ({ client }) => result(client, 'select app.telegram_cv_document_v1($1) as result', [assertUuid(draftId, 'draftId')]), [...permissions, 'documents.download']);
}
export function attachTelegramCv(pool, identity, org, draftId, expectedVersion, document) {
    return transact(pool, identity, org, ({ client }) => result(client, 'select app.telegram_attach_cv_v1($1,$2,$3::jsonb) as result', [assertUuid(draftId, 'draftId'), version(expectedVersion), JSON.stringify(document)]), [...permissions, 'documents.write']);
}
export function registerTelegramWorker(pool, identity, org, name = 'Mac embedding worker') {
    if (typeof name !== 'string' || !name.trim() || name.length > 80) invalid('name', 'Enter a worker name of 1–80 characters.');
    const token = randomBytes(48).toString('base64url');
    return transact(pool, identity, org, async ({ client }) => ({
        ...await result(client, 'select app.telegram_register_worker_v1($1,$2) as result', [name, token]), token,
    }));
}
export function revokeTelegramWorker(pool, identity, org, id) {
    return transact(pool, identity, org, ({ client }) => result(client, 'select app.telegram_revoke_worker_v1($1) as result', [assertUuid(id, 'workerId')]));
}
export function enqueueTelegramEmbedding(pool, identity, org, draftId) {
    return transact(pool, identity, org, async ({ client }) => {
        const draft = await read(client, draftId);
        const text = draftEmbeddingText(draft.fields);
        if (!text) invalid('fields', 'Add profile information before indexing.');
        return result(client, 'select app.telegram_enqueue_embedding_v1($1,$2,$3,$4) as result', [draftId, draft.version, text, TELEGRAM_INDEX_VERSION]);
    });
}
