import { normalizeProfessionalUrl } from './application.js';
import { ClientJobContractError } from './client-job-contracts.js';

export const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION_PATTERN = /^[1-9][0-9]{0,18}$/;
const VERSION_MAX = 9223372036854775807n;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const CANDIDATE_AVAILABILITY = Object.freeze(['not_specified', 'open']);
const CANDIDATE_SOURCES = Object.freeze(['manual', 'referral', 'import']);
const EXPERIENCE_KEYS = Object.freeze(['role', 'company', 'period', 'description']);

export const CANDIDATE_FIELD_KEYS = Object.freeze([
    'fullName',
    'headline',
    'location',
    'email',
    'professionalUrl',
    'ownerMembershipId',
    'professionalSummary',
    'availability',
    'tags',
    'skills',
    'experience',
    'source',
]);

function fail(field, message) {
    throw new ClientJobContractError({ [field]: message });
}

function optionalText(input, key, maxLength) {
    const value = input[key];
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') {
        fail(key, `${key} must be text or null.`);
    }
    const trimmed = value.trim();
    if (trimmed === '') return null;
    if (trimmed.length > maxLength) {
        fail(key, `${key} must be ${maxLength} characters or fewer.`);
    }
    return trimmed;
}

function optionalTextKeepWhitespace(input, key, maxLength) {
    const value = input[key];
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') {
        fail(key, `${key} must be text or null.`);
    }
    const trimmed = value.trim();
    if (trimmed === '') return null;
    if (value.length > maxLength) {
        fail(key, `${key} must be ${maxLength} characters or fewer.`);
    }
    return value;
}

function normalizedTagList(input, key) {
    const value = input[key];
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
        fail(key, `${key} must be a list of short labels.`);
    }
    const tags = [];
    const seen = new Set();
    for (const entry of value) {
        if (typeof entry !== 'string') {
            fail(key, `${key} entries must be text.`);
        }
        const trimmed = entry.trim();
        if (trimmed === '') continue;
        if (trimmed.length > 80) {
            fail(key, `${key} entries must be 80 characters or fewer.`);
        }
        const dedupe = trimmed.toLowerCase();
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        tags.push(trimmed);
        if (tags.length > 30) {
            fail(key, `${key} supports at most 30 entries.`);
        }
    }
    return tags;
}

function normalizedExperience(input) {
    const value = input.experience;
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
        fail('experience', 'experience must be a list of roles.');
    }
    if (value.length > 20) {
        fail('experience', 'experience supports at most 20 entries.');
    }
    return value.map((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            fail(`experience.${index}`, 'experience entries must be objects.');
        }
        for (const key of Object.keys(entry)) {
            if (!EXPERIENCE_KEYS.includes(key)) {
                fail(`experience.${index}.${key}`, 'Unknown experience field.');
            }
        }
        const normalized = {};
        for (const key of EXPERIENCE_KEYS) {
            const field = entry[key];
            if (typeof field !== 'string') {
                fail(`experience.${index}.${key}`, `experience ${key} must be text.`);
            }
            if (field.length > 2000) {
                fail(
                    `experience.${index}.${key}`,
                    `experience ${key} must be 2000 characters or fewer.`,
                );
            }
            normalized[key] = field;
        }
        return normalized;
    });
}

export function isUuid(value) {
    return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function assertUuid(value, field) {
    if (!isUuid(value)) {
        fail(field, 'A valid identifier is required.');
    }
    return value.toLowerCase();
}

export function uuidOrNull(value, field) {
    if (value === undefined || value === null || value === '') return null;
    return assertUuid(value, field);
}

export function assertVersion(value, field = 'expectedVersion') {
    if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) {
        fail(field, 'A numeric record version is required.');
    }
    const parsed = BigInt(value);
    if (parsed > VERSION_MAX) {
        fail(field, 'A numeric record version is required.');
    }
    return parsed;
}

export function assertOperationId(value, field = 'operationId') {
    if (!isUuid(value)) {
        fail(field, 'A valid operation identifier is required.');
    }
    return value.toLowerCase();
}

