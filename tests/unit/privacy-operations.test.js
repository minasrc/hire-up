import assert from 'node:assert/strict';
import test from 'node:test';
import {
    correctPrivacyCandidate,
    createPrivacyRequest,
    restrictPrivacySubject,
    reviewPrivacySubject,
    verifyPrivacyRequest,
} from '../../src/lib/privacy-operations.js';
import { StaffAuthorizationError } from '../../src/lib/staff-authorization.js';

const ORG = '9c4edd11-2571-490b-a87c-ef30b9e0a001';
const IDENTITY = { provider: 'google', issuer: 'https://accounts.google.com', subject: '12345' };
const PRINCIPAL_ROW = {
    user_id: '70000000-0000-4000-8000-000000000101',
    membership_id: '70000000-0000-4000-8000-000000000201',
    role_id: '9c4edd11-2571-490b-a87c-ef30b9e0a011',
};
const REQUEST_ID = '80000000-0000-4000-8000-000000000170';
const SUBJECT_ID = '80000000-0000-4000-8000-000000000210';
const CANDIDATE_ID = '80000000-0000-4000-8000-000000000070';
const LEGACY_ID = '80000000-0000-4000-8000-000000000201';
const HASH_32 = Buffer.from('ff'.repeat(32), 'hex');
const RESULT = { request_id: REQUEST_ID, request_version: '2', status: 'verified' };

const makeClient = (behaviour = {}) => {
    const queries = [];
    const releases = [];
    return {
        queries,
        releases,
        async query(text, params) {
            queries.push({ text, params });
            if (behaviour.onQuery) {
                return behaviour.onQuery(text, params);
            }
            if (text.includes('resolve_staff_principal_v1')) {
                return { rows: behaviour.resolverRows ?? [PRINCIPAL_ROW] };
            }
            if (text.includes('has_permission_v1')) {
                return { rows: params[0].map(() => ({ allowed: behaviour.allowed !== false })) };
            }
            if (text.includes('privacy_')) {
                return { rows: [{ result: RESULT }] };
            }
            return { rows: [] };
        },
        release(error) {
            releases.push(error ?? null);
        },
    };
};

const makePool = (client) => {
    const pool = {
        connects: 0,
        async connect() {
            pool.connects += 1;
            return client;
        },
    };
    return pool;
};

const rejectsInvalid = (promise, label) => assert.rejects(
    promise,
    (error) => error instanceof StaffAuthorizationError
        && error.code === 'INVALID_CONTEXT',
    label,
);

const createInput = (overrides = {}) => ({
    requestId: REQUEST_ID,
    kind: 'access',
    receivedAt: '2026-09-20T00:00:00Z',
    ...overrides,
});
const reviewInput = (overrides = {}) => ({
    requestId: REQUEST_ID,
    expectedRequestVersion: '1',
    subjectId: SUBJECT_ID,
    candidateId: CANDIDATE_ID,
    expectedTargetVersion: '1',
    ...overrides,
});
const verifyInput = (overrides = {}) => ({
    requestId: REQUEST_ID,
    expectedRequestVersion: '2',
    verificationMethod: 'synthetic-staff-review',
    ...overrides,
});
const correctInput = (overrides = {}) => ({
    requestId: REQUEST_ID,
    expectedRequestVersion: '3',
    subjectId: SUBJECT_ID,
    expectedCandidateVersion: '1',
    changes: { full_name: 'Sentinel Name' },
    ...overrides,
});
const restrictInput = (overrides = {}) => ({
    requestId: REQUEST_ID,
    expectedRequestVersion: '3',
    subjectId: SUBJECT_ID,
    expectedTargetVersion: '1',
    ...overrides,
});

const VALID_CALLS = [
    [createPrivacyRequest, createInput({ dueAt: '2026-10-20T00:00:00Z' })],
    [reviewPrivacySubject, reviewInput()],
    [verifyPrivacyRequest, verifyInput()],
    [correctPrivacyCandidate, correctInput()],
    [restrictPrivacySubject, restrictInput()],
];

