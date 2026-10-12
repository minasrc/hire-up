import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { hostedControlInput, hostedStaffInput } from '../../src/lib/telegram-hosted-contracts.js';
import { telegramHostedAuthorized, telegramHostedConfiguration, telegramHostedErrorResponse, telegramHostedFeatureResponse, telegramHostedJson } from '../../src/lib/telegram-hosted-http.js';
import { readTelegramJson } from '../../src/lib/telegram-intake-http.js';
import { telegramHostedControl } from '../../src/lib/telegram-hosted-operations.js';
const instanceId = randomUUID(), leaseToken = randomUUID();
test('hosted contracts forbid browser scope, plaintext credentials and unknown control fields', () => {
    assert.deepEqual(hostedStaffInput({ action: 'prepare' }), { action: 'prepare' });
    for (const extra of ['organizationId', 'ownerUserId', 'token', 'workerId']) assert.throws(() => hostedStaffInput({ action: 'prepare', [extra]: randomUUID() }));
    for (const action of ['heartbeat', 'list', 'register']) {
        const p = { action, instanceId, ...(action === 'heartbeat' ? {} : { leaseToken }), ...(action === 'register' ? { requestId: randomUUID(), workerId: randomUUID(), tokenSha256: 'a'.repeat(64) } : {}) };
        assert.deepEqual(hostedControlInput(p), p); assert.throws(() => hostedControlInput({ ...p, token: 'secret' }));
    }
    assert.throws(() => hostedControlInput({ action: 'list', instanceId }));
    assert.throws(() => hostedControlInput({ action: 'heartbeat', instanceId, leaseToken: null }));
});
test('both flags and configured operator secrets are required; authorization rejects browser origin', () => {
    assert.equal(telegramHostedFeatureResponse({ TELEGRAM_HOSTED_ENABLED: '1' }).status, 404);
    assert.equal(telegramHostedFeatureResponse({ TELEGRAM_HOSTED_ENABLED: '1', TELEGRAM_INTAKE_ENABLED: '1' }), null);
    assert.throws(() => telegramHostedConfiguration({}), /SERVICE_UNAVAILABLE/);
    const secret = 'a'.repeat(64);
    const request = headers => new Request('https://example.com/api/telegram-hosted/control', { headers });
    assert(telegramHostedAuthorized(request({ authorization: `Bearer ${secret}` }), secret));
    assert(!telegramHostedAuthorized(request({ authorization: `Bearer ${'b'.repeat(64)}` }), secret));
    assert(!telegramHostedAuthorized(request({ authorization: `Bearer ${secret}`, origin: 'https://example.com' }), secret));
});
test('hosted transport bounds payloads and redacts SQL/secrets from failures', async () => {
    const secret = 'do-not-expose-me';
    const response = telegramHostedErrorResponse(Object.assign(new Error(secret), { code: '40001', detail: secret }));
    assert.equal(response.status, 409); assert(!(await response.text()).includes(secret));
    assert.equal(telegramHostedJson({ giant: 'x'.repeat(16384) }).status, 503);
    await assert.rejects(readTelegramJson(new Request('https://example.com', { method: 'POST', body: JSON.stringify({ x: 'x'.repeat(2048) }) }), 2048));
});
test('hosted control uses configured service scope and exact role, rolls back failures', async () => {
    const calls = [], service = randomUUID(); let released = false;
    const pool = { connect: async () => ({ query: async (sql, args) => { calls.push({ sql, args }); if (args) throw Object.assign(new Error('private'), { code: '40001' }); return {}; }, release: () => { released = true; } }) };
    await assert.rejects(telegramHostedControl(pool, service, { action: 'list', instanceId, leaseToken }), { code: '40001' });
    assert.match(calls[0].sql, /set local role app_telegram_hosted_service/);
    assert.deepEqual(calls[1].args, [service, instanceId, leaseToken, null]);
    assert.equal(calls[2].sql, 'rollback'); assert(released);
});
