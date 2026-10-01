import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientJobContractError } from '../../src/lib/client-job-contracts.js';
import { validateCandidateUploadFields } from '../../src/lib/candidate-upload-contracts.js';
import {
    normalizeTelegramDraftFields, assessTelegramDraft, candidateFieldsFromDraft, draftEmbeddingText,
} from '../../src/lib/telegram-intake-contracts.js';

const complete = { firstName: ' Ada ', lastName: ' Lovelace ', primaryEmail: 'ADA@EXAMPLE.TEST' };
const cv = { status: 'validated', filename: 'cv.pdf' };
const hasErrors = (keys) => (error) => error instanceof ClientJobContractError
    && keys.every((key) => Object.hasOwn(error.fieldErrors, key));

test('incomplete drafts stay incomplete without invented identity values', () => {
    const draft = normalizeTelegramDraftFields({ telegramUsername: '@sample_user' });
    assert.equal(draft.firstName, '');
    assert.equal(draft.lastName, '');
    assert.equal(draft.primaryEmail, '');
    assert.deepEqual(draft.secondaryEmails, []);
    assert.equal(draft.telegramUsername, 'sample_user');
    assert.equal(draft.telegramUserId, null);
    assert.deepEqual(assessTelegramDraft(draft, null).missingFields, ['firstName', 'lastName', 'primaryEmail', 'cv']);
    assert.deepEqual(Object.keys(assessTelegramDraft(draft, null).fieldErrors), ['firstName', 'lastName', 'primaryEmail', 'cv']);
    assert.throws(() => candidateFieldsFromDraft(draft), hasErrors(['firstName']));
});

test('partial patches preserve existing optional fields and permit explicit clearing', () => {
    const draft = normalizeTelegramDraftFields({ ...complete, headline: 'Engineer', compensationPreference: 'EUR 100k', secondaryEmails: ['other@example.test'] });
    const patch = normalizeTelegramDraftFields({ location: ' Madrid ' }, { partial: true });
    assert.deepEqual(patch, { location: 'Madrid' });
    const merged = normalizeTelegramDraftFields({ ...draft, ...patch });
    assert.equal(merged.headline, 'Engineer');
    assert.equal(merged.compensationPreference, 'EUR 100k');
    assert.deepEqual(merged.secondaryEmails, ['other@example.test']);
    assert.deepEqual(normalizeTelegramDraftFields({ headline: '' }, { partial: true }), { headline: null });
    assert.deepEqual(normalizeTelegramDraftFields({}, { partial: true }), {});
});

test('malformed provided values collect errors across identity and optional fields', () => {
    const input = { firstName: 'x'.repeat(61), lastName: 42, primaryEmail: 'broken', headline: 'x'.repeat(201), location: false, professionalSummary: 'x'.repeat(8001), professionalUrl: 'javascript:alert(1)', ownerMembershipId: 'bad', compensationPreference: 'x'.repeat(501), telegramUsername: '@bad!', telegramUserId: 9007199254740992 };
    assert.throws(() => normalizeTelegramDraftFields(input), hasErrors(Object.keys(input)));
    const assessment = assessTelegramDraft(input, null);
    assert.equal(assessment.ready, false);
    for (const key of [...Object.keys(input), 'cv']) assert.ok(assessment.fieldErrors[key], key);
    assert.throws(() => normalizeTelegramDraftFields({ invented: true }), hasErrors(['fields']));
    for (const input of [null, [], 'string']) assert.throws(() => normalizeTelegramDraftFields(input), hasErrors(['fields']));
});

test('names and email reject control characters and invalid Unicode even in otherwise empty strings', () => {
    for (const key of ['firstName', 'lastName', 'primaryEmail']) {
        for (const value of ['\n', '\u0000', '\ud800']) {
            assert.throws(() => normalizeTelegramDraftFields({ [key]: value }), hasErrors([key]));
        }
        assert.equal(normalizeTelegramDraftFields({ [key]: '   ' })[key], '');
    }
});

test('secondary emails are normalized, bounded, and unique across the merged primary address', () => {
    assert.deepEqual(normalizeTelegramDraftFields({ secondaryEmails: [' Other@Example.test '] }).secondaryEmails, ['other@example.test']);
    for (const secondaryEmails of [['bad'], ['ONE@example.test', 'one@example.test'], Array.from({ length: 10 }, (_, index) => `${index}@example.test`), 'one@example.test']) {
        assert.throws(() => normalizeTelegramDraftFields({ secondaryEmails }), hasErrors(['secondaryEmails']));
    }
    const draft = normalizeTelegramDraftFields({ ...complete, secondaryEmails: ['other@example.test'] });
    const patch = normalizeTelegramDraftFields({ primaryEmail: 'OTHER@example.test' }, { partial: true });
    assert.throws(() => normalizeTelegramDraftFields({ ...draft, ...patch }), hasErrors(['secondaryEmails']));
});