test('each wrapper issues one typed procedure call with privacy.manage', async () => {
    const expectedSql = {
        createPrivacyRequest: 'select app.create_privacy_request_v1('
            + '$1::uuid, $2::text, $3::timestamptz, $4::timestamptz, $5::uuid, $6::uuid'
            + ') as result',
        reviewPrivacySubject: 'select app.review_privacy_subject_v1('
            + '$1::uuid, $2::bigint, $3::uuid, $4::uuid, $5::uuid, $6::bigint,'
            + ' $7::bytea, $8::uuid, $9::uuid'
            + ') as result',
        verifyPrivacyRequest: 'select app.verify_privacy_request_v1('
            + '$1::uuid, $2::bigint, $3::text, $4::uuid, $5::uuid'
            + ') as result',
        correctPrivacyCandidate: 'select app.correct_privacy_candidate_v1('
            + '$1::uuid, $2::bigint, $3::uuid, $4::bigint, $5::jsonb, $6::uuid, $7::uuid'
            + ') as result',
        restrictPrivacySubject: 'select app.restrict_privacy_subject_v1('
            + '$1::uuid, $2::bigint, $3::uuid, $4::bigint, $5::uuid, $6::uuid'
            + ') as result',
    };
    for (const [wrapper, input] of VALID_CALLS) {
        const client = makeClient();
        const pool = makePool(client);
        const result = await wrapper(pool, IDENTITY, ORG, input);
        assert.deepEqual(result, RESULT, `${wrapper.name} must return the procedure result`);
        const call = client.queries.find(({ text }) => text.includes('privacy_'));
        assert.equal(call.text, expectedSql[wrapper.name],
            `${wrapper.name} must use the fixed typed call`);
        const permission = client.queries.find(({ text }) => text.includes('has_permission_v1'));
        assert.deepEqual(permission.params, [['privacy.manage']],
            `${wrapper.name} must require privacy.manage`);
        assert.ok(
            client.queries.map(({ text }) => text).indexOf('commit')
                > client.queries.indexOf(call),
            `${wrapper.name} must commit after the procedure`,
        );
        assert.deepEqual(client.releases, [null]);
    }
});

test('procedure parameters precede generated audit and correlation ids', async () => {
    const cases = [
        [
            createPrivacyRequest,
            createInput(),
            [REQUEST_ID, 'access', '2026-09-20T00:00:00Z', null],
        ],
        [
            reviewPrivacySubject,
            reviewInput(),
            [REQUEST_ID, '1', SUBJECT_ID, CANDIDATE_ID, null, '1', null],
        ],
        [
            reviewPrivacySubject,
            reviewInput({ candidateId: undefined, legacyRecordId: LEGACY_ID, sourceSha256: HASH_32 }),
            [REQUEST_ID, '1', SUBJECT_ID, null, LEGACY_ID, '1', HASH_32],
        ],
        [
            verifyPrivacyRequest,
            verifyInput(),
            [REQUEST_ID, '2', 'synthetic-staff-review'],
        ],
        [
            correctPrivacyCandidate,
            correctInput(),
            [REQUEST_ID, '3', SUBJECT_ID, '1', '{"full_name":"Sentinel Name"}'],
        ],
        [
            restrictPrivacySubject,
            restrictInput(),
            [REQUEST_ID, '3', SUBJECT_ID, '1'],
        ],
    ];
    for (const [wrapper, input, expected] of cases) {
        const client = makeClient();
        const pool = makePool(client);
        await wrapper(pool, IDENTITY, ORG, input);
        const call = client.queries.find(({ text }) => text.includes('privacy_'));
        const label = `${wrapper.name} parameter order`;
        const expectedLength = expected.length + 2;
        assert.equal(call.params.length, expectedLength, label);
        assert.deepEqual(call.params.slice(0, expected.length), expected, label);
        const [auditId, correlationId] = call.params.slice(expected.length);
        assert.match(auditId, /^[0-9a-f-]{36}$/, `${label}: generated audit id`);
        assert.match(correlationId, /^[0-9a-f-]{36}$/, `${label}: generated correlation id`);
        assert.notEqual(auditId, correlationId);
        for (const { text } of client.queries) {
            assert.ok(!text.includes(REQUEST_ID), `${wrapper.name} must not interpolate values`);
        }
    }
});

