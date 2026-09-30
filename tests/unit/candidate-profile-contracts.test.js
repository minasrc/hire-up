import assert from 'node:assert/strict';
import test from 'node:test';

import { ClientJobContractError } from '../../src/lib/client-job-contracts.js';
import {
    assertOperationId,
    assertVersion,
    isUuid,
    validateCandidateProfileFields,
    versionOrNull,
} from '../../src/lib/candidate-profile-contracts.js';
import {
    isMissingProfileFunctionError,
    listCandidateProfiles,
} from '../../src/lib/candidate-profile-operations.js';

const OWNER = '12345678-1111-2222-3333-444444444444';

const invalid = (input, field) => {
    try {
        validateCandidateProfileFields(input);
    } catch (error) {
        assert.ok(error instanceof ClientJobContractError);
        if (field) assert.ok(field in error.fieldErrors);
        return error;
    }
    throw new Error('expected ClientJobContractError');
};

test('a complete seven-field payload normalizes', () => {
    assert.deepEqual(validateCandidateProfileFields({
        fullName: '  Ada Lovelace  ',
        email: 'ada@example.test',
        professionalUrl: 'example.test/ada',
        headline: 'Engineer',
        location: 'London',
        ownerMembershipId: OWNER.toUpperCase(),
        professionalSummary: '  keeps whitespace  ',
    }), {
        fullName: 'Ada Lovelace',
        email: 'ada@example.test',
        professionalUrl: 'https://example.test/ada',
        headline: 'Engineer',
        location: 'London',
        ownerMembershipId: OWNER,
        professionalSummary: '  keeps whitespace  ',
    });
});

test('blank and missing values normalize to null except the name', () => {
    assert.deepEqual(validateCandidateProfileFields({ fullName: 'Solo' }), {
        fullName: 'Solo',
        email: null,
        professionalUrl: null,
        headline: null,
        location: null,
        ownerMembershipId: null,
        professionalSummary: null,
    });
    const cleared = validateCandidateProfileFields({
        fullName: 'Solo',
        email: '   ',
        professionalUrl: '',
        headline: null,
        location: null,
        ownerMembershipId: null,
        professionalSummary: '',
    });
    assert.equal(cleared.email, null);
    assert.equal(cleared.professionalUrl, null);
});

test('unknown keys, non-objects and a missing name are rejected', () => {
    invalid(null, 'fields');
    invalid(['x'], 'fields');
    invalid({ fullName: 'Ada', nickname: 'x' }, 'fields');
    invalid({ fullName: 'Ada', tags: ['x'] }, 'fields');
    invalid({ fullName: 'Ada', cvFile: {} }, 'fields');
    invalid({ email: 'a@b.test' }, 'fullName');
    invalid({ fullName: '   ' }, 'fullName');
    invalid({ fullName: 42 }, 'fullName');
    invalid({ fullName: 'x'.repeat(121) }, 'fullName');
    invalid({ fullName: 'Ada', email: 7 }, 'email');
    invalid({ fullName: 'Ada', headline: 'x'.repeat(201) }, 'headline');
    invalid({ fullName: 'Ada', location: 'x'.repeat(201) }, 'location');
    invalid(
        { fullName: 'Ada', professionalSummary: 'x'.repeat(8001) },
        'professionalSummary');
});

test('email and URL formats are validated', () => {
    invalid({ fullName: 'Ada', email: 'not-an-email' }, 'email');
    invalid({ fullName: 'Ada', email: 'a@b' }, 'email');
    invalid({ fullName: 'Ada', email: `${'x'.repeat(250)}@x.test` }, 'email');
    invalid({ fullName: 'Ada', professionalUrl: 'not a url\\' }, 'professionalUrl');
    invalid(
        { fullName: 'Ada', professionalUrl: 'javascript:alert(1)' },
        'professionalUrl');
    invalid(
        { fullName: 'Ada', professionalUrl: 'ftp://example.test/x' },
        'professionalUrl');
    invalid(
        { fullName: 'Ada', professionalUrl: 'ada@example.test' },
        'professionalUrl');
    assert.equal(
        validateCandidateProfileFields({
            fullName: 'Ada', professionalUrl: 'linkedin.com/in/ada',
        }).professionalUrl,
        'https://linkedin.com/in/ada');
});

test('owner membership must be a UUID or null', () => {
    invalid({ fullName: 'Ada', ownerMembershipId: 'member-1' }, 'ownerMembershipId');
    assert.equal(
        validateCandidateProfileFields({
            fullName: 'Ada', ownerMembershipId: '' }).ownerMembershipId,
        null);
});

