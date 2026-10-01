import { withStaffTransaction } from './staff-authorization.js';
import { assertUuid } from './candidate-profile-contracts.js';
import { ClientJobContractError } from './client-job-contracts.js';

const permissions = ['candidates.read', 'candidates.write', 'documents.write'];
const bucket = 'cv-submissions';
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function validKey(key, organizationId) {
    return typeof key === 'string'
        && new RegExp(`^staff/${organizationId}/${uuid}/${uuid}\\.(pdf|docx)$`, 'i').test(key);
}

function transaction(pool, identity, organizationId, sql, parameters = []) {
    return withStaffTransaction(pool, identity, organizationId, permissions, async ({ client }) => {
        const { rows } = await client.query(sql, parameters);
        return rows[0]?.result;
    });
}

// Reserve before writing any private bytes to storage. A lost commit response
// must stop the upload: the durable reservation can later be reclaimed safely.
export function reserveTelegramUpload(pool, identity, organizationId, draftId, expectedVersion, objectKey) {
    assertUuid(organizationId, 'organizationId');
    assertUuid(draftId, 'draftId');
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
        throw new ClientJobContractError({ expectedVersion: 'Refresh the draft before uploading.' });
    }
    if (!validKey(objectKey, organizationId)) {
        throw new ClientJobContractError({ cv: 'Invalid upload destination.' });
    }
    return transaction(pool, identity, organizationId,
        'select app.telegram_reserve_upload_v1($1::uuid,$2::bigint,$3::text) as result',
        [draftId, expectedVersion, objectKey]);
}

// Every list/claim/finish uses a fresh, permission-checked staff transaction.
// Never hold a database transaction open while awaiting the storage provider.
export async function cleanupTelegramUploads(pool, identity, organizationId, storage) {
    assertUuid(organizationId, 'organizationId');
    const pending = await transaction(pool, identity, organizationId,
        'select app.telegram_pending_cleanup_v1() as result');
    const summary = { processed: 0, removed: 0, deferred: 0 };
    if (!Array.isArray(pending)) return summary;
    const seen = new Set();
    for (const key of pending.slice(0, 10)) {
        if (seen.has(key)) continue;
        seen.add(key);
        summary.processed++;
        if (!validKey(key, organizationId)) {
            summary.deferred++;
            continue;
        }
        try {
            const claimed = await transaction(pool, identity, organizationId,
                'select app.telegram_claim_cleanup_v1($1::text) as result', [key]);
            // This transaction has committed before remove. A false or uncertain
            // claim is never permission to delete a possibly referenced object.
            if (claimed !== true) continue;
            const result = await storage.storage.from(bucket).remove([key]);
            if (!result || result.error) {
                summary.deferred++;
                continue;
            }
            const finished = await transaction(pool, identity, organizationId,
                'select app.telegram_finish_cleanup_v1($1::text) as result', [key]);
            if (finished === true) summary.removed++;
            else summary.deferred++;
        } catch {
            // Keep the durable deleting record. Retrying removal is safe even if
            // storage or the final commit succeeded before its response was lost.
            summary.deferred++;
        }
    }
    return summary;
}
