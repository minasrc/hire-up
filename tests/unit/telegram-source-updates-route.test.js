import assert from 'node:assert/strict';
import test from 'node:test';
import { installRouteMocks, setRouteStub, stubModule } from '../support/staff-route-mocks.js';
const stubs = new Map();
setRouteStub((specifier, name, args) => stubs.get(`${specifier}:${name}`)(...args));
installRouteMocks();
stubModule('@/lib/staff-api.server', { staffApiContext: 'fn', staffGateResponse: 'fn' });
stubModule('@/lib/telegram-source-update-operations', { telegramSourceUpdateStatus: 'fn' });
stubModule('@/lib/telegram-intake-http', { telegramFeatureResponse: 'fn', telegramJson: 'fn', telegramErrorResponse: 'fn' });
const { GET } = await import('../../src/app/api/staff/telegram-source-updates/route.ts');
const identity = {}, pool = {};
function setup({ disabled = false, status = 200, failure = false } = {}) {
    let reads = 0;
    stubs.clear();
    stubs.set('@/lib/telegram-intake-http:telegramFeatureResponse', () => disabled ? Response.json({}, { status: 404, headers: { 'cache-control': 'private, no-store' } }) : null);
    stubs.set('@/lib/staff-api.server:staffApiContext', async () => ({ pool, identity, organizationId: 'org', status }));
    stubs.set('@/lib/staff-api.server:staffGateResponse', context => context.status === 200 ? null : Response.json({ error: 'denied' }, { status: context.status }));
    stubs.set('@/lib/telegram-source-update-operations:telegramSourceUpdateStatus', async (...args) => { reads++; assert.deepEqual(args, [pool, identity, 'org']); if (failure) throw new Error('private source text'); return [{ chatId: 'chat', status: 'worker_offline' }]; });
    stubs.set('@/lib/telegram-intake-http:telegramJson', body => Response.json(body, { headers: { 'cache-control': 'private, no-store' } }));
    stubs.set('@/lib/telegram-intake-http:telegramErrorResponse', () => Response.json({ error: 'temporarily unavailable' }, { status: 503, headers: { 'cache-control': 'private, no-store' } }));
    return () => reads;
}
test('source status returns an authenticated read-only private response', async () => {
    const reads = setup(); const response = await GET();
    assert.equal(response.status, 200); assert.equal(reads(), 1);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal((await response.json())[0].status, 'worker_offline');
});
test('feature-off and failed auth or MFA do not read source metadata', async () => {
    for (const configuration of [{ disabled: true }, { status: 401 }, { status: 428 }]) {
        const reads = setup(configuration); const response = await GET();
        assert.equal(response.status, configuration.status || 404); assert.equal(reads(), 0);
        assert.equal(response.headers.get('cache-control'), 'private, no-store');
    }
});
test('source status operation errors use the safe private error response', async () => {
    setup({ failure: true }); const response = await GET();
    assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal((await response.text()).includes('private source text'), false);
});
