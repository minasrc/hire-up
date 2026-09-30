import { ClientJobContractError, validateCandidateProfileFields } from './candidate-profile-contracts.js';

const fail = (field, message) => { throw new ClientJobContractError({ [field]: message }); };
const allowed = ['firstName', 'lastName', 'primaryEmail', 'secondaryEmails', 'headline', 'location', 'professionalUrl', 'ownerMembershipId', 'professionalSummary', 'compensationPreference'];
export function validateCandidateUploadFields(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('fields', 'Candidate fields are required.');
    for (const key of Object.keys(input)) if (!allowed.includes(key)) fail('fields', `Unknown candidate field "${key}".`);
    const name = (key) => {
        const value = input[key];
        if (typeof value !== 'string' || !value.isWellFormed() || !value.trim() || value.trim().length > 60 || /[\x00-\x1f\x7f]/.test(value)) fail(key, 'Enter a name of 1–60 characters.');
        return value.trim();
    };
    const email = (value, key) => {
        if (typeof value !== 'string' || !value.isWellFormed() || value.trim().length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim()) || /[\x00-\x1f\x7f]/.test(value)) fail(key, 'Enter a valid email address.');
        return value.trim().toLowerCase();
    };
    const firstName = name('firstName');
    const lastName = name('lastName');
    const primaryEmail = email(input.primaryEmail, 'primaryEmail');
    if (!Array.isArray(input.secondaryEmails ?? []) || (input.secondaryEmails ?? []).length > 9) fail('secondaryEmails', 'Add at most 9 secondary email addresses.');
    const secondaryEmails = (input.secondaryEmails ?? []).map((value) => email(value, 'secondaryEmails'));
    if (new Set([primaryEmail, ...secondaryEmails]).size !== secondaryEmails.length + 1) fail('secondaryEmails', 'Each email address must be different.');
    const profile = validateCandidateProfileFields({
        fullName: `${firstName} ${lastName}`, email: primaryEmail,
        ...Object.fromEntries(allowed.slice(4, 9).map((key) => [key, input[key]])),
    });
    const optional = Object.fromEntries(allowed.slice(4, 9).map((key) => [key, profile[key]]));
    const compensationPreference = input.compensationPreference == null ? null : input.compensationPreference;
    if (compensationPreference !== null && (typeof compensationPreference !== 'string' || !compensationPreference.isWellFormed() || compensationPreference.length > 500)) fail('compensationPreference', 'Compensation preference must be 500 characters or fewer.');
    return { firstName, lastName, primaryEmail, secondaryEmails, ...optional, compensationPreference: compensationPreference?.trim() || null };
}

export function assertCandidateCvFilename(filename) {
    if (typeof filename !== 'string' || !filename || filename.length > 512 || !filename.isWellFormed() || /[\x00-\x1f\x7f]/.test(filename)) fail('cvFile', 'The file name is not usable.');
    return filename;
}
