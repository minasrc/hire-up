import assert from 'node:assert/strict';
import test from 'node:test';
import {
    StaffAuthorizationError,
    withStaffTransaction,
    withStaffActor,
} from '../../src/lib/staff-authorization.js';

const ORG = '9c4edd11-2571-490b-a87c-ef30b9e0a001';
const IDENTITY = { provider: 'google', issuer: 'https://accounts.google.com', subject: '12345' };
const PRINCIPAL_ROW = {
    user_id: '70000000-0000-4000-8000-000000000101',
    membership_id: '70000000-0000-4000-8000-000000000201',
    role_id: '9c4edd11-2571-490b-a87c-ef30b9e0a011',
};

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

test('rejects invalid context before touching the pool', async () => {
    const client = makeClient();
    const pool = makePool(client);
    const invalid = [
        [null, ORG, ['staff.manage']],
        // Applicant GitHub identities must never reach the staff workspace.
        [{ provider: 'github', issuer: 'https://github.com', subject: '12345' }, ORG, ['staff.manage']],
        [{ provider: 'google', issuer: 'https://github.com', subject: '1' }, ORG, ['staff.manage']],
        [{ provider: 'google', issuer: 'https://evil.example', subject: '1' }, ORG, ['staff.manage']],
        [{ provider: 'google', issuer: 'https://accounts.google.com', subject: 'abc' }, ORG, ['staff.manage']],
        [{ provider: 'google', issuer: 'https://accounts.google.com', subject: '0' }, ORG, ['staff.manage']],
        [{ provider: 'google', issuer: 'https://accounts.google.com', subject: '1234567890123456789012' },
            ORG, ['staff.manage']],
        [IDENTITY, 'not-a-uuid', ['staff.manage']],
        [IDENTITY, ORG, []],
        [IDENTITY, ORG, ['not.a.key']],
        [IDENTITY, ORG, null],
    ];
    for (const [identity, org, permissions] of invalid) {
        await assert.rejects(
            () => withStaffTransaction(pool, identity, org, permissions, () => {}),
            (error) => error instanceof StaffAuthorizationError
                && error.code === 'INVALID_CONTEXT',
        );
    }
    assert.equal(pool.connects, 0);
    assert.equal(client.queries.length, 0);
});

test('resolves principal, checks every permission and commits', async () => {
    const client = makeClient();
    const pool = makePool(client);
    let operationContext;
    const result = await withStaffTransaction(
        pool,
        IDENTITY,
        ORG,
        ['staff.manage', 'roles.manage'],
        async (context) => {
            operationContext = context;
            return 'done';
        },
    );
    assert.equal(result, 'done');
    assert.equal(pool.connects, 1);
    const texts = client.queries.map(({ text }) => text);
    assert.match(texts[0], /^begin isolation level read committed;/);
    assert.match(texts[0], /set local lock_timeout = '2s'/);
    assert.match(texts[0], /set local statement_timeout = '10s'/);
    assert.match(texts[0], /set_config\('app.actor_id', '', true\)/);
    assert.equal(client.queries.length, 5, 'setup, resolve, context, permissions, commit');
    assert.equal(texts.at(-1), 'commit');
    const resolverCall = client.queries.find(({ text }) => text.includes('resolve_staff_principal_v1'));
    assert.deepEqual(resolverCall.params, ['google', 'https://accounts.google.com', '12345', ORG]);
    const permissionCalls = client.queries.filter(({ text }) => text.includes('has_permission_v1'));
    assert.deepEqual(permissionCalls.map(({ params }) => params), [[['staff.manage', 'roles.manage']]]);
    assert.equal(operationContext.principal.userId, PRINCIPAL_ROW.user_id);
    assert.equal(operationContext.principal.membershipId, PRINCIPAL_ROW.membership_id);
    assert.equal(operationContext.principal.roleId, PRINCIPAL_ROW.role_id);
    assert.equal(operationContext.principal.organizationId, ORG);
    assert.match(operationContext.auditId, /^[0-9a-f-]{36}$/);
    assert.match(operationContext.correlationId, /^[0-9a-f-]{36}$/);
    assert.notEqual(operationContext.auditId, operationContext.correlationId);
    assert.deepEqual(client.releases, [null]);
});

