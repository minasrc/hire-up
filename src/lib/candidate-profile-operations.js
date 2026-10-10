import { randomUUID } from 'node:crypto';
import { candidateDirectoryQuery } from './staff-directory-query.js';

import { withStaffTransaction } from './staff-authorization.js';
import { ClientJobContractError } from './client-job-contracts.js';
import {
    assertUuid,
    assertOperationId,
    validateCandidateProfileFields,
    versionOrNull,
} from './candidate-profile-contracts.js';

const fail = (field, message) => {
    throw new ClientJobContractError({ [field]: message });
};

function requireKeys(input, allowed) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        fail('input', 'A request object is required.');
    }
    for (const key of Object.keys(input)) {
        if (!allowed.includes(key)) {
            fail('input', `Unknown request field "${key}".`);
        }
    }
    return input;
}

const CANDIDATE_READ = ['candidates.read'];
const CANDIDATE_WRITE = ['candidates.read', 'candidates.write'];

const MISSING_PROFILE_FUNCTION =
    /\bapp\.(?:save_candidate_profile_v1|get_candidate_profile_options_v1|get_candidate_profile_v1|list_candidate_profiles_v1)\b/;

export function isMissingProfileFunctionError(error) {
    return error?.code === '42883'
        && typeof error?.message === 'string'
        && MISSING_PROFILE_FUNCTION.test(error.message);
}

export async function saveCandidateProfile(
    pool, identity, organizationId, input,
) {
    return saveProfile(pool, identity, organizationId, input, false);
}

export async function saveCandidateProfileWithSnapshot(
    pool, identity, organizationId, input,
) {
    return saveProfile(pool, identity, organizationId, input, true);
}

async function saveProfile(pool, identity, organizationId, input, includeSnapshot) {
    const keys = requireKeys(
        input, ['candidateId', 'expectedVersion', 'fields', 'operationId']);
    const args = [
        assertUuid(keys.candidateId, 'candidateId'),
        versionOrNull(keys.expectedVersion),
        JSON.stringify(validateCandidateProfileFields(keys.fields)),
        assertOperationId(keys.operationId),
        randomUUID(),
    ];
    return withStaffTransaction(
        pool, identity, organizationId, CANDIDATE_WRITE, async ({ client }) => {
            const { rows } = await client.query(
                `select app.save_candidate_profile_v1(
                    $1::uuid, $2::bigint, $3::jsonb, $4::uuid, $5::uuid) as result`,
                args);
            const result = rows[0].result;
            if (!includeSnapshot) return result;
            const snapshot = await client.query(
                'select app.get_candidate_profile_v1($1::uuid) as result',
                [args[0]]);
            const { candidate, identifiers } = snapshot.rows[0].result;
            return { ...result, profile: { candidate, identifiers } };
        });
}

export async function getCandidateProfileOptions(pool, identity, organizationId) {
    return withStaffTransaction(
        pool, identity, organizationId, CANDIDATE_READ, async ({ client }) => {
            const { rows } = await client.query(
                'select app.get_candidate_profile_options_v1() as result');
            return rows[0].result;
        });
}

export async function getCandidateProfile(pool, identity, organizationId, input) {
    const { candidateId } = requireKeys(input, ['candidateId']);
    const normalizedId = assertUuid(candidateId, 'candidateId');
    return withStaffTransaction(
        pool, identity, organizationId, CANDIDATE_READ, async ({ client }) => {
            const { rows } = await client.query(
                'select app.get_candidate_profile_v1($1::uuid) as result',
                [normalizedId]);
            return rows[0].result;
        });
}

export async function getCandidateDetail(pool, identity, organizationId, input) {
    const { candidateId } = requireKeys(input, ['candidateId']);
    const normalizedId = assertUuid(candidateId, 'candidateId');
    try {
        return await withStaffTransaction(
            pool, identity, organizationId, CANDIDATE_READ, async ({ client }) => {
                const { rows } = await client.query(
                    `select app.get_candidate_profile_v1($1::uuid) as workspace,
                        app.get_candidate_upload_details_v1($1::uuid) as upload_details`,
                    [normalizedId]);
                return {
                    workspace: rows[0].workspace,
                    uploadDetails: rows[0].upload_details,
                };
            });
    } catch (error) {
        if (error?.code !== '42883' || isMissingProfileFunctionError(error)) throw error;
        // The combined read rolls back before retrying. Older deployments can
        // display their profile even when the optional upload function is absent.
        const workspace = await getCandidateProfile(
            pool, identity, organizationId, { candidateId: normalizedId });
        return { workspace, uploadDetails: null };
    }
}

export async function listCandidateProfiles(
    pool, identity, organizationId, input = {},
) {
    const { query = null, limit = 500 } = requireKeys(input, ['query', 'limit']);
    if (query !== null
        && (typeof query !== 'string' || query.length > 200)) {
        fail('query', 'query must be text of at most 200 characters.');
    }
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit)
        || limit < 1 || limit > 1000) {
        fail('limit', 'limit must be an integer between 1 and 1000.');
    }
    return withStaffTransaction(
        pool, identity, organizationId, CANDIDATE_READ, async ({ client }) => {
            const { rows } = await client.query(
                'select app.list_candidate_profiles_v1($1::text, $2::integer) as result',
                [query === '' ? null : query, limit]);
            return rows[0].result;
        });
}

export async function listCandidateProfileDirectory(pool, identity, organizationId, input = {}) {
    const filters = candidateDirectoryQuery(input);
    return withStaffTransaction(
        pool, identity, organizationId, CANDIDATE_READ, async ({ client }) => {
            const { rows } = await client.query(
                'select app.list_candidate_profile_directory_v1($1::text, $2::integer) as result',
                [filters.query, filters.page]);
            return rows[0].result;
        });
}