test('numeric versions are normalised and unsafe versions rejected', async () => {
    const client = makeClient();
    const pool = makePool(client);
    await verifyPrivacyRequest(pool, IDENTITY, ORG, verifyInput({ expectedRequestVersion: 7 }));
    const call = client.queries.find(({ text }) => text.includes('privacy_'));
    assert.equal(call.params[1], '7', 'numeric versions must be normalised to text');

    for (const version of ['9007199254740993', '9223372036854775807']) {
        const stringClient = makeClient();
        await verifyPrivacyRequest(
            makePool(stringClient), IDENTITY, ORG,
            verifyInput({ expectedRequestVersion: version }),
        );
        const stringCall = stringClient.queries.find(({ text }) => text.includes('privacy_'));
        assert.equal(stringCall.params[1], version,
            `version string ${version} must pass through unchanged`);
    }

    const invalidVersions = [0, -1, '0', '-3', '1.5', 'abc', '', null, undefined,
        '9223372036854775808', Number.MAX_SAFE_INTEGER + 1, 1.5, NaN];
    for (const version of invalidVersions) {
        await rejectsInvalid(
            verifyPrivacyRequest(
                makePool(makeClient()), IDENTITY, ORG,
                verifyInput({ expectedRequestVersion: version }),
            ),
            `expectedRequestVersion ${String(version)} must be rejected`,
        );
        await rejectsInvalid(
            restrictPrivacySubject(
                makePool(makeClient()), IDENTITY, ORG,
                restrictInput({ expectedTargetVersion: version }),
            ),
            `expectedTargetVersion ${String(version)} must be rejected`,
        );
    }
});

test('malformed identifiers and targets are rejected before the pool', async () => {
    const cases = [
        [createPrivacyRequest, createInput({ requestId: 'not-a-uuid' })],
        [createPrivacyRequest, createInput({ requestId: REQUEST_ID.toUpperCase().slice(1) })],
        [reviewPrivacySubject, reviewInput({ subjectId: 'zzz' })],
        [reviewPrivacySubject, reviewInput({ candidateId: '123' })],
        [reviewPrivacySubject, reviewInput({ candidateId: null, legacyRecordId: null })],
        [reviewPrivacySubject, reviewInput({ legacyRecordId: LEGACY_ID })],
        [verifyPrivacyRequest, verifyInput({ requestId: {} })],
        [correctPrivacyCandidate, correctInput({ subjectId: [] })],
        [restrictPrivacySubject, restrictInput({ requestId: '80000000-0000-4000-8000' })],
    ];
    for (const [wrapper, input] of cases) {
        const client = makeClient();
        const pool = makePool(client);
        await rejectsInvalid(wrapper(pool, IDENTITY, ORG, input), `${wrapper.name} ${JSON.stringify(input)}`);
        assert.equal(pool.connects, 0, `${wrapper.name} must not touch the pool`);
    }
});

test('request kind, verification method and hash inputs are validated', async () => {
    const pool = () => makePool(makeClient());
    await rejectsInvalid(
        createPrivacyRequest(pool(), IDENTITY, ORG, createInput({ kind: 'access;' })),
    );
    await rejectsInvalid(
        createPrivacyRequest(pool(), IDENTITY, ORG, createInput({ kind: 'ACCESS' })),
    );
    await rejectsInvalid(
        createPrivacyRequest(pool(), IDENTITY, ORG, createInput({ receivedAt: null })),
    );
    await rejectsInvalid(
        verifyPrivacyRequest(pool(), IDENTITY, ORG, verifyInput({ verificationMethod: '' })),
    );
    await rejectsInvalid(
        verifyPrivacyRequest(pool(), IDENTITY, ORG, verifyInput({ verificationMethod: null })),
    );
    await rejectsInvalid(
        reviewPrivacyRequestBuffer(pool(), 'short'),
        'hashes must be 32-byte buffers',
    );
    await rejectsInvalid(
        reviewPrivacyRequestBuffer(pool(), 'ff'.repeat(32)),
        'hashes must be Buffer, not hex strings',
    );
    const accepted = reviewPrivacySubject(
        pool(), IDENTITY, ORG,
        reviewInput({ candidateId: undefined, legacyRecordId: LEGACY_ID, sourceSha256: HASH_32 }),
    );
    await assert.doesNotReject(accepted);
});

