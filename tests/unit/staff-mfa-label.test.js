import assert from 'node:assert/strict';
import test from 'node:test';
import { mfaEnrollmentLabel } from '../../src/lib/staff-mfa-label.js';
import { totpUri } from '../../src/lib/totp.js';

test('workspace provisioning labels distinguish accounts without changing credential material', () => {
    const email = 'staff@synthetic.test';
    const first = mfaEnrollmentLabel(email, 'First workspace', true);
    const second = mfaEnrollmentLabel(email, 'Second workspace', true);
    assert.notEqual(first, second);
    const secret = 'JBSWY3DPEHPK3PXP';
    for (const accountName of [first, second]) {
        const uri = new URL(totpUri({ secret, accountName }));
        assert.equal(uri.searchParams.get('secret'), secret);
        assert.equal(uri.searchParams.get('issuer'), 'Agora');
    }
    assert.equal(mfaEnrollmentLabel(email, 'First workspace', false), email);
    assert.equal(mfaEnrollmentLabel(email, null, true), email);
});
