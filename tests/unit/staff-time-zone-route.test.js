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
stubModule('@/lib/staff-preferences', { saveStaffTimeZone: 'fn' });
stubModule('@/lib/staff-request-origin', { staffRequestOriginAllowed: 'fn' });

const route = await import('../../src/app/api/staff/preferences/time-zone/route.ts');
const verified = { status: 'ok', pool: {}, identity: {}, organizationId: 'org', principal: { user_id: 'account-a' } };

function setup({ context = verified, allowed = true, failure = null } = {}) {
    const calls = [];
    stubs.clear();
    stubs.set('@/lib/staff-request-origin:staffRequestOriginAllowed', () => allowed);
    stubs.set('@/lib/staff-api.server:staffApiContext', async () => context);
    stubs.set('@/lib/staff-api.server:staffGateResponse', value => value.status === 'ok'
        ? null : Response.json({ error: 'denied' }, { status: value.responseStatus }));
    stubs.set('@/lib/staff-api.server:staffErrorResponse', error => {
        if (error.code === 'INVALID_INPUT') return Response.json({ error: 'invalid input' }, { status: 400 });
        if (error.code === '40001') return Response.json({ error: 'conflict' }, { status: 409 });
        throw error;
    });
    stubs.set('@/lib/staff-preferences:saveStaffTimeZone', async (...args) => {
        calls.push(args);
        if (failure) throw failure;
        return { timeZone: 'Europe/Madrid', version: '2' };
    });
    return calls;
}

const request = (origin = 'http://localhost') => new Request('http://localhost/api/staff/preferences/time-zone', {
    method: 'POST', headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ timeZone: 'Europe/Madrid', expectedVersion: '1' }),
});

const privateHeader = response => assert.equal(
    response.headers.get('cache-control'), 'private, no-store');

test('time zone route exposes only POST and returns the preference DTO privately', async () => {
    assert.equal(route.GET, undefined);
    const calls = setup();
    const response = await route.POST(request());
    assert.equal(response.status, 200);
    privateHeader(response);
    assert.deepEqual(await response.json(), {
        ok: true, result: { timeZone: 'Europe/Madrid', version: '2' },
    });
    assert.deepEqual(calls[0], [verified.pool, verified.identity, verified.organizationId,
        { timeZone: 'Europe/Madrid', expectedVersion: '1' }]);
});

test('account mismatch is a private conflict and never selects another actor', async () => {
    const calls = setup();
    const mismatched = request();
    mismatched.headers.set('x-staff-account-id', 'account-b');
    let response = await route.POST(mismatched);
    assert.equal(response.status, 409);
    privateHeader(response);
    assert.deepEqual(await response.json(), { error: 'account changed', code: 'ACCOUNT_CHANGED' });
    assert.deepEqual(calls, []);
    const matching = request();
    matching.headers.set('x-staff-account-id', 'account-a');
    response = await route.POST(matching);
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
});

test('cross-origin and gated requests never save and remain private', async () => {
    let calls = setup({ allowed: false });
    let response = await route.POST(request('https://other.example'));
    assert.equal(response.status, 403);
    privateHeader(response);
    assert.deepEqual(calls, []);
    for (const status of [401, 428, 503]) {
        calls = setup({ context: { status: 'denied', responseStatus: status } });
        response = await route.POST(request());
        assert.equal(response.status, status);
        privateHeader(response);
        assert.deepEqual(calls, []);
    }
});

test('staff context failures stay private and never save', async () => {
    const calls = setup();
    stubs.set('@/lib/staff-api.server:staffApiContext', async () => {
        throw new Error('private identity');
    });
    const response = await route.POST(request());
    assert.equal(response.status, 503);
    privateHeader(response);
    assert.deepEqual(calls, []);
    assert.ok(!(await response.text()).includes('private identity'));
});

for (const [code, status] of [['INVALID_INPUT', 400], ['40001', 409]]) {
    test(`${code} is mapped without preference data`, async () => {
        setup({ failure: Object.assign(new Error('private preference'), { code }) });
        const response = await route.POST(request());
        assert.equal(response.status, status);
        privateHeader(response);
        assert.ok(!(await response.text()).includes('Europe/Madrid'));
    });
}

for (const code of ['08006', '42883']) {
    test(`unexpected ${code} failures return private 503 without leaking payloads`, async () => {
        setup({ failure: Object.assign(new Error('private preference'), { code }) });
        const logs = [];
        const original = console.error;
        console.error = (...args) => logs.push(args);
        let response;
        try { response = await route.POST(request()); }
        finally { console.error = original; }
        assert.equal(response.status, 503);
        privateHeader(response);
        assert.ok(!(await response.text()).includes('private preference'));
        assert.ok(!JSON.stringify(logs).includes('private preference'));
    });
}
