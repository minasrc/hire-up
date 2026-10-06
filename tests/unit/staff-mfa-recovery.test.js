import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../../src/lib/staff-mfa-recovery.server.js', import.meta.url), 'utf8')
    .replace(/^import .*;$/gm, '').replace('export async function', 'async function');
const valid = { membershipId: '00000000-0000-4000-8000-000000000001', version: 1, reason: 'lost_authenticator', code: '123456' };
function service({ retry = 0, credential = { status: 'active', credentialId: 'credential', secret: 'secret', lastUsedCounter: 41 }, counter = 42, databaseError } = {}) {
    const calls = [];
    const context = vm.createContext({
        StaffOperationsError: class extends Error {},
        reserveMfaAttempt: async () => { calls.push('reserve'); return retry; },
        getTotpStatus: async () => credential,
        verifyTotpCode: () => counter,
        withStaffTransaction: async (pool, identity, org, permissions, operation) => {
            calls.push({ permissions });
            return operation({ auditId: 'audit', correlationId: 'correlation', client: { query: async (sql, params) => {
                calls.push({ sql, params });
                if (databaseError) throw databaseError;
                return { rows: [{ result: 'reset' }] };
            } } });
        },
    });
    vm.runInContext(source, context);
    return { run: (input = valid) => context.resetStaffMfa({}, {}, 'org', input), calls };
}
test('invalid reset input never consumes the MFA budget or reaches the database', async () => {
    for (const input of [null, { ...valid, version: -1 }, { ...valid, membershipId: 'bad' }, { ...valid, reason: 'bad' }, { ...valid, code: 'backup-code' }]) {
        const s = service(); await assert.rejects(s.run(input)); assert.equal(s.calls.length, 0);
    }
});
test('reset requires a fresh active authenticator and rejects replays before a write', async () => {
    for (const options of [{ credential: null }, { credential: { status: 'pending' } }, { counter: null }, { counter: 41 }]) {
        const s = service(options);
        await assert.rejects(s.run(), { code: 'MFA_INVALID' });
        assert.deepEqual(s.calls, ['reserve']);
    }
});
test('attempt limit prevents code reads and reset writes', async () => {
    const s = service({ retry: 123 });
    await assert.rejects(s.run(), { code: 'MFA_LIMIT', retryAfter: 123 });
    assert.deepEqual(s.calls, ['reserve']);
});
test('reset sends only validated input under staff-management permission in one transaction', async () => {
    const s = service(); assert.equal(await s.run(), 'reset');
    assert.deepEqual(Array.from(s.calls[1].permissions), ['staff.manage']);
    assert.deepEqual(Array.from(s.calls[2].params), [valid.membershipId, 1, 'lost_authenticator', 'credential', 42, 'audit', 'correlation']);
    assert.match(s.calls[2].sql, /reset_staff_mfa_v1\(\$1,\$2,\$3,\$4,\$5,\$6,\$7\)/);
});
test('database failures propagate without pretending recovery completed', async () => {
    const s = service({ databaseError: Object.assign(new Error('outage'), { code: '08006' }) });
    await assert.rejects(s.run(), { code: '08006' });
});
