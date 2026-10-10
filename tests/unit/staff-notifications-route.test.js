import assert from 'node:assert/strict';
import test from 'node:test';

import { installRouteMocks, setRouteStub, stubModule } from '../support/staff-route-mocks.js';

const stubs = new Map();
setRouteStub((specifier, name, args) => {
    const handler = stubs.get(`${specifier}:${name}`);
    if (!handler) throw new Error(`unstubbed route dependency ${specifier}:${name}`);
    return handler(...args);
});
installRouteMocks();
stubModule('@/lib/staff-api.server', {
    staffApiContext: 'fn', staffGateResponse: 'fn', staffErrorResponse: 'fn',
});
stubModule('@/lib/workspace-operations', {
    getStaffNotifications: 'fn', getStaffWorkspace: 'fn',
});

const { GET } = await import('../../src/app/api/staff/workspace/route.ts');
const result = {
    capabilities: { jobs: true },
    attention: { openTasks: 2, reviewApplications: null, pendingInvites: null },
};
const verified = { status: 'ok', pool: {}, identity: {}, organizationId: 'organization-a' };

function setup({ context = verified, operationError = null } = {}) {
    const calls = [];
    stubs.clear();
    stubs.set('@/lib/staff-api.server:staffApiContext', async () => context);
    stubs.set('@/lib/staff-api.server:staffGateResponse', (value) => value.status === 'ok'
        ? null
        : Response.json({ error: 'denied' }, { status: value.responseStatus }));
    stubs.set('@/lib/staff-api.server:staffErrorResponse', (error) => {
        if (error.code === '42501') {
            return Response.json({ error: 'operation rejected' }, { status: 403 });
        }
        throw error;
    });
    stubs.set('@/lib/workspace-operations:getStaffNotifications', async (...args) => {
        calls.push(['notifications', args]);
        if (operationError) throw operationError;
        return result;
    });
    stubs.set('@/lib/workspace-operations:getStaffWorkspace', async () => {
        calls.push(['dashboard']);
        assert.fail('dashboard workspace must not be queried');
    });
    return calls;
}

const assertPrivate = (response) => {
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
};

const assertNoPrivateData = async (response) => {
    assert.ok(!(await response.clone().text()).includes('private record'));
};

test('workspace compatibility route returns only lightweight notifications', async () => {
    const calls = setup();
    const response = await GET();
    assert.equal(response.status, 200);
    assertPrivate(response);
    assert.deepEqual(await response.json(), { ok: true, result });
    assert.deepEqual(calls, [['notifications', [
        verified.pool, verified.identity, verified.organizationId,
    ]]]);
});

test('workspace compatibility route preserves denied gates without reading data', async () => {
    for (const status of [401, 403, 428]) {
        const calls = setup({ context: { status: 'denied', responseStatus: status } });
        const response = await GET();
        assert.equal(response.status, status);
        assertPrivate(response);
        assert.deepEqual(calls, []);
    }
});

test('workspace compatibility route fails closed when context resolution fails', async () => {
    const calls = setup();
    stubs.set('@/lib/staff-api.server:staffApiContext', async () => {
        throw new Error('private record');
    });
    const response = await GET();
    assert.equal(response.status, 503);
    assertPrivate(response);
    await assertNoPrivateData(response);
    assert.deepEqual(calls, []);
});

test('workspace compatibility route maps authorization failures without private data', async () => {
    const calls = setup({
        operationError: Object.assign(new Error('private record'), { code: '42501' }),
    });
    const response = await GET();
    assert.equal(response.status, 403);
    assertPrivate(response);
    await assertNoPrivateData(response);
    assert.equal(calls.filter(([name]) => name === 'notifications').length, 1);
    assert.ok(!calls.some(([name]) => name === 'dashboard'));
});

test('workspace compatibility route hides unexpected database failures', async () => {
    const calls = setup({
        operationError: Object.assign(new Error('private record'), { code: '08006' }),
    });
    const logs = [];
    const originalError = console.error;
    console.error = (...args) => logs.push(args);
    let response;
    try {
        response = await GET();
    } finally {
        console.error = originalError;
    }
    assert.equal(response.status, 503);
    assertPrivate(response);
    await assertNoPrivateData(response);
    assert.equal(calls.filter(([name]) => name === 'notifications').length, 1);
    assert.ok(!calls.some(([name]) => name === 'dashboard'));
    assert.ok(!JSON.stringify(logs).includes('private record'));
});
