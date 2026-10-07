import { randomUUID } from 'node:crypto';

import { withStaffActor, withStaffTransaction } from './staff-authorization.js';
import { ClientJobContractError } from './client-job-contracts.js';
import {
    assertUuid,
    assertVersion,
    assertOperationId,
    validateCandidateFields,
    validateCandidateDocumentFields,
    optionalNoteText,
    normalizeCandidateDirectoryFilters,
    normalizeApplicationDirectoryFilters,
} from './recruitment-contracts.js';

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
const APPLICATION_LINK = [
    'applications.read', 'applications.stage', 'candidates.read',
    'candidates.write', 'clients.read', 'jobs.read',
];
const APPLICATION_READ = [
    'applications.read', 'candidates.read', 'clients.read', 'jobs.read',
];
const JOB_READ = ['clients.read', 'jobs.read'];
const JOB_WRITE = ['clients.read', 'jobs.read', 'jobs.write'];
const CLIENT_READ = ['clients.read'];
const DOCUMENT_WRITE = [...CANDIDATE_WRITE, 'documents.write'];
const PRIVACY_READ = ['privacy.manage'];

export async function getRecruitmentContext(pool, identity, organizationId) {
    return withStaffActor(pool, identity, organizationId, async ({ client }) => {
        const { rows } = await client.query(
            'select app.get_recruitment_context_v1() as result');
        return rows[0].result;
    });
}

export async function staffHasPermission(pool, identity, organizationId, permission) {
    return withStaffActor(pool, identity, organizationId, async ({ client }) => {
        const { rows } = await client.query(
            'select app.has_permission_v1($1) as allowed', [permission]);
        return rows[0]?.allowed === true;
    });
}

export async function listCandidateDirectory(pool, identity, organizationId, input = {}) {
    const filters = normalizeCandidateDirectoryFilters(input);
    return withStaffTransaction(
        pool, identity, organizationId, CANDIDATE_READ, async ({ client }) => {
            const { rows } = await client.query(
                'select app.list_candidate_directory_v1($1::jsonb) as result',
                [JSON.stringify(filters)]);
            return rows[0].result;
        });
}

export async function getCandidateWorkspace(pool, identity, organizationId, candidateId) {
    return withStaffTransaction(
        pool, identity, organizationId, CANDIDATE_READ, async ({ client }) => {
            const { rows } = await client.query(
                'select app.get_candidate_workspace_v2($1::uuid) as result',
                [assertUuid(candidateId, 'candidateId')]);
            return rows[0].result;
        });
}

export async function createStaffCandidate(
    pool, identity, organizationId, input,
) {
    const {
        candidateId, fields, document = null, jobId = null, note = null, operationId,
    } = requireKeys(input, [
        'candidateId', 'fields', 'document', 'jobId', 'note', 'operationId',
    ]);
    const normalizedFields = validateCandidateFields(fields);
    const normalizedDocument = document === null
        ? null
        : validateCandidateDocumentFields(document);
    const normalizedNote = optionalNoteText(note);
    const required = [...CANDIDATE_WRITE];
    if (normalizedDocument) required.push('documents.write');
    if (jobId) required.push('applications.read', 'applications.stage', 'jobs.read', 'clients.read');
    if (normalizedNote) required.push('collaboration.write');
    return withStaffTransaction(
        pool, identity, organizationId, required, async ({ client }) => {
            const { rows } = await client.query(
                `select app.create_staff_candidate_v1(
                    $1::uuid, $2::jsonb, $3::jsonb, $4::uuid, $5::text, $6::uuid, $7::uuid) as result`,
                [
                    assertUuid(candidateId, 'candidateId'),
                    JSON.stringify(normalizedFields),
                    normalizedDocument ? JSON.stringify(normalizedDocument) : null,
                    jobId ? assertUuid(jobId, 'jobId') : null,
                    normalizedNote,
                    assertOperationId(operationId),
                    randomUUID(),
                ]);
            return rows[0].result;
        });
}

export async function saveCandidateProfile(
    pool, identity, organizationId, input,
) {
    const { candidateId, expectedVersion, fields, operationId } = requireKeys(
        input, ['candidateId', 'expectedVersion', 'fields', 'operationId']);
    const normalizedFields = validateCandidateFields(fields);
    return withStaffTransaction(
        pool, identity, organizationId, CANDIDATE_WRITE, async ({ client }) => {
            const { rows } = await client.query(
                `select app.save_candidate_profile_v1(
                    $1::uuid, $2::bigint, $3::jsonb, $4::uuid, $5::uuid) as result`,
                [
                    assertUuid(candidateId, 'candidateId'),
                    assertVersion(expectedVersion).toString(),
                    JSON.stringify(normalizedFields),
                    assertOperationId(operationId),
                    randomUUID(),
                ]);
            return rows[0].result;
        });
}

