import assert from 'node:assert/strict';
import test from 'node:test';
import { stubModule, setRouteStub, installRouteMocks } from '../support/staff-route-mocks.js';

stubModule('@/lib/staff-api.server', { staffApiContext: 'fn', staffGateResponse: 'fn', staffErrorResponse: 'fn' });
stubModule('@/lib/staff-mfa-http.server', { mfaJson: 'fn' });
stubModule('@/lib/staff-mfa-recovery.server', { resetStaffMfa: 'fn' });
installRouteMocks();
const { POST } = await import('../../src/app/api/staff/members/mfa-reset/route.ts');
const request = (origin) => new Request('http://localhost/api/staff/members/mfa-reset', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify({ code: '123456' }),
});
function mocks({ denied, error } = {}) {
    const calls = [];
    setRouteStub((module, name, args) => {
        calls.push(name);
        if (name === 'staffApiContext') return { status: denied ? 'denied' : 'ok', pool: {}, identity: {}, organizationId: 'org' };
        if (name === 'staffGateResponse') return denied ? Response.json({}, { status: denied }) : null;
        if (name === 'resetStaffMfa') { if (error) throw error; return {}; }
        if (name === 'mfaJson') return Response.json(args[0], { status: args[1] ?? 200, headers: args[2] });
        if (name === 'staffErrorResponse') {
            if (['42501', '40001', '23514', 'P0002'].includes(args[0].code)) return Response.json({}, { status: { '42501': 403, '40001': 409, '23514': 422, P0002: 404 }[args[0].code] });
            throw args[0];
        }
        assert.fail(`Unexpected ${module} ${name}`);
    });
    return calls;
}
test('cross-origin resets are rejected before authentication or writes', async () => {
    const calls = mocks(); assert.equal((await POST(request('https://other.example'))).status, 403); assert.deepEqual(calls, ['mfaJson']);
});
for (const denied of [401, 428, 503]) test(`reset requires a verified staff context (${denied})`, async () => {
    const calls = mocks({ denied }); assert.equal((await POST(request())).status, denied); assert.ok(!calls.includes('resetStaffMfa'));
});
test('reset succeeds only after the server recovery operation completes', async () => {
    const calls = mocks(); assert.equal((await POST(request('http://localhost'))).status, 200); assert.deepEqual(calls, ['staffApiContext', 'staffGateResponse', 'resetStaffMfa', 'mfaJson']);
});
for (const [code, expected] of [['MFA_INVALID', 401], ['MFA_LIMIT', 429], ['42501', 403], ['40001', 409], ['23514', 422], ['P0002', 404], ['08006', 503]]) test(`reset handles ${code} without a success response`, async () => {
    mocks({ error: Object.assign(new Error('failure'), { code, retryAfter: 123 }) });
    const response = await POST(request()); assert.equal(response.status, expected);
    if (code === 'MFA_LIMIT') assert.equal(response.headers.get('retry-after'), '123');
});
