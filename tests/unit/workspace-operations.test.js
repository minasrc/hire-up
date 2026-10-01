import assert from 'node:assert/strict';
import test from 'node:test';

import { StaffOperationsError } from '../../src/lib/staff-operations.js';
import {
    StaffAuthorizationError,
    createStaffTask,
    getStaffWorkspace,
    getStaffCapabilities,
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