test('versions are strict positive bigint strings', () => {
    assert.equal(assertVersion('1'), '1');
    assert.equal(assertVersion('9223372036854775807'), '9223372036854775807');
    for (const value of [
        '0', '-1', '1.5', 'abc', '', 5, '9223372036854775808', ' 1',
    ]) {
        assert.throws(() => assertVersion(value), ClientJobContractError,
            `expected rejection for ${JSON.stringify(value)}`);
    }
    assert.equal(versionOrNull(null), null);
    assert.equal(versionOrNull(undefined), null);
    assert.equal(versionOrNull('42'), '42');
    assert.throws(() => versionOrNull('0'), ClientJobContractError);
});

test('operation identifiers must be UUIDs', () => {
    assert.equal(
        assertOperationId('AAAAAAAA-1111-2222-3333-444444444444'),
        'aaaaaaaa-1111-2222-3333-444444444444');
    for (const value of ['x', '', null, 1, '1234']) {
        assert.throws(() => assertOperationId(value), ClientJobContractError);
    }
    assert.equal(isUuid('aaaaaaaa-1111-2222-3333-444444444444'), true);
    assert.equal(isUuid('aaaaaaaa-1111-2222-3333'), false);
});

test('the encoded payload is capped at 48 KiB', () => {
    const padding = 'x'.repeat(49000);
    assert.throws(
        () => validateCandidateProfileFields({
            fullName: 'Ada',
            professionalSummary: padding,
        }),
        ClientJobContractError);
    const error = invalid({ fullName: 'Ada', professionalSummary: padding }, null);
    assert.ok(error instanceof ClientJobContractError);
});

test('malformed UTF-8 surrogates are rejected', () => {
    invalid({ fullName: 'Ada', headline: 'lone \uDEAD surrogate' }, 'headline');
    invalid({ fullName: 'Ada', professionalSummary: '\uD800' }, 'professionalSummary');
    assert.equal(
        validateCandidateProfileFields({
            fullName: 'Ada', headline: 'symbol \u{1D11E} ok' }).headline,
        'symbol \u{1D11E} ok');
});

test('the missing-function detector is exact', () => {
    assert.equal(isMissingProfileFunctionError({
        code: '42883',
        message: 'function app.get_candidate_profile_v1(uuid) does not exist',
    }), true);
    assert.equal(isMissingProfileFunctionError({
        code: '42883',
        message: 'function app.list_candidate_profiles_v1(text, integer) does not exist',
    }), true);
    assert.equal(isMissingProfileFunctionError({
        code: '42883',
        message: 'function app.get_candidate_profile_options_v1() does not exist',
    }), true);
    assert.equal(isMissingProfileFunctionError({
        code: '42883',
        message: 'function app.save_candidate_profile_v1(uuid,...) does not exist',
    }), true);
    assert.equal(isMissingProfileFunctionError({
        code: '42883',
        message: 'function app.list_candidates_v1(text, integer) does not exist',
    }), false, 'an unrelated missing function must not trigger the fallback');
    assert.equal(isMissingProfileFunctionError({
        code: '42883',
        message: 'function app.get_candidate_profile_v10(uuid) does not exist',
    }), false, 'a longer versioned name must not match');
    assert.equal(isMissingProfileFunctionError({
        code: '42883',
        message: 'function app.get_candidate_profile_v1_extra(uuid) does not exist',
    }), false, 'a suffixed name must not match');
    assert.equal(isMissingProfileFunctionError({
        code: '42883',
        message: 'function other_schema.get_candidate_profile_v1(uuid) does not exist',
    }), false, 'another schema must not match');
    assert.equal(isMissingProfileFunctionError({
        code: '42501',
        message: 'permission denied for function app.get_candidate_profile_v1',
    }), false, 'a permission denial must not trigger the fallback');
    assert.equal(isMissingProfileFunctionError({
        code: '40001', message: 'Candidate changed; reload before saving',
    }), false);
    assert.equal(isMissingProfileFunctionError(null), false);
    assert.equal(isMissingProfileFunctionError(new Error('boom')), false);
});

test('listCandidateProfiles validates input before connecting', async () => {
    const pool = {
        connect: async () => {
            throw new Error('pool must not be touched');
        },
    };
    for (const input of [
        { extra: true },
        { query: 7 },
        { query: 'x'.repeat(201) },
        { limit: 0 },
        { limit: 1001 },
        { limit: 2.5 },
        'nope',
    ]) {
        await assert.rejects(
            listCandidateProfiles(pool, {}, 'org', input),
            ClientJobContractError,
            JSON.stringify(input),
        );
    }
});
