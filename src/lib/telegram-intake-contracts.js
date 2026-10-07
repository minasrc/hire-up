import { ClientJobContractError, normalizeProfessionalUrl, uuidOrNull } from './candidate-profile-contracts.js';
import { assertCandidateCvFilename, validateCandidateUploadFields } from './candidate-upload-contracts.js';

const CANDIDATE_KEYS = [
    'firstName', 'lastName', 'primaryEmail', 'secondaryEmails', 'headline', 'location',
    'professionalUrl', 'ownerMembershipId', 'professionalSummary', 'compensationPreference',
];
const DRAFT_KEYS = [...CANDIDATE_KEYS, 'telegramUsername', 'telegramUserId'];
const REQUIRED_KEYS = ['firstName', 'lastName', 'primaryEmail'];
const CONTROL_PATTERN = /[\x00-\x1f\x7f]/;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const fail = (key, message) => { throw new ClientJobContractError({ [key]: message }); };
const isEmpty = (value) => value == null || (typeof value === 'string' && value.trim() === '');

function normalizeEmail(value, key) {
    if (typeof value !== 'string' || !value.isWellFormed() || value.trim().length > 254
        || !EMAIL_PATTERN.test(value.trim()) || CONTROL_PATTERN.test(value)) {
        fail(key, 'Enter a valid email address.');
    }
    return value.trim().toLowerCase();
}

function optionalText(value, key, max, keepWhitespace = false) {
    if (value == null || value === '') return null;
    if (typeof value !== 'string') fail(key, `${key} must be text or null.`);
    if (!value.isWellFormed()) fail(key, `${key} contains invalid text encoding.`);
    if (!value.trim()) return null;
    const text = keepWhitespace ? value : value.trim();
    if (text.length > max) fail(key, `${key} must be ${max} characters or fewer.`);
    return text;
}

function normalizeField(key, value) {
    switch (key) {
        case 'firstName':
        case 'lastName':
            if (value == null || value === '') return '';
            if (typeof value !== 'string' || !value.isWellFormed() || value.trim().length > 60 || CONTROL_PATTERN.test(value)) {
                fail(key, 'Enter a name of 1–60 characters.');
            }
            return value.trim();
        case 'primaryEmail':
            if (isEmpty(value) && !(typeof value === 'string' && CONTROL_PATTERN.test(value))) return '';
            return normalizeEmail(value, key);
        case 'secondaryEmails': {
            if (!Array.isArray(value ?? []) || (value ?? []).length > 9) {
                fail(key, 'Add at most 9 secondary email addresses.');
            }
            const emails = (value ?? []).map((email) => normalizeEmail(email, key));
            if (new Set(emails).size !== emails.length) fail(key, 'Each email address must be different.');
            return emails;
        }
        case 'headline':
        case 'location':
            return optionalText(value, key, 200);
        case 'professionalSummary':
            return optionalText(value, key, 8000, true);
        case 'professionalUrl': {
            const text = optionalText(value, key, 2048);
            if (text === null) return null;
            const result = normalizeProfessionalUrl(text);
            if (!result.ok) fail(key, result.message);
            if (result.value.length > 2048) fail(key, 'Profile URL is too long.');
            return result.value;
        }
        case 'ownerMembershipId':
            return uuidOrNull(value, key);
        case 'compensationPreference':
            if (value == null) return null;
            if (typeof value !== 'string' || !value.isWellFormed() || value.length > 500) {
                fail(key, 'Compensation preference must be 500 characters or fewer.');
            }
            return value.trim() || null;
        case 'telegramUsername': {
            if (value == null || value === '') return null;
            if (typeof value !== 'string') fail(key, 'Enter a valid Telegram username.');
            const username = value.trim().replace(/^@/, '');
            if (!username && !value.trim()) return null;
            if (!/^[A-Za-z0-9_]{1,32}$/.test(username)) fail(key, 'Enter a valid Telegram username.');
            return username;
        }
        case 'telegramUserId':
            if (value == null || value === '') return null;
            if (typeof value !== 'string' || !/^[0-9]{1,30}$/.test(value)) {
                fail(key, 'Telegram user ID must be a decimal string of at most 30 characters.');
            }
            return value;
    }
}

