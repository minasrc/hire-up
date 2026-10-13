import assert from 'node:assert/strict';
import test from 'node:test';
import { signStaffWorkspace, readStaffWorkspace } from '../../src/lib/staff-workspace-cookie.js';

const secret = 'synthetic-workspace-signing-secret', subject = '123456789';
const organizationId = '11111111-1111-4111-8111-111111111111';
const now = Date.parse('2026-10-13T00:00:00Z');
test('workspace selection is signed, bound to the Google account, and expires within its session', () => {
    const value = signStaffWorkspace(secret, subject, organizationId, now + 3600000, now);
    assert.equal(readStaffWorkspace(secret, value, subject, now), organizationId);
    assert.equal(readStaffWorkspace(secret, value, '9999', now), null);
    assert.equal(readStaffWorkspace('other-secret', value, subject, now), null);
    assert.equal(readStaffWorkspace(secret, value, subject, now + 3600000), null);
    const [body, mac] = value.split('.');
    const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), organizationId: '99999999-9999-4999-8999-999999999999' })).toString('base64url');
    assert.equal(readStaffWorkspace(secret, `${tampered}.${mac}`, subject, now), null);
});
test('invalid and oversized workspace cookies fail closed', () => {
    for (const value of [null, '', 'a.b', 'a'.repeat(1025), '..', '%%%.' + 'a'.repeat(43)]) assert.equal(readStaffWorkspace(secret, value, subject, now), null);
    assert.throws(() => signStaffWorkspace(secret, subject, 'not-a-uuid', now + 1, now));
    assert.throws(() => signStaffWorkspace(secret, subject, organizationId, now, now));
});
