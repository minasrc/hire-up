import { randomUUID } from 'node:crypto';
import { withStaffTransaction } from './staff-authorization.js';
import { assertOperationId, assertUuid } from './candidate-profile-contracts.js';
import { validateCandidateUploadFields } from './candidate-upload-contracts.js';

export const CANDIDATE_UPLOAD_PERMISSIONS = ['candidates.read', 'candidates.write', 'documents.write'];
export async function authorizeCandidateUpload(context) {
    return withStaffTransaction(context.pool, context.identity, context.organizationId,
        CANDIDATE_UPLOAD_PERMISSIONS, async () => true);
}
export async function saveCandidateUpload(pool, identity, organizationId, input) {
    const args = [assertUuid(input.candidateId, 'candidateId'), JSON.stringify(validateCandidateUploadFields(input.fields)),
        JSON.stringify(input.document), assertOperationId(input.operationId), randomUUID()];
    return withStaffTransaction(pool, identity, organizationId, CANDIDATE_UPLOAD_PERMISSIONS, async ({ client }) => {
        const { rows } = await client.query('select app.create_candidate_upload_v1($1::uuid, $2::jsonb, $3::jsonb, $4::uuid, $5::uuid) as result', args);
        return rows[0].result;
    });
}
export async function candidateUploadReferenced(context, objectKey) {
    return withStaffTransaction(context.pool, context.identity, context.organizationId,
        CANDIDATE_UPLOAD_PERMISSIONS, async ({ client }) => {
            const { rows } = await client.query('select app.candidate_upload_referenced_v1($1::text) as referenced', [objectKey]);
            return rows[0].referenced;
        });
}

export async function getCandidateUploadDetails(pool, identity, organizationId, { candidateId }) {
    return withStaffTransaction(pool, identity, organizationId, ['candidates.read'], async ({ client }) => {
        const { rows } = await client.query('select app.get_candidate_upload_details_v1($1::uuid) as result', [assertUuid(candidateId, 'candidateId')]);
        return rows[0].result;
    });
}
