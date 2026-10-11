import assert from 'node:assert/strict';
import test from 'node:test';
import * as nodeModule from 'node:module';
const supported = typeof nodeModule.registerHooks === 'function';
const { installRouteMocks, setRouteStub, stubModule } = supported ? await import('../support/staff-route-mocks.js') : {};
if (!supported) test('source status route requires Node module hooks', { skip: true }, () => {});
if (supported) {
const stubs = new Map();
setRouteStub((specifier, name, args) => stubs.get(`${specifier}:${name}`)(...args));
installRouteMocks();
stubModule('@/lib/staff-api.server', { staffApiContext: 'fn', staffGateResponse: 'fn' });
stubModule('@/lib/telegram-source-update-operations', { telegramSourceUpdateStatus: 'fn' });
stubModule('@/lib/candidate-profile-contracts', { assertUuid: { reexport: new URL('../../src/lib/candidate-profile-contracts.js', import.meta.url).href } });
stubModule('@/lib/client-job-contracts', { ClientJobContractError: { reexport: new URL('../../src/lib/client-job-contracts.js', import.meta.url).href } });
stubModule('@/lib/telegram-intake-http', { telegramFeatureResponse: 'fn', telegramJson: 'fn', telegramErrorResponse: 'fn' });
const { GET } = await import('../../src/app/api/staff/telegram-source-updates/route.ts');
const identity = {}, pool = {};
const chatId = '11111111-1111-4111-8111-111111111111';
const request = () => new Request(`https://example.test/api/staff/telegram-source-updates?chatId=${chatId}`);
function setup({ disabled = false, status = 200, failure = false, resolverFailure = false } = {}) {
    let reads = 0;
    stubs.clear();
    stubs.set('@/lib/candidate-profile-contracts:assertUuid', value => { if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) { const error = new Error('bad UUID'); error.code = 'INVALID'; throw error; } return value.toLowerCase(); });
    stubs.set('@/lib/telegram-intake-http:telegramFeatureResponse', () => disabled ? Response.json({}, { status: 404, headers: { 'cache-control': 'private, no-store' } }) : null);
    stubs.set('@/lib/staff-api.server:staffApiContext', async () => { if (resolverFailure) throw new Error('private auth detail'); return { pool, identity, organizationId: 'org', status }; });
    stubs.set('@/lib/staff-api.server:staffGateResponse', context => context.status === 200 ? null : Response.json({ error: 'denied' }, { status: context.status }));
    stubs.set('@/lib/telegram-source-update-operations:telegramSourceUpdateStatus', async (...args) => { reads++; assert.deepEqual(args, [pool, identity, 'org', [chatId]]); if (failure) throw new Error('private source text'); return [{ chatId: 'chat', status: 'worker_offline' }]; });
    stubs.set('@/lib/telegram-intake-http:telegramJson', body => Response.json(body, { headers: { 'cache-control': 'private, no-store' } }));
    stubs.set('@/lib/telegram-intake-http:telegramErrorResponse', error => Response.json({ error: 'temporarily unavailable' }, { status: error.fieldErrors ? 400 : 503, headers: { 'cache-control': 'private, no-store' } }));
    return () => reads;
}
test('source status returns an authenticated read-only private response', async () => {
    const reads = setup(); const response = await GET(request());
    assert.equal(response.status, 200); assert.equal(reads(), 1);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal((await response.json())[0].status, 'worker_offline');
});
test('feature-off and failed auth or MFA do not read source metadata', async () => {
    for (const configuration of [{ disabled: true }, { status: 401 }, { status: 428 }]) {
        const reads = setup(configuration); const response = await GET(request());
        assert.equal(response.status, configuration.status || 404); assert.equal(reads(), 0);
        assert.equal(response.headers.get('cache-control'), 'private, no-store');
    }
});
test('source status operation errors use the safe private error response', async () => {
    setup({ failure: true }); const response = await GET(request());
    assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal((await response.text()).includes('private source text'), false);
});

test('auth resolver failures are safe private service errors', async () => {
    const reads = setup({ resolverFailure: true }); const response = await GET(request());
    assert.equal(response.status, 503); assert.equal(reads(), 0);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal((await response.text()).includes('private auth detail'), false);
});
test('source status rejects missing, extra, duplicate and over-bound identifiers before database read', async () => {
    for (const query of ['', 'unexpected=1', `chatId=${chatId}&chatId=${chatId}`, Array.from({ length: 51 }, () => `chatId=${chatId}`).join('&'), 'chatId=bad']) {
        const reads = setup(); const response = await GET(new Request(`https://example.test/api/staff/telegram-source-updates?${query}`));
        assert.equal(response.status, 400); assert.equal(reads(), 0);
    }
});
}
