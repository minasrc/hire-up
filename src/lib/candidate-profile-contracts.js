import { normalizeProfessionalUrl } from './application.js';
import { ClientJobContractError } from './client-job-contracts.js';

export const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION_PATTERN = /^[1-9][0-9]{0,18}$/;
const VERSION_MAX = 9223372036854775807n;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const FIELDS_MAX_BYTES = 48 * 1024;

export const CANDIDATE_PROFILE_FIELD_KEYS = Object.freeze([
    'fullName',
    'email',
    'professionalUrl',
    'headline',
    'location',
    'ownerMembershipId',
    'professionalSummary',
]);

function fail(field, message) {
    throw new ClientJobContractError({ [field]: message });
}

function wellFormed(input, key) {
    if (typeof input === 'string' && !input.isWellFormed()) {
        fail(key, `${key} contains invalid text encoding.`);
    }
    return input;
}

function optionalText(input, key, maxLength) {
    const value = input[key];
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') {
        fail(key, `${key} must be text or null.`);
    }
    wellFormed(value, key);
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
    wellFormed(value, key);
    const trimmed = value.trim();
    if (trimmed === '') return null;
    if (value.length > maxLength) {
        fail(key, `${key} must be ${maxLength} characters or fewer.`);
    }
    return value;
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
    if (BigInt(value) > VERSION_MAX) {
        fail(field, 'A numeric record version is required.');
    }
    return value;
}

export function versionOrNull(value, field = 'expectedVersion') {
    if (value === undefined || value === null) return null;
    return assertVersion(value, field);
}

export function assertOperationId(value, field = 'operationId') {
    if (!isUuid(value)) {
        fail(field, 'A valid operation identifier is required.');
    }
    return value.toLowerCase();
}

export function validateCandidateProfileFields(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        fail('fields', 'Candidate fields must be an object.');
    }
    let encodedLength;
    try {
        encodedLength = new TextEncoder().encode(JSON.stringify(input)).length;
    } catch {
        fail('fields', 'Candidate fields must be an object.');
    }
    if (encodedLength > FIELDS_MAX_BYTES) {
        fail('fields', 'Candidate fields exceed the maximum request size.');
    }
    for (const key of Object.keys(input)) {
        if (!CANDIDATE_PROFILE_FIELD_KEYS.includes(key)) {
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

    const fields = {
        fullName,
        email,
        professionalUrl,
        headline: optionalText(input, 'headline', 200),
        location: optionalText(input, 'location', 200),
        ownerMembershipId: uuidOrNull(input.ownerMembershipId, 'ownerMembershipId'),
        professionalSummary: optionalTextKeepWhitespace(
            input, 'professionalSummary', 8000),
    };
    return fields;
}

export { ClientJobContractError, normalizeProfessionalUrl };
