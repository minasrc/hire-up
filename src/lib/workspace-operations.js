import { randomUUID } from 'node:crypto';
import {
    StaffAuthorizationError,
    withStaffActor,
    withStaffTransaction,
} from './staff-authorization.js';
import { StaffOperationsError } from './staff-operations.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BIGINT_PATTERN = /^[0-9]{1,19}$/;
const BIGINT_MAX = 9223372036854775807n;
export const STAFF_TASK_CATEGORIES = new Set(['review', 'interviews', 'notes']);

const TASK_READ_PERMISSIONS = ['collaboration.read'];
const TASK_WRITE_PERMISSIONS = ['collaboration.read', 'collaboration.write'];

const invalidInput = (fieldErrors) => new StaffOperationsError(fieldErrors);

const requireRecord = (input, name, allowedKeys) => {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        throw invalidInput({ input: `${name} must be a plain object` });
    }
    for (const key of Object.keys(input)) {
        if (!allowedKeys.includes(key)) {
            throw invalidInput({ [key]: 'unknown key' });
        }
    }
    return input;
};

const requireUuid = (value, name) => {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
        throw invalidInput({ [name]: 'must be a UUID' });
    }
    return value;
};

const requireVersion = (value, name) => {
    if (typeof value !== 'string' || !BIGINT_PATTERN.test(value)) {
        throw invalidInput({ [name]: 'must be a positive bigint string' });
    }
    const parsed = BigInt(value);
    if (parsed < 1n || parsed > BIGINT_MAX) {
        throw invalidInput({ [name]: 'must be a positive bigint string' });
    }
    return value;
};

const requireBoolean = (value, name) => {
    if (typeof value !== 'boolean') {
        throw invalidInput({ [name]: 'must be a boolean' });
    }
    return value;
};

const optionalCategory = (value, name) => {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value !== 'string' || !STAFF_TASK_CATEGORIES.has(value)) {
        throw invalidInput({ [name]: 'must be review, interviews or notes' });
    }
    return value;
};

const requireTitle = (value, name) => {
    const title = typeof value === 'string' ? value.trim() : '';
    if (!title || title.length > 256) {
        throw invalidInput({ [name]: 'required, at most 256 characters' });
    }
    return title;
};

const optionalInteger = (value, name, min, max, fallback) => {
    if (value === null || value === undefined) {
        return fallback;
    }
    if (!Number.isInteger(value) || value < min || value > max) {
        throw invalidInput({ [name]: `must be an integer between ${min} and ${max}` });
    }
    return value;
};

const run = (pool, verifiedIdentity, organizationId, permissions, sql, params) =>
    withStaffTransaction(
        pool,
        verifiedIdentity,
        organizationId,
        permissions,
        async ({ client }) => {
            const result = await client.query(sql, params);
            return result.rows[0]?.result ?? null;
        },
    );

export async function getStaffCapabilities(pool, verifiedIdentity, organizationId) {
    return withStaffActor(
        pool,
        verifiedIdentity,
        organizationId,
        async ({ client }) => {
            const result = await client.query(
                'select app.get_staff_capabilities_v1() as result');
            return result.rows[0]?.result ?? null;
        },
    );
}

export async function getStaffWorkspace(pool, verifiedIdentity, organizationId) {
    return withStaffActor(
        pool,
        verifiedIdentity,
        organizationId,
        async ({ client }) => {
            const result = await client.query(
                'select app.get_staff_workspace_v1() as result');
            return result.rows[0]?.result ?? null;
        },
    );
}

export async function listStaffTasks(pool, verifiedIdentity, organizationId, input = {}) {
    const record = requireRecord(
        input, 'input', ['completed', 'category', 'limit', 'offset']);
    const completed = record.completed === undefined
        ? false
        : requireBoolean(record.completed, 'completed');
    const category = optionalCategory(record.category, 'category');
    const limit = optionalInteger(record.limit, 'limit', 1, 100, 20);
    const offset = optionalInteger(record.offset, 'offset', 0, 100000, 0);
    return run(
        pool, verifiedIdentity, organizationId, TASK_READ_PERMISSIONS,
        'select app.list_staff_tasks_v1($1::boolean, $2::text, $3::integer, $4::integer)'
            + ' as result',
        [completed, category, limit, offset],
    );
}

export async function createStaffTask(pool, verifiedIdentity, organizationId, input) {
    const record = requireRecord(input, 'input', ['taskId', 'title', 'category']);
    const taskId = requireUuid(record.taskId, 'taskId');
    const title = requireTitle(record.title, 'title');
    const category = optionalCategory(record.category, 'category');
    if (category === null) {
        throw invalidInput({ category: 'must be review, interviews or notes' });
    }
    return run(
        pool, verifiedIdentity, organizationId, TASK_WRITE_PERMISSIONS,
        'select app.create_staff_task_v1($1::uuid, $2::text, $3::text, $4::uuid,'
            + ' $5::uuid) as result',
        [taskId, title, category, randomUUID(), randomUUID()],
    );
}

export async function setStaffTaskCompleted(pool, verifiedIdentity, organizationId, input) {
    const record = requireRecord(
        input, 'input', ['taskId', 'completed', 'expectedVersion']);
    const taskId = requireUuid(record.taskId, 'taskId');
    const completed = requireBoolean(record.completed, 'completed');
    const expectedVersion = requireVersion(record.expectedVersion, 'expectedVersion');
    return run(
        pool, verifiedIdentity, organizationId, TASK_WRITE_PERMISSIONS,
        'select app.set_staff_task_completed_v1($1::uuid, $2::boolean, $3::bigint,'
            + ' $4::uuid, $5::uuid) as result',
        [taskId, completed, expectedVersion, randomUUID(), randomUUID()],
    );
}

export { StaffAuthorizationError };
