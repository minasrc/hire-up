import { createHash, randomUUID } from 'node:crypto';
import { ClientJobContractError } from './client-job-contracts.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,199}$/;
const REFERENCE_PATTERN = /^AG-[0-9A-F]{12}$/;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const CV_MIME_BY_EXTENSION = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const invalidInput = (message, fieldErrors = {}) => new ClientJobContractError({
    input: message,
    ...fieldErrors,
});

const requireRecord = (value, name, allowedKeys) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw invalidInput(`${name} must be a plain object`);
    }
    for (const key of Object.keys(value)) {
        if (!allowedKeys.includes(key)) {
            throw invalidInput(`${name} has an unknown key: ${key}`);
        }
    }
    return value;
};

// Runs `work` under the app_intake runtime role with only the organization
// context installed — public intake deliberately carries no staff actor, which
// is also what the intake RLS policies key on.
export async function withIntakeTransaction(pool, organizationId, work) {
    const client = await pool.connect();
    try {
        await client.query('begin isolation level read committed');
        await client.query(`set local lock_timeout = '2s'`);
        await client.query(`set local statement_timeout = '10s'`);
        await client.query('set local role app_intake');
        await client.query(
            `select
                pg_catalog.set_config('app.actor_id', '', true),
                pg_catalog.set_config('app.organization_id', $1, true)`,
            [organizationId],
        );
        const result = await work(client);
        await client.query('commit');
        return result;
    } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

export async function listPublicJobs(pool, organizationId) {
    if (typeof organizationId !== 'string' || !UUID_PATTERN.test(organizationId)) {
        throw invalidInput('organizationId must be a UUID');
    }
    return withIntakeTransaction(pool, organizationId, async (client) => {
        const result = await client.query('select app.list_public_jobs_v1() as result');
        return result.rows[0]?.result;
    });
}

// `document` may be null only when the CV upload itself failed after the file
// was validated — the application still lands, just without a registered CV.
export async function submitPublicApplication(pool, organizationId, input) {
    const record = requireRecord(
        input, 'input',
        [
            'jobSlug', 'reference', 'fullName', 'email', 'professionalUrl',
            'achievement', 'document', 'submissionId',
        ],
    );
    const jobSlug = typeof record.jobSlug === 'string' ? record.jobSlug.trim() : '';
    if (!SLUG_PATTERN.test(jobSlug)) {
        throw invalidInput('jobSlug is invalid', { jobSlug: 'invalid' });
    }
    const reference = typeof record.reference === 'string' ? record.reference : '';
    if (!REFERENCE_PATTERN.test(reference)) {
        throw invalidInput('reference must match the AG-XXXXXXXXXXXX format');
    }
    if (record.submissionId !== undefined
        && (typeof record.submissionId !== 'string'
            || !UUID_PATTERN.test(record.submissionId))) {
        throw invalidInput('submissionId must be a UUID');
    }
    const referenceHash = createHash('sha256').update(reference).digest('hex');
    const fallbackSubmissionId = [
        referenceHash.slice(0, 8), referenceHash.slice(8, 12),
        referenceHash.slice(12, 16), referenceHash.slice(16, 20),
        referenceHash.slice(20, 32),
    ].join('-');
    const submissionId = record.submissionId ?? fallbackSubmissionId;
    const fullName = typeof record.fullName === 'string' ? record.fullName.trim() : '';
    if (!fullName || fullName.length > 120) {
        throw invalidInput('fullName is required', { fullName: 'required' });
    }
    const email = typeof record.email === 'string' ? record.email.trim() : '';
    if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
        throw invalidInput('email must be a valid email address', { email: 'invalid' });
    }
    const professionalUrl = typeof record.professionalUrl === 'string'
        && record.professionalUrl.trim() ? record.professionalUrl.trim() : null;
    if (professionalUrl && professionalUrl.length > 2048) {
        throw invalidInput('professionalUrl is too long');
    }
    const achievement = typeof record.achievement === 'string'
        && record.achievement.trim() ? record.achievement.trim() : null;
    if (achievement && achievement.length > 2000) {
        throw invalidInput('achievement is too long');
    }
    let blobId = null;
    let locationId = null;
    let documentId = null;
    let blob = null;
    if (record.document !== null && record.document !== undefined) {
        const document = requireRecord(
            record.document, 'document',
            ['sha256', 'sizeBytes', 'mimeType', 'extension', 'bucket', 'objectKey', 'filename'],
        );
        if (typeof document.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(document.sha256)) {
            throw invalidInput('document.sha256 must be 64 hex characters');
        }
        const sizeBytes = Number(document.sizeBytes);
        if (!Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > 4194304) {
            throw invalidInput('document.sizeBytes must be between 1 and 4 MiB');
        }
        if (CV_MIME_BY_EXTENSION[document.extension] !== document.mimeType) {
            throw invalidInput('document mime/extension combination is invalid');
        }
        for (const key of ['bucket', 'objectKey', 'filename']) {
            if (typeof document[key] !== 'string' || !document[key].trim()) {
                throw invalidInput(`document.${key} is required`);
            }
        }
        blobId = randomUUID();
        locationId = randomUUID();
        documentId = randomUUID();
        blob = {
            sha256: `\\x${document.sha256.toLowerCase()}`,
            sizeBytes,
            mimeType: document.mimeType,
            extension: document.extension,
            bucket: document.bucket.trim(),
            objectKey: document.objectKey.trim(),
            filename: document.filename.trim(),
        };
    }
    return withIntakeTransaction(pool, organizationId, async (client) => {
        const result = await client.query(
            `select app.submit_public_application_v1(
                $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
                $7::uuid, $8::uuid, $9::uuid, $10::uuid, $11::uuid,
                $12::text, $13::text, $14::text, $15::text, $16::text, $17::text,
                $18::bytea, $19::bigint, $20::text, $21::text, $22::text,
                $23::text, $24::text
            ) as result`,
            [
                randomUUID(), randomUUID(), randomUUID(), randomUUID(),
                randomUUID(), randomUUID(), randomUUID(), submissionId,
                blobId, locationId, documentId,
                jobSlug, reference, fullName, email, professionalUrl,
                achievement,
                blob?.sha256 ?? null, blob?.sizeBytes ?? null,
                blob?.mimeType ?? null, blob?.extension ?? null,
                blob?.bucket ?? null, blob?.objectKey ?? null,
                blob?.filename ?? null,
            ],
        );
        return result.rows[0]?.result;
    });
}
