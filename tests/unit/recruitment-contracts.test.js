import assert from 'node:assert/strict';
import test from 'node:test';

import { ClientJobContractError } from '../../src/lib/client-job-contracts.js';
import {
    assertOperationId,
    assertUuid,
    assertVersion,
    isStrictDate,
    isUuid,
    normalizeApplicationDirectoryFilters,
    normalizeCandidateDirectoryFilters,
    optionalNoteText,
    splitImportTags,
    uuidOrNull,
    validateCandidateFields,
    validateImportRecords,
    validateImportReviewRecords,
} from '../../src/lib/recruitment-contracts.js';

const UUID_A = '11111111-2222-3333-4444-555555555555';
const UUID_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const UUID_C = '99999999-8888-7777-6666-555555555555';

const failFields = (fn) => {
    try {
        fn();
    } catch (error) {
        assert.ok(error instanceof ClientJobContractError);
        return error.fieldErrors;
    }
    assert.fail('expected ClientJobContractError');
};

test('assertVersion accepts positive bigint strings within range', () => {
    assert.equal(assertVersion('1'), 1n);
    assert.equal(assertVersion('9223372036854775807'), 9223372036854775807n);
});

test('assertVersion rejects zero, negatives, non-strings and overflow', () => {
    for (const value of ['0', '-1', 'abc', '1.5', '', '007', '9223372036854775808']) {
        const fields = failFields(() => assertVersion(value));
        assert.ok(fields.expectedVersion);
    }
    assert.throws(() => assertVersion(5), ClientJobContractError);
    assert.throws(() => assertVersion(9223372036854775807n), ClientJobContractError);
    assert.throws(() => assertVersion(null), ClientJobContractError);
});

test('assertOperationId requires a uuid and lowercases it', () => {
    assert.equal(assertOperationId(UUID_A.toUpperCase()), UUID_A);
    assert.throws(() => assertOperationId('not-a-uuid'), ClientJobContractError);
    assert.throws(() => assertOperationId(undefined), ClientJobContractError);
});

test('assertUuid and uuidOrNull bound identifiers', () => {
    assert.equal(assertUuid(UUID_B, 'jobId'), UUID_B);
    assert.equal(uuidOrNull(undefined, 'jobId'), null);
    assert.equal(uuidOrNull('', 'jobId'), null);
    assert.throws(() => uuidOrNull('x', 'jobId'), ClientJobContractError);
});

test('isUuid matches only uuid-shaped strings', () => {
    assert.equal(isUuid(UUID_A), true);
    assert.equal(isUuid('1234'), false);
});

test('isStrictDate rejects impossible and non-padded dates', () => {
    assert.equal(isStrictDate('2026-02-28'), true);
    assert.equal(isStrictDate('2026-02-30'), false);
    assert.equal(isStrictDate('2026-2-8'), false);
    assert.equal(isStrictDate('not-a-date'), false);
});

test('validateCandidateFields requires a plain object with known keys', () => {
    assert.throws(() => validateCandidateFields(null), ClientJobContractError);
    assert.throws(() => validateCandidateFields(['x']), ClientJobContractError);
    const fields = failFields(
        () => validateCandidateFields({ fullName: 'Ada', mystery: 1 }));
    assert.match(fields.fields, /Unknown candidate field/u);
});

test('validateCandidateFields normalizes a minimal record', () => {
    const fields = validateCandidateFields({ fullName: '  Ada Lovelace  ' });
    assert.equal(fields.fullName, 'Ada Lovelace');
    assert.equal(fields.availability, 'not_specified');
    assert.equal(fields.source, 'manual');
    assert.deepEqual(fields.tags, []);
});

test('validateCandidateFields rejects bad email and oversized text', () => {
    assert.throws(
        () => validateCandidateFields({ fullName: 'Ada', email: 'nope' }),
        ClientJobContractError);
    assert.throws(
        () => validateCandidateFields({ fullName: 'x'.repeat(121) }),
        ClientJobContractError);
});

test('review records keep field-invalid rows for per-row SQL marking', () => {
    const records = validateImportReviewRecords([
        {
            fields: { fullName: 'Grace Hopper', email: 'grace@example.com' },
            note: 'met at conf',
            operationId: UUID_A,
        },
        {
            fields: { email: 'missing-name@example.com' },
            operationId: UUID_B,
        },
    ]);
    assert.equal(records.length, 2);
    assert.equal(records[0].fields.fullName, 'Grace Hopper');
    assert.equal(records[0].fields.source, 'import');
    assert.equal(records[0].note, 'met at conf');
    assert.equal(records[0].operationId, UUID_A);
    assert.equal(records[1].fields.source, 'import');
    assert.equal(records[1].fields.email, 'missing-name@example.com');
});