test('zero resolver rows raise UNAUTHORIZED and roll back', async () => {
    const client = makeClient({ resolverRows: [] });
    const pool = makePool(client);
    await assert.rejects(
        () => withStaffTransaction(pool, IDENTITY, ORG, ['staff.manage'], () => {}),
        (error) => error.code === 'UNAUTHORIZED',
    );
    const texts = client.queries.map(({ text }) => text);
    assert.ok(texts.includes('rollback'));
    assert.ok(!texts.includes('commit'));
    assert.deepEqual(client.releases, [null]);
});

test('denied permission raises FORBIDDEN and rolls back', async () => {
    const client = makeClient({ allowed: false });
    const pool = makePool(client);
    await assert.rejects(
        () => withStaffTransaction(pool, IDENTITY, ORG, ['staff.manage'], () => {}),
        (error) => error.code === 'FORBIDDEN',
    );
    assert.ok(client.queries.map(({ text }) => text).includes('rollback'));
    assert.deepEqual(client.releases, [null]);
});

test('mixed batched permission outcomes skip the operation', async () => {
    let permissionChecks = 0;
    const client = makeClient({
        onQuery(text) {
            if (text.includes('has_permission_v1')) {
                permissionChecks += 1;
                return { rows: [{ allowed: true }, { allowed: false }] };
            }
            if (text.includes('resolve_staff_principal_v1')) {
                return { rows: [PRINCIPAL_ROW] };
            }
            return { rows: [] };
        },
    });
    const pool = makePool(client);
    let invoked = false;
    await assert.rejects(
        () => withStaffTransaction(
            pool,
            IDENTITY,
            ORG,
            ['candidates.read', 'staff.manage'],
            async () => {
                invoked = true;
            },
        ),
        (error) => error.code === 'FORBIDDEN',
    );
    assert.equal(invoked, false);
    assert.equal(permissionChecks, 1);
    const texts = client.queries.map(({ text }) => text);
    assert.ok(texts.includes('rollback'));
    assert.ok(!texts.includes('commit'));
    assert.deepEqual(client.releases, [null]);
});

test('begin failure rolls back, releases and preserves the original error', async () => {
    const failure = new Error('begin exploded');
    const client = makeClient({
        onQuery(text) {
            if (text.startsWith('begin')) {
                throw failure;
            }
            return { rows: [] };
        },
    });
    const pool = makePool(client);
    await assert.rejects(
        () => withStaffTransaction(pool, IDENTITY, ORG, ['staff.manage'], () => {}),
        (error) => error === failure,
    );
    assert.ok(client.queries.map(({ text }) => text).includes('rollback'));
    assert.deepEqual(client.releases, [null]);
});

test('commit failure rolls back, releases and preserves the original error', async () => {
    const failure = new Error('commit exploded');
    const client = makeClient({
        onQuery(text) {
            if (text === 'commit') {
                throw failure;
            }
            if (text.includes('resolve_staff_principal_v1')) {
                return { rows: [PRINCIPAL_ROW] };
            }
            if (text.includes('has_permission_v1')) {
                return { rows: [{ allowed: true }] };
            }
            return { rows: [] };
        },
    });
    const pool = makePool(client);
    let invoked = false;
    await assert.rejects(
        () => withStaffTransaction(pool, IDENTITY, ORG, ['staff.manage'], async () => {
            invoked = true;
        }),
        (error) => error === failure,
    );
    assert.equal(invoked, true);
    assert.ok(client.queries.map(({ text }) => text).includes('rollback'));
    assert.deepEqual(client.releases, [null]);
});

test('permission query error rolls back and preserves the original error', async () => {
    const failure = new Error('permission check exploded');
    const client = makeClient({
        onQuery(text) {
            if (text.includes('has_permission_v1')) {
                throw failure;
            }
            if (text.includes('resolve_staff_principal_v1')) {
                return { rows: [PRINCIPAL_ROW] };
            }
            return { rows: [] };
        },
    });
    const pool = makePool(client);
    let invoked = false;
    await assert.rejects(
        () => withStaffTransaction(pool, IDENTITY, ORG, ['staff.manage'], async () => {
            invoked = true;
        }),
        (error) => error === failure,
    );
    assert.equal(invoked, false);
    assert.ok(client.queries.map(({ text }) => text).includes('rollback'));
    assert.deepEqual(client.releases, [null]);
});

