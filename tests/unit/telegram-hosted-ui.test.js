import assert from 'node:assert/strict';
import test from 'node:test';
import { hostedConnectionError, hostedStatus, prepareHostedConnection, hostedRequestError, hostedEmergencyLogout } from '../../src/app/staff/telegram-intake/connect/hosted-connection-model.js';

const workerId = '00000000-0000-4000-8000-000000000001';
const pending = { serviceOnline: true, state: 'pending', workerId: null, workerOnline: false, errorCode: null };
const ready = { ...pending, state: 'ready', workerId, workerOnline: true };
function setup(options = {}) {
    const calls = [];
    const controller = new AbortController();
    return { calls, controller, input: {
        prepare: async () => { calls.push('prepare'); return pending; },
        read: async () => { calls.push('read'); return ready; },
        wait: async () => { calls.push('wait'); },
        start: async id => { calls.push(['start', id]); },
        onStatus: status => calls.push(['status', status.state]),
        signal: controller.signal,
        ...options,
    } };
}

test('one explicit setup prepares then connects only when service and assigned worker are ready', async () => {
    const { calls, input } = setup();
    await prepareHostedConnection(input);
    assert.deepEqual(calls, ['prepare', ['status', 'pending'], 'wait', 'read', ['status', 'ready'], ['start', workerId]]);
});

test('service ready alone cannot authorize sign-in with an offline or missing worker', async () => {
    let time = 0;
    const { calls, input } = setup({ prepare: async () => ({ ...ready, workerOnline: false }),
        read: async () => ({ ...ready, workerId: null }), now: () => time, timeoutMs: 3,
        wait: async () => { time += 1; },
    });
    await assert.rejects(prepareHostedConnection(input), /taking longer/);
    assert.equal(calls.some(call => Array.isArray(call) && call[0] === 'start'), false);
});

test('offline, unavailable and malformed responses fail honestly without connecting', async () => {
    for (const value of [{ ...ready, serviceOnline: false }, { ...ready, state: 'unavailable' }, { ...ready, workerId: 'unsafe' }, { ...ready, state: 'invented' }]) {
        const { input, calls } = setup({ prepare: async () => value });
        await assert.rejects(prepareHostedConnection(input), /offline|unavailable/);
        assert.equal(calls.some(call => Array.isArray(call) && call[0] === 'start'), false);
    }
    assert.throws(() => hostedStatus({ ...ready, serviceOnline: 'true' }), /unavailable/);
});

test('cancellation during provisioning cannot restart when a late ready response arrives', async () => {
    const { controller, input, calls } = setup();
    input.read = async () => { controller.abort(); return ready; };
    await assert.rejects(prepareHostedConnection(input), { name: 'AbortError' });
    assert.equal(calls.some(call => Array.isArray(call) && call[0] === 'start'), false);
});

test('hidden setup pauses the final sign-in start and expires without starting', async () => {
    let time = 0;
    const { input, calls } = setup({ prepare: async () => ready, visible: () => false,
        now: () => time, timeoutMs: 1, wait: async () => { time += 2; },
    });
    await assert.rejects(prepareHostedConnection(input), /taking longer/);
    assert.equal(calls.some(call => Array.isArray(call) && call[0] === 'start'), false);
});

test('a fresh explicit retry can start after an earlier provisioning failure', async () => {
    const failed = setup({ prepare: async () => { throw new Error('Synthetic failure'); } });
    await assert.rejects(prepareHostedConnection(failed.input), /failure/);
    const retry = setup({ prepare: async () => ready });
    await prepareHostedConnection(retry.input);
    assert.deepEqual(retry.calls.at(-1), ['start', workerId]);
});

test('hosted error copy is fixed and does not expose provider strings or device setup', () => {
    for (const code of ['SESSION_MISSING', 'TELEGRAM_UNAVAILABLE', 'LOGOUT_FAILED']) assert.equal(/Mac|token|credential/i.test(hostedConnectionError(code)), false);
    assert.equal(hostedConnectionError('private provider sentinel'), null);
});

test('a ready response arriving after the setup deadline cannot start sign-in', async () => {
    let time = 0;
    const { input, calls } = setup({ now: () => time, timeoutMs: 10,
        prepare: async () => { time = 11; return ready; },
    });
    await assert.rejects(prepareHostedConnection(input), /taking longer/);
    assert.equal(calls.some(call => Array.isArray(call) && call[0] === 'start'), false);
});

test('hosted capacity has actionable fixed copy without trusting provider detail', () => {
    assert.match(hostedRequestError(429, { code: 'HOSTED_CAPACITY', error: 'private sentinel' }), /connection capacity/);
    assert.doesNotMatch(hostedRequestError(429, { code: 'HOSTED_CAPACITY', error: 'private sentinel' }), /sentinel/);
    assert.match(hostedRequestError(429, { code: 'other' }), /temporarily unavailable/);
});

test('hosted offline and pending logout expose emergency revocation without waiting for an error', () => {
    assert.equal(hostedEmergencyLogout({ status: 'connected' }, { serviceOnline: false, workerOnline: false }), true);
    assert.equal(hostedEmergencyLogout({ status: 'connected' }, { serviceOnline: true, workerOnline: false }), true);
    assert.equal(hostedEmergencyLogout({ status: 'disconnecting' }, { serviceOnline: true, workerOnline: true }), true);
    assert.equal(hostedEmergencyLogout({ status: 'connected' }, ready), false);
    assert.equal(hostedEmergencyLogout({ status: 'failed' }, { serviceOnline: false, workerOnline: false }), true);
    assert.equal(hostedEmergencyLogout({ status: 'disconnected' }, null), false);
});