export async function tagCandidates(
    pool, identity, organizationId, input,
) {
    const { candidates, tag, operationId } = requireKeys(
        input, ['candidates', 'tag', 'operationId']);
    if (!Array.isArray(candidates) || candidates.length === 0) {
        fail('candidates', 'At least one candidate is required.');
    }
    if (candidates.length > 100) {
        fail('candidates', 'At most 100 candidates can be tagged at once.');
    }
    const unique = new Map();
    for (const entry of candidates ?? []) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            fail('candidates', 'Each candidate selection must be an object.');
        }
        for (const key of Object.keys(entry)) {
            if (!['candidateId', 'expectedVersion'].includes(key)) {
                fail('candidates', `Unknown candidate selection field "${key}".`);
            }
        }
        const candidateId = assertUuid(entry.candidateId, 'candidateId');
        if (unique.has(candidateId)) {
            fail('candidates', 'Each candidate can only be selected once.');
        }
        unique.set(candidateId, {
            candidateId,
            expectedVersion: assertVersion(entry.expectedVersion).toString(),
        });
    }
    const normalizedTag = typeof tag === 'string' ? tag.trim() : '';
    if (normalizedTag === '' || normalizedTag.length > 80) {
        fail('tag', 'tag must be 1–80 characters.');
    }
    return withStaffTransaction(
        pool, identity, organizationId, CANDIDATE_WRITE, async ({ client }) => {
            const { rows } = await client.query(
                'select app.tag_candidates_v1($1::jsonb, $2::text, $3::uuid, $4::uuid) as result',
                [
                    JSON.stringify([...unique.values()]),
                    normalizedTag,
                    assertOperationId(operationId),
                    randomUUID(),
                ]);
            return rows[0].result;
        });
}

export async function addCandidateToJob(
    pool, identity, organizationId, input,
) {
    const { candidateId, jobId, operationId } = requireKeys(
        input, ['candidateId', 'jobId', 'operationId']);
    return withStaffTransaction(
        pool, identity, organizationId, APPLICATION_LINK, async ({ client }) => {
            const { rows } = await client.query(
                `select app.add_candidate_to_job_v1(
                    $1::uuid, $2::uuid, $3::uuid, $4::uuid) as result`,
                [
                    assertUuid(candidateId, 'candidateId'),
                    assertUuid(jobId, 'jobId'),
                    assertOperationId(operationId),
                    randomUUID(),
                ]);
            return rows[0].result;
        });
}

export async function addCandidateDocument(
    pool, identity, organizationId, input,
) {
    const { candidateId, expectedVersion, document, operationId } = requireKeys(
        input, ['candidateId', 'expectedVersion', 'document', 'operationId']);
    const normalizedDocument = validateCandidateDocumentFields(document);
    return withStaffTransaction(
        pool, identity, organizationId, DOCUMENT_WRITE, async ({ client }) => {
            const { rows } = await client.query(
                `select app.add_candidate_document_v1(
                    $1::uuid, $2::bigint, $3::jsonb, $4::uuid, $5::uuid) as result`,
                [
                    assertUuid(candidateId, 'candidateId'),
                    assertVersion(expectedVersion).toString(),
                    JSON.stringify(normalizedDocument),
                    assertOperationId(operationId),
                    randomUUID(),
                ]);
            return rows[0].result;
        });
}

export async function staffUploadReferenced(pool, identity, organizationId, objectKey) {
    if (typeof objectKey !== 'string' || objectKey.trim() === '' || objectKey.length > 400) {
        return null;
    }
    return withStaffTransaction(
        pool, identity, organizationId, ['candidates.read', 'documents.write'],
        async ({ client }) => {
            const { rows } = await client.query(
                'select app.staff_upload_referenced_v1($1::text) as result',
                [objectKey]);
            const referenced = rows[0]?.result;
            return referenced === true ? true : referenced === false ? false : null;
        });
}