test('complete drafts use the upload contract and strip Telegram-specific fields', () => {
    const fields = { ...complete, headline: ' Engineer ', professionalSummary: '  Approved summary\n', professionalUrl: 'linkedin.com/in/sample', compensationPreference: ' EUR 100k ', telegramUsername: '@sample_user', telegramUserId: '900719925474099312345' };
    assert.deepEqual(assessTelegramDraft(fields, cv), { ready: true, missingFields: [], fieldErrors: {} });
    const { telegramUsername, telegramUserId, ...candidate } = fields;
    assert.ok(telegramUsername && telegramUserId);
    assert.deepEqual(candidateFieldsFromDraft(fields), validateCandidateUploadFields(candidate));
    assert.equal(candidateFieldsFromDraft(fields).professionalSummary, '  Approved summary\n');
});

test('assessment reports optional problems alongside all missing requirements', () => {
    const assessment = assessTelegramDraft({ lastName: 'Lovelace', headline: 'x'.repeat(201), primaryEmail: '' }, { status: 'pending', filename: 'cv.pdf' });
    assert.deepEqual(assessment.missingFields, ['firstName', 'primaryEmail', 'cv']);
    assert.deepEqual(Object.keys(assessment.fieldErrors).sort(), ['cv', 'firstName', 'headline', 'primaryEmail']);
    for (const file of [null, { status: 'validated', filename: ' ' }, { status: 'failed', filename: 'cv.pdf' }, { status: 'validated', filename: 'bad\n.pdf' }]) {
        assert.equal(assessTelegramDraft(complete, file).ready, false);
        assert.ok(assessTelegramDraft(complete, file).fieldErrors.cv);
    }
    // Each individual name fits, but their combined upload profile exceeds 120 characters.
    assert.ok(assessTelegramDraft({ ...complete, firstName: 'a'.repeat(60), lastName: 'b'.repeat(60) }, cv).fieldErrors.fullName);
    const manyBlockers = assessTelegramDraft({ firstName: 'a'.repeat(60), lastName: 'b'.repeat(60), headline: false }, null);
    assert.deepEqual(Object.keys(manyBlockers.fieldErrors).sort(), ['cv', 'fullName', 'headline', 'primaryEmail']);
});

test('Telegram identifiers retain decimal precision and username normalization follows its own contract', () => {
    const id = '9007199254740993123456789';
    assert.equal(normalizeTelegramDraftFields({ telegramUserId: id }).telegramUserId, id);
    for (const telegramUserId of [123, 9007199254740992, 123n, '1e5', '-123', '1.0', ' 123 ']) {
        assert.throws(() => normalizeTelegramDraftFields({ telegramUserId }), hasErrors(['telegramUserId']));
    }
    assert.equal(normalizeTelegramDraftFields({ telegramUsername: ' @1abcd ' }).telegramUsername, '1abcd');
    assert.equal(normalizeTelegramDraftFields({ telegramUsername: '' }).telegramUsername, null);
    for (const telegramUsername of ['abcd', '@@abcde', 'a'.repeat(33), 'abc-de']) assert.throws(() => normalizeTelegramDraftFields({ telegramUsername }), hasErrors(['telegramUsername']));
});

test('embedding text is deterministic, bounded, and contains only approved profile details', () => {
    const fields = { ...complete, telegramUsername: 'sample_user', telegramUserId: '12345', compensationPreference: 'EUR 100k', headline: 'Engineer', location: 'Madrid', professionalSummary: 'Approved summary. '.repeat(400) };
    const text = draftEmbeddingText(fields);
    assert.ok(text.length <= 1200);
    assert.equal(text, draftEmbeddingText(fields));
    assert.match(text, /^Name: Ada Lovelace\nCompensation preference: EUR 100k/);
    assert.match(text, /Headline: Engineer\nLocation: Madrid\nProfessional summary:/);
    assert.doesNotMatch(text, /sample_user|12345|EXAMPLE.TEST/);
    assert.equal(draftEmbeddingText({}), '');
    assert.throws(() => draftEmbeddingText({ rawMessages: 'unapproved source' }), hasErrors(['fields']));
});
