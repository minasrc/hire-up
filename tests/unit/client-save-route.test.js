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
stubModule('@/lib/client-job-operations', { saveClientWithDetails: 'fn' });

const { POST } = await import('../../src/app/api/staff/clients/[clientId]/route.ts');
const id = '97000000-0000-4000-8000-000000000001';
const otherId = '97000000-0000-4000-8000-000000000002';
const fields = { name: 'Saved client' };
const snapshot = {
    id,
    name: 'Saved client',
    contactName: 'Dana Example',
    contactEmail: 'dana@example.test',
    telegramUsername: 'dana_ops',
    website: 'https://example.test',
    socialLinks: [],
    isStealth: false,
    anonymousDescription: null,
    version: '2',
    publicProfileVersion: '2',
    status: 'active',
};
const result = {
    id,
    version: '2',
    publicProfileVersion: '2',
    status: 'active',
    client: snapshot,
};
const verified = { status: 'ok', pool: {}, identity: {}, organizationId: otherId };

function setup({ context = verified, operationError = null } = {}) {
    const calls = [];
    stubs.clear();
    stubs.set('@/lib/staff-api.server:staffApiContext', async () => context);
    stubs.set('@/lib/staff-api.server:staffGateResponse', (value) => value.status === 'ok'
        ? null
        : Response.json({ error: 'denied' }, { status: value.responseStatus }));
    stubs.set('@/lib/staff-api.server:staffErrorResponse', (error) => Response.json(
        { error: 'operation rejected' },
        { status: error.code === 'FORBIDDEN' ? 403 : 409 },
    ));
    stubs.set('@/lib/client-job-operations:saveClientWithDetails', async (...args) => {
        calls.push(args);
        if (operationError) throw operationError;
        return result;
    });
    return calls;
}

const request = () => new Request(`http://localhost/api/staff/clients/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: otherId, expectedVersion: '1', fields }),
});

const invoke = () => POST(request(), { params: Promise.resolve({ clientId: id }) });

test('client save route returns the authorized snapshot without caching', async () => {
    const calls = setup();
    const response = await invoke();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(await response.json(), { ok: true, result });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], verified.pool);
    assert.equal(calls[0][1], verified.identity);
    assert.equal(calls[0][2], verified.organizationId);
    assert.equal(calls[0][3].clientId, id);
    assert.equal(calls[0][3].expectedVersion, '1');
    assert.deepEqual(calls[0][3].fields, fields);
    assert.match(calls[0][3].operationId, /^[0-9a-f-]{36}$/);
});

test('client save route preserves staff gates without running the operation', async () => {
    for (const status of [401, 428, 503]) {
        const calls = setup({ context: { status: 'denied', responseStatus: status } });
        const response = await invoke();
        assert.equal(response.status, status);
        assert.equal(response.headers.get('cache-control'), 'private, no-store');
        assert.deepEqual(calls, []);
    }
});

for (const [code, status] of [['FORBIDDEN', 403], ['40001', 409]]) {
    test(`client save route maps ${code} without returning client data`, async () => {
        const calls = setup({ operationError: Object.assign(new Error('private client'), { code }) });
        const response = await invoke();
        assert.equal(response.status, status);
        assert.equal(response.headers.get('cache-control'), 'private, no-store');
        assert.ok(!(await response.text()).includes('client'));
        assert.equal(calls.length, 1);
    });
}