function inspectFields(input, partial) {
    const fields = {};
    const fieldErrors = {};
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
        return { fields, fieldErrors: { fields: 'Candidate fields must be an object.' } };
    }
    const unknown = Object.keys(input).filter((key) => !DRAFT_KEYS.includes(key));
    if (unknown.length) fieldErrors.fields = `Unknown candidate fields: ${unknown.join(', ')}.`;
    for (const key of DRAFT_KEYS) {
        if (partial && !Object.hasOwn(input, key)) continue;
        try {
            fields[key] = normalizeField(key, input[key]);
        } catch (error) {
            if (!(error instanceof ClientJobContractError)) throw error;
            Object.assign(fieldErrors, error.fieldErrors);
        }
    }
    if (fields.primaryEmail && fields.secondaryEmails?.includes(fields.primaryEmail)) {
        fieldErrors.secondaryEmails = 'Each email address must be different.';
    }
    return { fields, fieldErrors };
}

// Partial patches omit absent keys; validate the merged draft again before saving.
export function normalizeTelegramDraftFields(input, { partial = false } = {}) {
    const { fields, fieldErrors } = inspectFields(input, partial);
    if (Object.keys(fieldErrors).length) throw new ClientJobContractError(fieldErrors);
    return fields;
}

export function candidateFieldsFromDraft(fields) {
    const normalized = normalizeTelegramDraftFields(fields);
    return validateCandidateUploadFields(Object.fromEntries(CANDIDATE_KEYS.map((key) => [key, normalized[key]])));
}

export function assessTelegramDraft(input, cv) {
    const { fields, fieldErrors } = inspectFields(input, false);
    const missingFields = REQUIRED_KEYS.filter((key) => !fieldErrors[key] && !fields[key]);
    for (const key of missingFields) fieldErrors[key] = 'Required before creating a candidate.';
    if (cv?.status !== 'validated' || typeof cv?.filename !== 'string' || !cv.filename.trim()) {
        missingFields.push('cv');
        fieldErrors.cv = 'A validated CV with a file name is required.';
    } else {
        try {
            assertCandidateCvFilename(cv.filename);
        } catch (error) {
            if (!(error instanceof ClientJobContractError)) throw error;
            fieldErrors.cv = error.fieldErrors.cvFile;
        }
    }
    if (fields.firstName && fields.lastName && `${fields.firstName} ${fields.lastName}`.length > 120) {
        fieldErrors.fullName = 'fullName must be 120 characters or fewer.';
    }
    if (REQUIRED_KEYS.every((key) => fields[key])) {
        try {
            candidateFieldsFromDraft(fields);
        } catch (error) {
            if (!(error instanceof ClientJobContractError)) throw error;
            Object.assign(fieldErrors, error.fieldErrors);
        }
    }
    return { ready: Object.keys(fieldErrors).length === 0, missingFields, fieldErrors };
}

// Only pass approved or manually entered fields. Never embed Telegram messages or CV text here.
export function draftEmbeddingText(input) {
    const fields = normalizeTelegramDraftFields(input);
    const compact = (text) => text?.replace(/\s+/g, ' ').trim();
    const lines = [
        ['Name', [fields.firstName, fields.lastName].filter(Boolean).join(' ')],
        ['Compensation preference', fields.compensationPreference],
        ['Headline', fields.headline],
        ['Location', fields.location],
        ['Professional summary', fields.professionalSummary],
    ].filter(([, value]) => value).map(([label, value]) => `${label}: ${compact(value)}`);
    // Keep names and preferences first so a long summary cannot crowd them out.
    const text = lines.join('\n');
    return text.length <= 1200 ? text : `${text.slice(0, 1199).toWellFormed()}…`;
}