const reviewPrivacyRequestBuffer = (pool, value) => reviewPrivacySubject(
    pool,
    IDENTITY,
    ORG,
    reviewInput({ candidateId: undefined, legacyRecordId: LEGACY_ID, sourceSha256: value }),
);

test('changes payloads enforce keys, value types and size', async () => {
    const pool = () => makePool(makeClient());
    const invalidChanges = [
        null,
        undefined,
        {},
        [],
        ['full_name'],
        { full_name: 'x', unexpected: 'y' },
        { full_name: 42 },
        { professional_summary: { nested: true } },
        { full_name: 'x'.repeat(50000) },
    ];
    for (const changes of invalidChanges) {
        await rejectsInvalid(
            correctPrivacyCandidate(pool(), IDENTITY, ORG, correctInput({ changes })),
            `changes ${JSON.stringify(changes)?.slice(0, 40)} must be rejected`,
        );
    }
    const client = makeClient();
    await correctPrivacyCandidate(makePool(client), IDENTITY, ORG, correctInput({
        changes: { full_name: 'A'.repeat(256), professional_summary: null },
    }));
    const call = client.queries.find(({ text }) => text.includes('privacy_'));
    assert.equal(
        call.params[4],
        JSON.stringify({ full_name: 'A'.repeat(256), professional_summary: null }),
        'changes must be sent as an encoded jsonb parameter',
    );
});

test('unknown input keys and caller-supplied identifiers are rejected', async () => {
    const pool = () => makePool(makeClient());
    const cases = [
        [createPrivacyRequest, createInput({ auditId: 'attacker' })],
        [createPrivacyRequest, createInput({ correlationId: 'attacker' })],
        [verifyPrivacyRequest, verifyInput({ status: 'verified' })],
        [correctPrivacyCandidate, correctInput({ candidateId: CANDIDATE_ID })],
        [restrictPrivacySubject, restrictInput({ functionName: 'other' })],
        [createPrivacyRequest, createInput({ constructor: {} })],
    ];
    for (const [wrapper, input] of cases) {
        await rejectsInvalid(
            wrapper(pool(), IDENTITY, ORG, input),
            `${wrapper.name} must reject unknown keys`,
        );
    }
});

test('non-object inputs are rejected', async () => {
    const pool = () => makePool(makeClient());
    for (const input of [null, undefined, 'access', 42, []]) {
        await rejectsInvalid(
            createPrivacyRequest(pool(), IDENTITY, ORG, input),
        );
    }
});

test('permission denial and provider errors propagate after rollback', async () => {
    const denied = makeClient({ allowed: false });
    await assert.rejects(
        createPrivacyRequest(makePool(denied), IDENTITY, ORG, createInput()),
        (error) => error.code === 'FORBIDDEN',
    );
    assert.ok(denied.queries.map(({ text }) => text).includes('rollback'));
    assert.ok(!denied.queries.some(({ text }) => text.includes('privacy_request_v1')));
    assert.deepEqual(denied.releases, [null]);

    const unresolved = makeClient({ resolverRows: [] });
    await assert.rejects(
        verifyPrivacyRequest(makePool(unresolved), IDENTITY, ORG, verifyInput()),
        (error) => error.code === 'UNAUTHORIZED',
    );

    const failure = Object.assign(new Error('procedure exploded'), { code: '40001' });
    const failing = makeClient({
        onQuery(text, params) {
            if (text.includes('privacy_')) {
                throw failure;
            }
            if (text.includes('resolve_staff_principal_v1')) {
                return { rows: [PRINCIPAL_ROW] };
            }
            if (text.includes('has_permission_v1')) {
                return { rows: params[0].map(() => ({ allowed: true })) };
            }
            return { rows: [] };
        },
    });
    await assert.rejects(
        restrictPrivacySubject(makePool(failing), IDENTITY, ORG, restrictInput()),
        (error) => error === failure,
    );
    const texts = failing.queries.map(({ text }) => text);
    assert.ok(texts.includes('rollback'));
    assert.ok(!texts.includes('commit'));
    assert.deepEqual(failing.releases, [null]);
});
