import assert from 'node:assert/strict';
import test from 'node:test';

import { StaffOperationsError } from '../../src/lib/staff-operations.js';
import {
    StaffAuthorizationError,
    createStaffTask,
    getStaffWorkspace,
    getStaffCapabilities,
    getStaffNotifications,
    listStaffTasks,
    setStaffTaskCompleted,
} from '../../src/lib/workspace-operations.js';

const UUID = '00000000-0000-4000-8000-000000000001';

const lockedPool = {
    connect() {
        throw new Error('pool.connect must not run for invalid input');
    },
};

const rejectsField = (promise, field, messagePart) => assert.rejects(
    promise,
    (error) => error instanceof StaffOperationsError
        && String(error.fieldErrors[field] ?? '').includes(messagePart),
);

test('listStaffTasks validates filters before opening a transaction', async () => {
    await rejectsField(
        listStaffTasks(lockedPool, null, null, { limit: 0 }),
        'limit', 'integer between 1 and 100',
    );
    await rejectsField(
        listStaffTasks(lockedPool, null, null, { limit: 101 }),
        'limit', 'integer between 1 and 100',
    );
    await rejectsField(
        listStaffTasks(lockedPool, null, null, { limit: 1.5 }),
        'limit', 'integer',
    );
    await rejectsField(
        listStaffTasks(lockedPool, null, null, { offset: -1 }),
        'offset', 'integer between 0 and 100000',
    );
    await rejectsField(
        listStaffTasks(lockedPool, null, null, { offset: 100001 }),
        'offset', 'integer between 0 and 100000',
    );
    await rejectsField(
        listStaffTasks(lockedPool, null, null, { category: 'bogus' }),
        'category', 'review, interviews or notes',
    );
    await rejectsField(
        listStaffTasks(lockedPool, null, null, { completed: 'yes' }),
        'completed', 'boolean',
    );
    await rejectsField(
        listStaffTasks(lockedPool, null, null, { unknown: true }),
        'unknown', 'unknown key',
    );
    await rejectsField(
        listStaffTasks(lockedPool, null, null, 'nope'),
        'input', 'plain object',
    );
});

test('createStaffTask validates id, title and category', async () => {
    await rejectsField(
        createStaffTask(lockedPool, null, null, {
            taskId: 'not-a-uuid', title: 'x', category: 'review',
        }),
        'taskId', 'UUID',
    );
    await rejectsField(
        createStaffTask(lockedPool, null, null, {
            taskId: UUID, title: '   ', category: 'review',
        }),
        'title', 'required',
    );
    await rejectsField(
        createStaffTask(lockedPool, null, null, {
            taskId: UUID, title: 'x'.repeat(257), category: 'review',
        }),
        'title', '256',
    );
    await rejectsField(
        createStaffTask(lockedPool, null, null, {
            taskId: UUID, title: 'x', category: 'bogus',
        }),
        'category', 'review, interviews or notes',
    );
    await rejectsField(
        createStaffTask(lockedPool, null, null, {
            taskId: UUID, title: 'x', category: null,
        }),
        'category', 'review, interviews or notes',
    );
    await rejectsField(
        createStaffTask(lockedPool, null, null, {
            taskId: UUID, title: 'x', category: 'review', extra: 1,
        }),
        'extra', 'unknown key',
    );
});

test('setStaffTaskCompleted validates ids, flag and expected version', async () => {
    const base = { taskId: UUID, completed: true, expectedVersion: '1' };
    await rejectsField(
        setStaffTaskCompleted(lockedPool, null, null, { ...base, taskId: 'x' }),
        'taskId', 'UUID',
    );
    await rejectsField(
        setStaffTaskCompleted(lockedPool, null, null, { ...base, completed: 'true' }),
        'completed', 'boolean',
    );
    for (const expectedVersion of ['0', 'abc', '9223372036854775808', 1, null]) {
        await rejectsField(
            setStaffTaskCompleted(lockedPool, null, null, { ...base, expectedVersion }),
            'expectedVersion', 'bigint',
        );
    }
});

test('getStaffWorkspace rejects invalid context before touching the pool', async () => {
    await assert.rejects(
        getStaffWorkspace(lockedPool, null, UUID),
        (error) => error instanceof StaffAuthorizationError
            && error.code === 'INVALID_CONTEXT',
    );
    await assert.rejects(
        getStaffWorkspace(lockedPool, {
            provider: 'google',
            issuer: 'https://accounts.google.com',
            subject: '1002',
        }, 'not-a-uuid'),
        (error) => error instanceof StaffAuthorizationError
            && error.code === 'INVALID_CONTEXT',
    );
    await assert.rejects(
        getStaffWorkspace(lockedPool, {
            provider: 'github',
            issuer: 'https://accounts.google.com',
            subject: '1002',
        }, UUID),
        (error) => error instanceof StaffAuthorizationError
            && error.code === 'INVALID_CONTEXT',
    );
});

test('capabilities require a verified identity before acquiring a connection', async () => {
    await assert.rejects(getStaffCapabilities(lockedPool, null, UUID), { code: 'INVALID_CONTEXT' });
});

test('notifications require a verified identity before acquiring a connection', async () => {
    await assert.rejects(getStaffNotifications(lockedPool, null, UUID), {
        code: 'INVALID_CONTEXT',
    });
});

test('all workspace payloads gate Telegram by feature flag and exact candidate permissions', async () => {
    const previous = process.env.TELEGRAM_INTAKE_ENABLED;
    const identity = { provider: 'google', issuer: 'https://accounts.google.com', subject: '123' };
    try {
        for (const flag of [undefined, '0', 'true', '1']) {
            if (flag === undefined) delete process.env.TELEGRAM_INTAKE_ENABLED;
            else process.env.TELEGRAM_INTAKE_ENABLED = flag;
            for (const read of [false, true]) for (const write of [false, true]) {
                for (const operation of [getStaffCapabilities, getStaffWorkspace, getStaffNotifications]) {
                    const queries = [];
                    const capabilities = { candidates: read, jobs: true };
                    const pool = { connect: async () => ({
                        release() {},
                        async query(sql) {
                            queries.push(sql);
                            if (sql.includes('resolve_staff_principal_v1')) return { rows: [{ user_id: UUID }] };
                            if (sql.includes('has_permission_v1')) {
                                assert.match(sql, /has_permission_v1\('candidates.read'\)/);
                                assert.match(sql, /and app.has_permission_v1\('candidates.write'\)/);
                                return { rows: [{ allowed: read && write }] };
                            }
                            if (sql.includes('get_staff_')) return { rows: [{ result:
                                operation === getStaffCapabilities ? capabilities : { capabilities, attention: { openTasks: 2 } },
                            }] };
                            return { rows: [] };
                        },
                    }) };
                    const result = await operation(pool, identity, UUID);
                    const actual = operation === getStaffCapabilities ? result : result.capabilities;
                    assert.deepEqual(actual, { ...capabilities, telegram: flag === '1' && read && write });
                    assert.equal(queries.filter(sql => sql.includes('has_permission_v1')).length, flag === '1' ? 1 : 0);
                    assert.ok(queries[0].includes('set local role app_staff'));
                    assert.equal(queries.at(-1), 'commit');
                }
            }
        }
    } finally {
        if (previous === undefined) delete process.env.TELEGRAM_INTAKE_ENABLED;
        else process.env.TELEGRAM_INTAKE_ENABLED = previous;
    }
});
