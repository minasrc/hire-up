import { clientDirectoryQuery, jobDirectoryQuery } from './staff-directory-query.js';
import { randomUUID } from 'node:crypto';
import {
    StaffAuthorizationError,
    withStaffTransaction,
} from './staff-authorization.js';
import {
    ClientJobContractError,
    validateClientDraftInput,
    validateClientInput,
    validateJobDraftInput,
} from './client-job-contracts.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BIGINT_PATTERN = /^[0-9]{1,19}$/;
const HASH_HEX_PATTERN = /^[0-9a-f]{64}$/i;
const BIGINT_MAX = 9223372036854775807n;

const CLIENT_WRITE_PERMISSIONS = ['clients.read', 'clients.write'];
const CLIENT_READ_PERMISSIONS = ['clients.read'];
const JOB_WRITE_PERMISSIONS = ['jobs.read', 'jobs.write', 'clients.read'];
const JOB_READ_PERMISSIONS = ['jobs.read', 'clients.read'];

const invalidInput = (message, fieldErrors = {}) => new ClientJobContractError({
    input: message,
    ...fieldErrors,
});

const requireRecord = (input, name, allowedKeys) => {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        throw invalidInput(`${name} must be a plain object`);
    }
    for (const key of Object.keys(input)) {
        if (!allowedKeys.includes(key)) {
            throw invalidInput(`${name} has an unknown key`, { [key]: 'unknown key' });
        }
    }
    return input;
};

const requireUuid = (value, name) => {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
        throw invalidInput(`${name} must be a UUID`);
    }
    return value;
};

const requireVersion = (value, name, { nullable = false } = {}) => {
    if (value === null || value === undefined) {
        if (nullable) {
            return null;
        }
        throw invalidInput(`${name} must be a positive bigint string`);
    }
    if (typeof value !== 'string' || !BIGINT_PATTERN.test(value)) {
        throw invalidInput(`${name} must be a positive bigint string`);
    }
    const parsed = BigInt(value);
    if (parsed < 1n || parsed > BIGINT_MAX) {
        throw invalidInput(`${name} must be a positive bigint string`);
    }
    return value;
};

const requireOperationId = (value) => requireUuid(value, 'operationId');

const requireReviewHash = (value) => {
    if (typeof value !== 'string' || !HASH_HEX_PATTERN.test(value)) {
        throw invalidInput('reviewHash must be a 64-character hex string');
    }
    return `\\x${value.toLowerCase()}`;
};

const run = (pool, verifiedIdentity, organizationId, permissions, sql, params) =>
    withStaffTransaction(
        pool,
        verifiedIdentity,
        organizationId,
        permissions,
        async ({ client }) => {
            const result = await client.query(sql, params);
            return result.rows[0]?.result ?? null;
        },
    );

export async function saveClientDraft(pool, verifiedIdentity, organizationId, input) {
    const record = requireRecord(
        input, 'input',
        ['clientId', 'expectedVersion', 'fields', 'operationId'],
    );
    const clientId = requireUuid(record.clientId, 'clientId');
    const expectedVersion = requireVersion(
        record.expectedVersion, 'expectedVersion', { nullable: true });
    const operationId = requireOperationId(record.operationId);
    const fields = validateClientDraftInput(record.fields);
    return run(
        pool, verifiedIdentity, organizationId, CLIENT_WRITE_PERMISSIONS,
        'select app.save_client_draft_v1($1::uuid, $2::bigint, $3::jsonb, $4::uuid,'
            + ' $5::uuid) as result',
        [clientId, expectedVersion, JSON.stringify(fields), operationId, randomUUID()],
    );
}

export async function saveClient(pool, verifiedIdentity, organizationId, input) {
    const record = requireRecord(
        input, 'input',
        ['clientId', 'expectedVersion', 'fields', 'operationId'],
    );
    const clientId = requireUuid(record.clientId, 'clientId');
    const expectedVersion = requireVersion(
        record.expectedVersion, 'expectedVersion', { nullable: true });
    const operationId = requireOperationId(record.operationId);
    const fields = validateClientInput(record.fields);
    return run(
        pool, verifiedIdentity, organizationId, CLIENT_WRITE_PERMISSIONS,
        'select app.save_client_v1($1::uuid, $2::bigint, $3::jsonb, $4::uuid, $5::uuid) as result',
        [clientId, expectedVersion, JSON.stringify(fields), operationId, randomUUID()],
    );
}