export async function listWorkspaceJobs(pool, identity, organizationId, input = {}) {
    const { limit, clientId } = requireKeys(input, ['limit', 'clientId']);
    const bounded = limit === undefined || limit === null ? 500 : Number(limit);
    if (!Number.isSafeInteger(bounded) || bounded < 1 || bounded > 500) {
        fail('limit', 'limit must be an integer between 1 and 500.');
    }
    return withStaffTransaction(
        pool, identity, organizationId, JOB_READ, async ({ client }) => {
            const { rows } = await client.query(
                'select app.list_workspace_jobs_v1($1::integer, $2::uuid) as result',
                [
                    bounded,
                    clientId ? assertUuid(clientId, 'clientId') : null,
                ]);
            return rows[0].result;
        });
}

export async function getJobWorkspace(pool, identity, organizationId, jobId) {
    return withStaffTransaction(
        pool, identity, organizationId, JOB_READ, async ({ client }) => {
            const { rows } = await client.query(
                'select app.get_job_workspace_v2($1::uuid) as result',
                [assertUuid(jobId, 'jobId')]);
            return rows[0].result;
        });
}

export async function listApplicationDirectory(pool, identity, organizationId, input = {}) {
    const filters = normalizeApplicationDirectoryFilters(input);
    return withStaffTransaction(
        pool, identity, organizationId, APPLICATION_READ, async ({ client }) => {
            const { rows } = await client.query(
                'select app.list_application_directory_v1($1::jsonb) as result',
                [JSON.stringify(filters)]);
            return rows[0].result;
        });
}

export async function getClientWorkspace(pool, identity, organizationId, clientId) {
    return withStaffTransaction(
        pool, identity, organizationId, CLIENT_READ, async ({ client }) => {
            const { rows } = await client.query(
                'select app.get_client_workspace_v1($1::uuid) as result',
                [assertUuid(clientId, 'clientId')]);
            return rows[0].result;
        });
}

export async function listPrivacyCases(pool, identity, organizationId) {
    return withStaffTransaction(
        pool, identity, organizationId, PRIVACY_READ, async ({ client }) => {
            const { rows } = await client.query(
                'select app.list_privacy_cases_v1() as result');
            return rows[0].result;
        });
}

export async function reviewCandidateImport(pool, identity, organizationId, records) {
    return withStaffTransaction(
        pool, identity, organizationId, CANDIDATE_WRITE, async ({ client }) => {
            const { rows } = await client.query(
                'select app.review_candidate_import_v1($1::jsonb) as result',
                [JSON.stringify(records)]);
            return rows[0].result;
        });
}

export async function duplicateJob(
    pool, identity, organizationId, input,
) {
    const {
        sourceRevisionId, expectedSourceVersion, clientId, jobId, revisionId, operationId,
    } = requireKeys(input, [
        'sourceRevisionId', 'expectedSourceVersion', 'clientId',
        'jobId', 'revisionId', 'operationId',
    ]);
    return withStaffTransaction(
        pool, identity, organizationId, JOB_WRITE, async ({ client }) => {
            const { rows } = await client.query(
                `select app.duplicate_job_v2(
                    $1::uuid, $2::bigint, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid) as result`,
                [
                    assertUuid(sourceRevisionId, 'sourceRevisionId'),
                    assertVersion(expectedSourceVersion).toString(),
                    assertUuid(clientId, 'clientId'),
                    assertUuid(jobId, 'jobId'),
                    assertUuid(revisionId, 'revisionId'),
                    assertOperationId(operationId),
                    randomUUID(),
                ]);
            return rows[0].result;
        });
}

export async function commitCandidateImport(
    pool, identity, organizationId, input,
) {
    const { records, jobId = null } = requireKeys(input, ['records', 'jobId']);
    const required = [...CANDIDATE_WRITE];
    if (records.some((record) => record.note)) required.push('collaboration.write');
    const sharedJobId = jobId ?? null;
    if (sharedJobId || records.some((record) => record.jobId)) {
        required.push('applications.read', 'applications.stage', 'jobs.read', 'clients.read');
    }
    return withStaffTransaction(
        pool, identity, organizationId, required, async ({ client }) => {
            const results = [];
            for (const record of records) {
                const { rows } = await client.query(
                    `select app.create_staff_candidate_v1(
                        $1::uuid, $2::jsonb, $3::jsonb, $4::uuid, $5::text, $6::uuid, $7::uuid) as result`,
                    [
                        randomUUID(),
                        JSON.stringify(record.fields),
                        null,
                        record.jobId ?? sharedJobId,
                        record.note,
                        record.operationId,
                        randomUUID(),
                    ]);
                results.push(rows[0].result);
            }
            return { results };
        });
}