test('operation failure rolls back, preserves the original error and releases once', async () => {
    const client = makeClient();
    const pool = makePool(client);
    const failure = new Error('operation exploded');
    await assert.rejects(
        () => withStaffTransaction(pool, IDENTITY, ORG, ['staff.manage'], async () => {
            throw failure;
        }),
        (error) => error === failure,
    );
    assert.ok(client.queries.map(({ text }) => text).includes('rollback'));
    assert.deepEqual(client.releases, [null]);
});

test('rollback failure destroys the client while preserving the original error', async () => {
    const client = makeClient({
        onQuery(text) {
            if (text === 'rollback') {
                throw new Error('connection lost');
            }
            if (text.includes('resolve_staff_principal_v1')) {
                return { rows: [PRINCIPAL_ROW] };
            }
            if (text.includes('has_permission_v1')) {
                return { rows: [{ allowed: true }] };
            }
            return { rows: [] };
        },
    });
    const pool = makePool(client);
    const failure = new Error('operation exploded');
    await assert.rejects(
        () => withStaffTransaction(pool, IDENTITY, ORG, ['staff.manage'], async () => {
            throw failure;
        }),
        (error) => error === failure,
    );
    assert.equal(client.releases.length, 1);
    assert.equal(client.releases[0].message, 'connection lost');
});

test('query parameters are never interpolated into SQL text', async () => {
    const client = makeClient();
    const pool = makePool(client);
    await withStaffTransaction(
        pool,
        { provider: 'google', issuer: 'https://accounts.google.com', subject: '777' },
        ORG,
        ['staff.manage'],
        () => {},
    );
    for (const { text } of client.queries) {
        assert.ok(!text.includes('777'), text);
        assert.ok(!text.includes(ORG), text);
    }
    const resolverCall = client.queries.find(({ text }) => text.includes('resolve_staff_principal_v1'));
    assert.equal(resolverCall.params[2], '777');
});

for (const rows of [[], [{ allowed: null }], [{ allowed: 'true' }]]) {
    test(`incomplete or non-boolean permission results fail closed: ${JSON.stringify(rows)}`, async () => {
        const client = makeClient({
            onQuery(text) {
                if (text.includes('resolve_staff_principal_v1')) return { rows: [PRINCIPAL_ROW] };
                if (text.includes('has_permission_v1')) return { rows };
                return { rows: [] };
            },
        });
        await assert.rejects(
            () => withStaffTransaction(makePool(client), IDENTITY, ORG, ['staff.manage'], () => {
                assert.fail('unauthorized operation ran');
            }),
            { code: 'FORBIDDEN' },
        );
        assert.equal(client.queries.at(-1).text, 'rollback');
    });
}

test('actor transactions batch setup and retain the staff role before resolving', async () => {
    const client = makeClient();
    await withStaffActor(makePool(client), IDENTITY, ORG, () => 'done');
    assert.equal(client.queries.length, 4);
    assert.match(client.queries[0].text, /set local role app_staff;/);
    assert.match(client.queries[1].text, /resolve_staff_principal_v1/);
    assert.equal(client.queries.at(-1).text, 'commit');
    assert.deepEqual(client.releases, [null]);
});

test('actor rollback failure destroys the connection and preserves operation error', async () => {
    const original = new Error('operation failed');
    const rollback = new Error('rollback failed');
    const client = makeClient({ onQuery(text) {
        if (text === 'rollback') throw rollback;
        if (text.includes('resolve_staff_principal_v1')) return { rows: [PRINCIPAL_ROW] };
        return { rows: [] };
    } });
    await assert.rejects(
        () => withStaffActor(makePool(client), IDENTITY, ORG, () => { throw original; }),
        (error) => error === original,
    );
    assert.deepEqual(client.releases, [rollback]);
});
