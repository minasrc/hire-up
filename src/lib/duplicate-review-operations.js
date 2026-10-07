import { ClientJobContractError } from './client-job-contracts.js';
import { withStaffTransaction } from './staff-authorization.js';
import { assertUuid } from './candidate-profile-contracts.js';

const REVIEW_PERMISSIONS = ['candidates.read', 'duplicates.review'];
const STATUSES = new Set(['pending', 'same_person', 'different_people', 'all']);
const DECISIONS = new Set(['same_person', 'different_people', 'reopen']);

function invalid(field, message) {
    throw new ClientJobContractError({ [field]: message });
}

export async function listCandidateDuplicateReviews(
    pool, identity, organizationId, { status = 'pending', limit = 100 } = {},
) {
    if (!STATUSES.has(status)) invalid('status', 'Choose a valid review status.');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
        invalid('limit', 'Limit must be between 1 and 200.');
    }
    return withStaffTransaction(
        pool, identity, organizationId, REVIEW_PERMISSIONS, async ({ client }) => {
            const { rows } = await client.query(
                'select app.list_candidate_duplicate_reviews_v1($1::text, $2::integer) as result',
                [status, limit]);
            return rows[0].result;
        });
}

export async function getCandidateDuplicateComparison(
    pool, identity, organizationId, { reviewId } = {},
) {
    const normalizedId = assertUuid(reviewId, 'reviewId');
    return withStaffTransaction(
        pool, identity, organizationId, REVIEW_PERMISSIONS, async ({ client }) => {
            const { rows } = await client.query(
                `select app.get_candidate_duplicate_comparison_v1($1::uuid)
                    || pg_catalog.jsonb_build_object('canMerge',
                        app.has_permission_v1('candidates.merge')) as result`,
                [normalizedId]);
            return rows[0].result;
        });
}

export async function mergeCandidateDuplicates(
    pool, identity, organizationId,
    { reviewId, expectedVersion, targetCandidateId, expectedTargetVersion,
        expectedSourceVersion, primaryEmail } = {},
) {
    const normalizedReviewId = assertUuid(reviewId, 'reviewId');
    const normalizedTargetId = assertUuid(targetCandidateId, 'targetCandidateId');
    for (const [field, value] of [
        ['expectedVersion', expectedVersion],
        ['expectedTargetVersion', expectedTargetVersion],
        ['expectedSourceVersion', expectedSourceVersion],
    ]) {
        if (!Number.isSafeInteger(Number(value)) || Number(value) < 1) {
            invalid(field, 'A current version is required. Refresh the comparison.');
        }
    }
    if (primaryEmail !== null && (typeof primaryEmail !== 'string'
        || !primaryEmail.trim() || primaryEmail.length > 254)) {
        invalid('primaryEmail', 'Choose an email from one of the two profiles.');
    }
    return withStaffTransaction(
        pool, identity, organizationId,
        [...REVIEW_PERMISSIONS, 'candidates.merge'], async ({ client }) => {
            const { rows } = await client.query(
                `select app.merge_candidates_v1(
                    $1::uuid, $2::bigint, $3::uuid, $4::bigint, $5::bigint, $6::text
                ) as result`,
                [normalizedReviewId, String(expectedVersion), normalizedTargetId,
                    String(expectedTargetVersion), String(expectedSourceVersion), primaryEmail],
            );
            return rows[0].result;
        },
    );
}

export async function reviewCandidateDuplicate(
    pool, identity, organizationId, { reviewId, expectedVersion, decision } = {},
) {
    const normalizedId = assertUuid(reviewId, 'reviewId');
    if (!Number.isSafeInteger(Number(expectedVersion))
        || Number(expectedVersion) < 1) {
        invalid('expectedVersion', 'A current review version is required.');
    }
    if (!DECISIONS.has(decision)) invalid('decision', 'Choose a valid review decision.');
    return withStaffTransaction(
        pool, identity, organizationId, REVIEW_PERMISSIONS, async ({ client }) => {
            const { rows } = await client.query(
                'select app.review_candidate_duplicate_v1($1::uuid, $2::bigint, $3::text) as result',
                [normalizedId, String(expectedVersion), decision]);
            return rows[0].result;
        });
}
