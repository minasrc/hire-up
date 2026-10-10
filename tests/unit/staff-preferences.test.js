import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { saveStaffTimeZone } from '../../src/lib/staff-preferences.js';
import { StaffOperationsError } from '../../src/lib/staff-operations.js';

const identity = { provider: 'google', issuer: 'https://accounts.google.com', subject: '1001' };
const org = '97000000-0000-4000-8000-000000000001';
const lockedPool = { connect: () => { throw new Error('must not connect'); } };

for (const input of [null, [], { timeZone: 'UTC', expectedVersion: '0', userId: randomUUID() },
    { timeZone: 'Invalid/Zone', expectedVersion: '0' },
    { timeZone: 'UTC', expectedVersion: 0 },
    { timeZone: 'UTC', expectedVersion: '-1' },
    { timeZone: 'UTC', expectedVersion: '9223372036854775808' }]) {
    test(`invalid preference input fails before connecting: ${JSON.stringify(input)}`, async () => {
        await assert.rejects(
            saveStaffTimeZone(lockedPool, identity, org, input),
            error => error instanceof StaffOperationsError,
        );
    });
}

function poolFixture() {
    const statements = [];
    const auditId = randomUUID();
    const correlationId = randomUUID();
    const pool = { connect: async () => ({
        release: () => {},
        query: async (text, params) => {
            statements.push({ text, params });
            if (text.includes('resolve_staff_principal_v1')) return { rows: [{
                user_id: randomUUID(), membership_id: randomUUID(), role_id: randomUUID(),
            }] };
            if (text.includes('set_staff_time_zone_v1')) return { rows: [{
                result: { timeZone: params[0], version: '1' },
            }] };
            return { rows: [] };
        },
    }) };
    return { auditId, correlationId, pool, statements };
}

test('valid aliases are canonicalized and saved through the exact self-service procedure', async () => {
    const fixture = poolFixture();
    const result = await saveStaffTimeZone(fixture.pool, identity, org, {
        timeZone: 'US/Eastern', expectedVersion: '0',
    });
    assert.deepEqual(result, { timeZone: 'America/New_York', version: '1' });
    const call = fixture.statements.find(({ text }) => text.includes('set_staff_time_zone_v1'));
    assert.equal(call.text, 'select app.set_staff_time_zone_v1($1::text,$2::bigint,$3::uuid,$4::uuid) as result');
    assert.equal(call.params[0], 'America/New_York');
    assert.equal(call.params[1], '0');
    assert.match(call.params[2], /^[0-9a-f-]{36}$/);
    assert.match(call.params[3], /^[0-9a-f-]{36}$/);
});

test('null clears the preference without accepting a target user', async () => {
    const fixture = poolFixture();
    const result = await saveStaffTimeZone(fixture.pool, identity, org, {
        timeZone: null, expectedVersion: '0',
    });
    assert.deepEqual(result, { timeZone: null, version: '1' });
});
