import 'server-only';
import { withStaffTransaction } from './staff-authorization.js';
import { getTotpStatus, reserveMfaAttempt, verifyTotpCode } from './staff-mfa.server.js';
import { StaffOperationsError } from './staff-operations.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function resetStaffMfa(pool, identity, organizationId, input) {
    if (!input || !uuid.test(input.membershipId ?? '') || !Number.isSafeInteger(input.version)
        || input.version < 1 || !['lost_authenticator', 'compromised_device'].includes(input.reason)
        || typeof input.code !== 'string' || !/^\d{6}$/.test(input.code)) {
        throw new StaffOperationsError({ reset: 'Select a member, a reason and enter a six-digit authenticator code.' });
    }
    const retryAfter = await reserveMfaAttempt(pool, identity, organizationId);
    if (retryAfter > 0) throw Object.assign(new Error('Too many attempts'), { code: 'MFA_LIMIT', retryAfter });
    const credential = await getTotpStatus(pool, identity, organizationId);
    const counter = credential?.status === 'active' ? verifyTotpCode(credential.secret, input.code) : null;
    if (counter === null || counter <= credential.lastUsedCounter) {
        throw Object.assign(new Error('Fresh authenticator code required'), { code: 'MFA_INVALID' });
    }
    return withStaffTransaction(pool, identity, organizationId, ['staff.manage'],
        async ({ client, auditId, correlationId }) => (await client.query(
            'select app.reset_staff_mfa_v1($1,$2,$3,$4,$5,$6,$7) as result',
            [input.membershipId, input.version, input.reason, credential.credentialId, counter, auditId, correlationId],
        )).rows[0].result);
}