export function validateCandidateFields(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        fail('fields', 'Candidate fields must be an object.');
    }
    for (const key of Object.keys(input)) {
        if (!CANDIDATE_FIELD_KEYS.includes(key)) {
            fail('fields', `Unknown candidate field "${key}".`);
        }
    }

    const fullName = optionalText(input, 'fullName', 120);
    if (!fullName) {
        fail('fullName', 'fullName is required (1–120 characters).');
    }

    const email = optionalText(input, 'email', 254);
    if (email !== null && !EMAIL_PATTERN.test(email)) {
        fail('email', 'Enter a valid email address.');
    }

    let professionalUrl = optionalText(input, 'professionalUrl', 2048);
    if (professionalUrl !== null) {
        const normalized = normalizeProfessionalUrl(professionalUrl);
        if (!normalized.ok) {
            fail('professionalUrl', normalized.message);
        }
        professionalUrl = normalized.value;
        if (professionalUrl.length > 2048) {
            fail('professionalUrl', 'Profile URL is too long.');
        }
    }

    const availability = input.availability ?? 'not_specified';
    if (!CANDIDATE_AVAILABILITY.includes(availability)) {
        fail('availability', 'availability must be not_specified or open.');
    }

    const source = input.source ?? 'manual';
    if (!CANDIDATE_SOURCES.includes(source)) {
        fail('source', 'source must be manual, referral or import.');
    }

    return {
        fullName,
        headline: optionalText(input, 'headline', 200),
        location: optionalText(input, 'location', 200),
        email,
        professionalUrl,
        ownerMembershipId: uuidOrNull(input.ownerMembershipId, 'ownerMembershipId'),
        professionalSummary: optionalTextKeepWhitespace(
            input, 'professionalSummary', 8000),
        availability,
        tags: normalizedTagList(input, 'tags'),
        skills: normalizedTagList(input, 'skills'),
        experience: normalizedExperience(input),
        source,
    };
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const DOCUMENT_KEYS = Object.freeze([
    'sha256',
    'sizeBytes',
    'mimeType',
    'extension',
    'bucket',
    'objectKey',
    'filename',
]);

export function validateCandidateDocumentFields(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        fail('document', 'Document metadata must be an object.');
    }
    for (const key of Object.keys(input)) {
        if (!DOCUMENT_KEYS.includes(key)) {
            fail('document', `Unknown document field "${key}".`);
        }
    }
    const filename = optionalText(input, 'filename', 512);
    if (!filename) fail('filename', 'filename is required.');
    const mimeType = optionalText(input, 'mimeType', 100);
    const extension = optionalText(input, 'extension', 10);
    const pairValid =
        (mimeType === 'application/pdf' && extension === 'pdf')
        || (mimeType === DOCX_MIME && extension === 'docx');
    if (!pairValid) {
        fail('mimeType', 'Only PDF and DOCX documents are supported.');
    }
    const size = input.sizeBytes;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1
        || size > 4194304) {
        fail('sizeBytes', 'sizeBytes must be an integer between 1 and 4194304.');
    }
    const sha256 = optionalText(input, 'sha256', 128);
    if (!sha256 || !/^[0-9a-f]{64}$/i.test(sha256)) {
        fail('sha256', 'sha256 must be a 64-character hex digest.');
    }
    const bucket = optionalText(input, 'bucket', 120);
    if (bucket !== 'cv-submissions') {
        fail('bucket', 'bucket must be cv-submissions.');
    }
    const objectKey = optionalText(input, 'objectKey', 400);
    if (!objectKey) fail('objectKey', 'objectKey is required.');
    return {
        sha256: sha256.toLowerCase(),
        sizeBytes: size,
        mimeType,
        extension,
        bucket,
        objectKey,
        filename,
    };
}

export const IMPORT_RECORD_MAX = 100;
const IMPORT_FIELDS_MAX_BYTES = 64 * 1024;

const IMPORT_RECORD_KEYS = Object.freeze(['fields', 'note', 'operationId', 'jobId']);

function validateImportEnvelope(input, index) {
    const prefix = `records.${index}`;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        fail(`${prefix}`, 'Each import record must be an object.');
    }
    for (const key of Object.keys(input)) {
        if (!IMPORT_RECORD_KEYS.includes(key)) {
            fail(`${prefix}`, `Unknown import record field "${key}".`);
        }
    }
    if (!input.fields || typeof input.fields !== 'object' || Array.isArray(input.fields)) {
        fail(`${prefix}.fields`, 'Each import record needs a fields object.');
    }
    if (JSON.stringify(input.fields).length > IMPORT_FIELDS_MAX_BYTES) {
        fail(`${prefix}.fields`, 'Each import record must be 64 KB or smaller.');
    }
    return {
        note: optionalText(input, 'note', 4000),
        operationId: assertOperationId(input.operationId, `${prefix}.operationId`),
        jobId: uuidOrNull(input.jobId, `${prefix}.jobId`),
    };
}

function assertImportArray(input) {
    if (!Array.isArray(input) || input.length === 0) {
        fail('records', 'At least one import record is required.');
    }
    if (input.length > IMPORT_RECORD_MAX) {
        fail('records', `At most ${IMPORT_RECORD_MAX} records can be imported at once.`);
    }
}

function boundedRawFields(input) {
    const raw = {};
    for (const key of CANDIDATE_FIELD_KEYS) {
        const value = input[key];
        if (value === undefined) continue;
        if (typeof value === 'string') {
            raw[key] = value.slice(0, 8200);
        } else if (Array.isArray(value)) {
            raw[key] = value.slice(0, 40);
        } else if (value === null || typeof value === 'number' || typeof value === 'boolean') {
            raw[key] = value;
        }
    }
    raw.source = 'import';
    return raw;
}

export function validateImportReviewRecords(input) {
    assertImportArray(input);
    return input.map((record, index) => {
        const envelope = validateImportEnvelope(record, index);
        let fields;
        try {
            fields = { ...validateCandidateFields(record.fields), source: 'import' };
        } catch (error) {
            if (!(error instanceof ClientJobContractError)) throw error;
            fields = boundedRawFields(record.fields);
        }
        return { fields, ...envelope };
    });
}