export async function createJobDraft(pool, verifiedIdentity, organizationId, input) {
    const record = requireRecord(
        input, 'input',
        ['jobId', 'revisionId', 'clientId', 'fields', 'operationId', 'publiclyListed'],
    );
    const jobId = requireUuid(record.jobId, 'jobId');
    const revisionId = requireUuid(record.revisionId, 'revisionId');
    const clientId = requireUuid(record.clientId, 'clientId');
    const operationId = requireOperationId(record.operationId);
    const fields = validateJobDraftInput(record.fields);
    if (record.publiclyListed !== undefined) {
        if (typeof record.publiclyListed !== 'boolean') {
            throw invalidInput('publiclyListed must be a boolean');
        }
        return run(
            pool, verifiedIdentity, organizationId, JOB_WRITE_PERMISSIONS,
            'select app.create_job_draft_v2($1::uuid,$2::uuid,$3::uuid,$4::jsonb,'
                + '$5::boolean,$6::uuid,$7::uuid) as result',
            [
                jobId, revisionId, clientId, JSON.stringify(fields),
                record.publiclyListed, operationId, randomUUID(),
            ],
        );
    }
    return run(
        pool, verifiedIdentity, organizationId, JOB_WRITE_PERMISSIONS,
        'select app.create_job_draft_v1($1::uuid, $2::uuid, $3::uuid, $4::jsonb,'
            + ' $5::uuid, $6::uuid) as result',
        [jobId, revisionId, clientId, JSON.stringify(fields), operationId, randomUUID()],
    );
}

export async function saveJobDraft(pool, verifiedIdentity, organizationId, input) {
    const record = requireRecord(
        input, 'input',
        ['revisionId', 'expectedVersion', 'fields', 'operationId'],
    );
    const revisionId = requireUuid(record.revisionId, 'revisionId');
    const expectedVersion = requireVersion(record.expectedVersion, 'expectedVersion');
    const operationId = requireOperationId(record.operationId);
    const fields = validateJobDraftInput(record.fields);
    return run(
        pool, verifiedIdentity, organizationId, JOB_WRITE_PERMISSIONS,
        'select app.save_job_draft_v1($1::uuid, $2::bigint, $3::jsonb, $4::uuid, $5::uuid) as result',
        [revisionId, expectedVersion, JSON.stringify(fields), operationId, randomUUID()],
    );
}

export async function beginJobRevision(pool, verifiedIdentity, organizationId, input) {
    const record = requireRecord(
        input, 'input',
        ['jobId', 'revisionId', 'expectedJobVersion', 'operationId'],
    );
    const jobId = requireUuid(record.jobId, 'jobId');
    const revisionId = requireUuid(record.revisionId, 'revisionId');
    const expectedJobVersion = requireVersion(
        record.expectedJobVersion, 'expectedJobVersion');
    const operationId = requireOperationId(record.operationId);
    return run(
        pool, verifiedIdentity, organizationId, JOB_WRITE_PERMISSIONS,
        'select app.begin_job_revision_v1($1::uuid, $2::uuid, $3::bigint, $4::uuid, $5::uuid) as result',
        [jobId, revisionId, expectedJobVersion, operationId, randomUUID()],
    );
}

export async function duplicateJob(pool, verifiedIdentity, organizationId, input) {
    const record = requireRecord(
        input, 'input',
        ['sourceRevisionId', 'expectedSourceVersion', 'clientId',
            'jobId', 'revisionId', 'operationId'],
    );
    const sourceRevisionId = requireUuid(record.sourceRevisionId, 'sourceRevisionId');
    const expectedSourceVersion = requireVersion(
        record.expectedSourceVersion, 'expectedSourceVersion');
    const clientId = requireUuid(record.clientId, 'clientId');
    const jobId = requireUuid(record.jobId, 'jobId');
    const revisionId = requireUuid(record.revisionId, 'revisionId');
    const operationId = requireOperationId(record.operationId);
    return run(
        pool, verifiedIdentity, organizationId, JOB_WRITE_PERMISSIONS,
        'select app.duplicate_job_v1($1::uuid, $2::bigint, $3::uuid, $4::uuid, $5::uuid,'
            + ' $6::uuid, $7::uuid) as result',
        [
            sourceRevisionId, expectedSourceVersion, clientId, jobId, revisionId,
            operationId, randomUUID(),
        ],
    );
}

export async function previewJobPublic(pool, verifiedIdentity, organizationId, input) {
    const record = requireRecord(input, 'input', ['revisionId']);
    const revisionId = requireUuid(record.revisionId, 'revisionId');
    return run(
        pool, verifiedIdentity, organizationId, JOB_READ_PERMISSIONS,
        'select app.preview_job_public_v1($1::uuid) as result',
        [revisionId],
    );
}

export async function publishJobRevision(pool, verifiedIdentity, organizationId, input) {
    const record = requireRecord(
        input, 'input',
        ['revisionId', 'expectedVersion', 'expectedClientVersion',
            'reviewHash', 'operationId'],
    );
    const revisionId = requireUuid(record.revisionId, 'revisionId');
    const expectedVersion = requireVersion(record.expectedVersion, 'expectedVersion');
    const expectedClientVersion = requireVersion(
        record.expectedClientVersion, 'expectedClientVersion');
    const reviewHash = requireReviewHash(record.reviewHash);
    const operationId = requireOperationId(record.operationId);
    return run(
        pool, verifiedIdentity, organizationId, JOB_WRITE_PERMISSIONS,
        'select app.publish_job_revision_v1($1::uuid, $2::bigint, $3::bigint, $4::bytea,'
            + ' $5::uuid, $6::uuid) as result',
        [
            revisionId, expectedVersion, expectedClientVersion, reviewHash,
            operationId, randomUUID(),
        ],
    );
}

