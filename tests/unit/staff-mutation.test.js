import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const load = (respond) => {
    const exports = {};
    const dispatched = [];
    runInNewContext(ts.transpileModule(
        readFileSync(
            new URL('../../src/lib/staff-mutation.ts', import.meta.url), 'utf8'),
        {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
            },
        },
    ).outputText, {
        exports,
        fetch: respond,
        window: { dispatchEvent: (event) => dispatched.push(event) },
        Event,
        CustomEvent,
    });
    return { exports, dispatched };
};

const jsonResponse = (status, body) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
});

test('a 400 with field errors carries only string entries and a human message', async () => {
    const { exports, dispatched } = load(async () => jsonResponse(400, {
        error: 'invalid input',
        fields: {
            telegramUsername: 'must be a valid Telegram username',
            'socialLinks[0].url': 'must be a LinkedIn URL',
            nested: { bad: true },
            count: 3,
        },
    }));
    const error = await exports.staffMutation('/api/staff/clients', {})
        .then(() => null, (caught) => caught);
    assert.ok(error instanceof exports.StaffMutationError);
    assert.equal(error.name, 'StaffMutationError');
    assert.equal(error.status, 400);
    assert.equal(
        error.message, 'Some fields need attention. Please check your entries.');
    assert.deepEqual({ ...error.fieldErrors }, {
        telegramUsername: 'must be a valid Telegram username',
        'socialLinks[0].url': 'must be a LinkedIn URL',
    });
    assert.doesNotMatch(error.message, /socialLinks\[|telegramUsername/);
    assert.equal(dispatched.length, 0);
});

test('auth and conflict failures keep their existing messages', async () => {
    for (const [status, message] of [
        [401, 'Your session expired. Sign in again.'],
        [428, 'Your session expired. Sign in again.'],
        [403, 'You do not have permission to make this change.'],
        [409, 'This record changed. Reload and try again.'],
    ]) {
        const { exports } = load(async () => jsonResponse(status, {}));
        const error = await exports.staffMutation('/api/staff/tasks', {})
            .then(() => null, (caught) => caught);
        assert.ok(error instanceof exports.StaffMutationError);
        assert.equal(error.status, status);
        assert.equal(error.message, message);
        assert.deepEqual({ ...error.fieldErrors }, {});
    }
});

test('a non-JSON error body falls back to the generic message', async () => {
    const { exports } = load(
        async () => new Response('<html>proxy error</html>', { status: 502 }));
    const error = await exports.staffMutation('/api/staff/clients', {})
        .then(() => null, (caught) => caught);
    assert.ok(error instanceof exports.StaffMutationError);
    assert.equal(error.status, 502);
    assert.equal(error.message, 'Could not save. Please try again.');
    assert.deepEqual({ ...error.fieldErrors }, {});
});

test('a payload code survives on the error', async () => {
    const { exports } = load(async () => jsonResponse(409, { code: '23505' }));
    const error = await exports.staffMutation('/api/staff/clients', {})
        .then(() => null, (caught) => caught);
    assert.equal(error.code, '23505');
    assert.equal(error.message, 'This record changed. Reload and try again.');
});

test('a success returns the payload and dispatches the update event', async () => {
    const { exports, dispatched } = load(
        async () => jsonResponse(200, { ok: true, result: { id: 'x' } }));
    const payload = await exports.staffMutation('/api/staff/clients', {});
    assert.deepEqual({ ...payload }, { ok: true, result: { id: 'x' } });
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].type, 'staff-workspace-updated');
    assert.equal(dispatched[0].detail.scope, 'workspace');
});


test('a task mutation identifies its scope without dropping the workspace event', async () => {
    const { exports, dispatched } = load(
        async () => jsonResponse(200, { ok: true, result: { id: 'task' } }));
    await exports.staffMutation('/api/staff/tasks', { action: 'setCompleted' });
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].type, 'staff-workspace-updated');
    assert.equal(dispatched[0].detail.scope, 'tasks');
});