test('review rejects unknown envelope keys and non-object records', () => {
    const fields1 = failFields(() => validateImportReviewRecords([
        { index: 0, fields: { fullName: 'Ada' }, operationId: UUID_A },
    ]));
    assert.match(Object.values(fields1).join(' '), /Unknown import record field/u);
    const fields2 = failFields(() => validateImportReviewRecords(['nope']));
    assert.match(Object.values(fields2).join(' '), /must be an object/u);
    assert.throws(
        () => validateImportReviewRecords([{ fields: 'text', operationId: UUID_A }]),
        ClientJobContractError);
});

test('review bounds record count and field payload size', () => {
    assert.throws(() => validateImportReviewRecords([]), ClientJobContractError);
    const over = Array.from({ length: 101 }, (_, index) => ({
        fields: { fullName: `p${index}` },
        operationId: UUID_A,
    }));
    const overFields = failFields(() => validateImportReviewRecords(over));
    assert.match(overFields.records, /100/u);
    const huge = [{
        fields: { fullName: 'Ada', professionalSummary: 'x'.repeat(70 * 1024) },
        operationId: UUID_A,
    }];
    const fields = failFields(() => validateImportReviewRecords(huge));
    assert.match(Object.values(fields).join(' '), /64 KB/u);
});

test('commit records validate every field set strictly', () => {
    assert.throws(
        () => validateImportRecords([
            { fields: { email: 'no-name@example.com' }, operationId: UUID_A },
        ]),
        ClientJobContractError);
    const records = validateImportRecords([
        {
            fields: { fullName: 'Ada', source: 'manual' },
            operationId: UUID_A,
            jobId: UUID_C,
        },
    ]);
    assert.equal(records[0].fields.source, 'import');
    assert.equal(records[0].jobId, UUID_C);
});

test('commit rejects malformed operation ids', () => {
    const fields = failFields(() => validateImportRecords([
        { fields: { fullName: 'Ada' }, operationId: 'not-uuid' },
    ]));
    assert.match(Object.keys(fields)[0], /operationId/u);
});

test('candidate directory filters reject invalid input', () => {
    assert.deepEqual(normalizeCandidateDirectoryFilters({}), {});
    const filters = normalizeCandidateDirectoryFilters({
        query: 'ada', owner: 'mine', tag: 'priority', tab: 'recent', page: '2',
    });
    assert.deepEqual(filters, {
        query: 'ada', owner: 'mine', tag: 'priority', tab: 'recent', page: 2,
    });
    assert.throws(
        () => normalizeCandidateDirectoryFilters({ tab: 'bogus' }),
        ClientJobContractError);
    assert.throws(
        () => normalizeCandidateDirectoryFilters({ owner: 'not-uuid' }),
        ClientJobContractError);
    assert.throws(
        () => normalizeCandidateDirectoryFilters({ page: '0' }),
        ClientJobContractError);
});

test('application directory filters validate dates and references', () => {
    const filters = normalizeApplicationDirectoryFilters({
        clientId: UUID_A,
        jobId: UUID_B,
        stage: 'interview',
        review: '1',
        owner: 'mine',
        dateRange: 'custom',
        from: '2026-01-01',
        to: '2026-01-31',
    });
    assert.equal(filters.review, true);
    assert.equal(filters.from, '2026-01-01');
    assert.throws(
        () => normalizeApplicationDirectoryFilters({ clientId: 'x' }),
        ClientJobContractError);
    assert.throws(
        () => normalizeApplicationDirectoryFilters({ dateRange: 'bogus' }),
        ClientJobContractError);
    assert.throws(
        () => normalizeApplicationDirectoryFilters({
            dateRange: 'custom', from: '2026-02-30',
        }),
        ClientJobContractError);
    assert.throws(
        () => normalizeApplicationDirectoryFilters({
            dateRange: 'custom', from: '2026-02-01', to: '2026-01-01',
        }),
        ClientJobContractError);
});

test('optionalNoteText trims and bounds note text', () => {
    assert.equal(optionalNoteText(null), null);
    assert.equal(optionalNoteText('   '), null);
    assert.equal(optionalNoteText('  hello  '), 'hello');
    assert.throws(() => optionalNoteText(42), ClientJobContractError);
    assert.throws(() => optionalNoteText('x'.repeat(4001)), ClientJobContractError);
});

test('splitImportTags splits on separators and dedupes case-insensitively', () => {
    assert.deepEqual(splitImportTags('a; b,c|d'), ['a', 'b', 'c', 'd']);
    assert.deepEqual(splitImportTags('Dup, dup;DUP'), ['Dup']);
    assert.deepEqual(splitImportTags(null), []);
});