export async function setJobPublicListing(pool, verifiedIdentity, organizationId, input) {
    const record = requireRecord(
        input, 'input',
        ['jobId', 'listed', 'expectedVersion', 'operationId'],
    );
    const jobId = requireUuid(record.jobId, 'jobId');
    if (typeof record.listed !== 'boolean') {
        throw invalidInput('listed must be a boolean');
    }
    const expectedVersion = requireVersion(record.expectedVersion, 'expectedVersion');
    const operationId = requireOperationId(record.operationId);
    return run(
        pool, verifiedIdentity, organizationId, JOB_WRITE_PERMISSIONS,
        'select app.set_job_public_listing_v1($1::uuid, $2::boolean, $3::bigint,'
            + ' $4::uuid, $5::uuid) as result',
        [jobId, record.listed, expectedVersion, operationId, randomUUID()],
    );
}

const requireLimit = (value) => {
    if (value === null || value === undefined) {
        return null;
    }
    if (!Number.isInteger(value) || value < 1 || value > 500) {
        throw invalidInput('limit must be an integer between 1 and 500');
    }
    return value;
};

export async function listClients(pool, verifiedIdentity, organizationId, input = {}) {
    const record = requireRecord(input, 'input', ['limit']);
    const limit = requireLimit(record.limit);
    return run(
        pool, verifiedIdentity, organizationId, CLIENT_READ_PERMISSIONS,
        'select app.list_clients_v1($1::integer) as result',
        [limit],
    );
}

const PUBLICATION_STATES = new Set(['draft', 'published', 'withdrawn', 'archived']);

export async function listJobs(pool, verifiedIdentity, organizationId, input = {}) {
    const record = requireRecord(
        input, 'input', ['limit', 'publicationState', 'ownerMembershipId']);
    const limit = requireLimit(record.limit);
    const publicationState = record.publicationState ?? null;
    if (publicationState !== null && !PUBLICATION_STATES.has(publicationState)) {
        throw invalidInput('publicationState must be a valid publication state');
    }
    const ownerMembershipId = record.ownerMembershipId ?? null;
    if (ownerMembershipId !== null) {
        requireUuid(ownerMembershipId, 'ownerMembershipId');
    }
    return run(
        pool, verifiedIdentity, organizationId, JOB_READ_PERMISSIONS,
        'select app.list_jobs_v1($1::integer, $2::text, $3::uuid) as result',
        [limit, publicationState, ownerMembershipId],
    );
}

export async function getClient(pool, verifiedIdentity, organizationId, input) {
    const record = requireRecord(input, 'input', ['clientId']);
    const clientId = requireUuid(record.clientId, 'clientId');
    return run(
        pool, verifiedIdentity, organizationId, CLIENT_READ_PERMISSIONS,
        'select app.get_client_v1($1::uuid) as result',
        [clientId],
    );
}

export async function getJobWorkspace(pool, verifiedIdentity, organizationId, input) {
    const record = requireRecord(input, 'input', ['jobId']);
    const jobId = requireUuid(record.jobId, 'jobId');
    return run(
        pool, verifiedIdentity, organizationId, JOB_READ_PERMISSIONS,
        'select app.get_job_workspace_v1($1::uuid) as result',
        [jobId],
    );
}

export async function getJobPublication(pool, verifiedIdentity, organizationId, input) {
    const record = requireRecord(input, 'input', ['jobId']);
    const jobId = requireUuid(record.jobId, 'jobId');
    return run(
        pool, verifiedIdentity, organizationId, JOB_READ_PERMISSIONS,
        'select app.get_job_publication_v1($1::uuid) as result',
        [jobId],
    );
}

export { StaffAuthorizationError };

export async function listClientDirectory(pool, verifiedIdentity, organizationId, input = {}) {
    const filters = clientDirectoryQuery(input);
    return run(
        pool, verifiedIdentity, organizationId, CLIENT_READ_PERMISSIONS,
        'select app.list_client_directory_v1($1::text, $2::text, $3::integer) as result',
        [filters.query, filters.status, filters.page],
    );
}

export async function listJobDirectory(pool, verifiedIdentity, organizationId, input = {}) {
    const filters = jobDirectoryQuery(input);
    return run(
        pool, verifiedIdentity, organizationId, JOB_READ_PERMISSIONS,
        'select app.list_job_directory_v1($1::text, $2::uuid, $3::text, $4::text,'
            + ' $5::boolean, $6::text, $7::text, $8::integer) as result',
        [filters.query, filters.clientId, filters.state, filters.intake,
            filters.mine, filters.sortBy, filters.sortDirection, filters.page],
    );
}