export function validateImportRecords(input) {
    assertImportArray(input);
    return input.map((record, index) => {
        const envelope = validateImportEnvelope(record, index);
        const fields = { ...validateCandidateFields(record.fields), source: 'import' };
        return { fields, ...envelope };
    });
}

export function normalizeCandidateDirectoryFilters(input = {}) {
    const filters = {};
    const query = input.query;
    if (query !== undefined && query !== null && query !== '') {
        if (typeof query !== 'string' || query.length > 200) {
            fail('query', 'query must be text of 200 characters or fewer.');
        }
        filters.query = query;
    }
    if (input.owner !== undefined && input.owner !== null && input.owner !== 'all') {
        if (input.owner !== 'mine') {
            filters.owner = assertUuid(input.owner, 'owner');
        } else {
            filters.owner = 'mine';
        }
    }
    if (input.tag !== undefined && input.tag !== null && input.tag !== 'all') {
        if (typeof input.tag !== 'string' || input.tag.trim() === '' || input.tag.length > 80) {
            fail('tag', 'tag must be 80 characters or fewer.');
        }
        filters.tag = input.tag.trim();
    }
    if (input.tab !== undefined && input.tab !== null && input.tab !== 'all') {
        if (!['mine', 'recent'].includes(input.tab)) {
            fail('tab', 'Unknown candidate tab.');
        }
        filters.tab = input.tab;
    }
    if (input.page !== undefined && input.page !== null) {
        const page = typeof input.page === 'string' ? Number(input.page) : input.page;
        if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) {
            fail('page', 'page must be a positive integer.');
        }
        filters.page = page;
    }
    return filters;
}

export const APPLICATION_DATE_RANGES = Object.freeze(['all', '7d', '30d', 'custom']);

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isStrictDate(value) {
    if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function normalizeApplicationDirectoryFilters(input = {}) {
    const filters = {};
    const query = input.query;
    if (query !== undefined && query !== null && query !== '') {
        if (typeof query !== 'string' || query.length > 200) {
            fail('query', 'query must be text of 200 characters or fewer.');
        }
        filters.query = query;
    }
    for (const [key, name] of [
        ['clientId', 'client'],
        ['jobId', 'job'],
    ]) {
        const value = input[key];
        if (value !== undefined && value !== null && value !== 'all') {
            filters[key] = assertUuid(value, name);
        }
    }
    const stage = input.stage;
    if (stage !== undefined && stage !== null && stage !== 'all') {
        if (typeof stage !== 'string' || stage.length > 100) {
            fail('stage', 'Unknown stage filter.');
        }
        filters.stage = stage;
    }
    if (input.review === true || input.review === '1' || input.review === 'true') {
        filters.review = true;
    }
    const owner = input.owner;
    if (owner !== undefined && owner !== null && owner !== 'all') {
        if (owner !== 'mine') {
            filters.owner = assertUuid(owner, 'owner');
        } else {
            filters.owner = 'mine';
        }
    }
    const dateRange = input.dateRange;
    if (dateRange !== undefined && dateRange !== null && dateRange !== 'all') {
        if (!APPLICATION_DATE_RANGES.includes(dateRange)) {
            fail('dateRange', 'Unknown date range.');
        }
        filters.dateRange = dateRange;
        if (dateRange === 'custom') {
            const from = input.from;
            const to = input.to;
            if (from !== undefined && from !== null && from !== '') {
                if (!isStrictDate(from)) fail('from', 'from must be a real YYYY-MM-DD date.');
                filters.from = from;
            }
            if (to !== undefined && to !== null && to !== '') {
                if (!isStrictDate(to)) fail('to', 'to must be a real YYYY-MM-DD date.');
                filters.to = to;
            }
            if (filters.from && filters.to && filters.from > filters.to) {
                fail('from', 'The from date must be on or before the to date.');
            }
        }
    }
    if (input.page !== undefined && input.page !== null) {
        const page = typeof input.page === 'string' ? Number(input.page) : input.page;
        if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) {
            fail('page', 'page must be a positive integer.');
        }
        filters.page = page;
    }
    return filters;
}

export function optionalNoteText(input, field = 'note') {
    if (input === undefined || input === null || input === '') return null;
    if (typeof input !== 'string') {
        fail(field, 'note must be text.');
    }
    const trimmed = input.trim();
    if (trimmed === '') return null;
    if (trimmed.length > 4000) {
        fail(field, 'note must be 4000 characters or fewer.');
    }
    return trimmed;
}

export function splitImportTags(value) {
    if (typeof value !== 'string') return [];
    const tags = [];
    const seen = new Set();
    for (const part of value.split(/[;|,]/)) {
        const trimmed = part.trim();
        if (trimmed === '') continue;
        const dedupe = trimmed.toLowerCase();
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        tags.push(trimmed);
    }
    return tags;
}

export { ClientJobContractError, normalizeProfessionalUrl };
