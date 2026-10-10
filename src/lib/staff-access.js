import { StaffAuthorizationError, withStaffActor } from './staff-authorization.js';

// One fresh transaction resolves membership and reads the acting member's MFA
// credential. This is server-side data only; it must never be serialized.
export async function readStaffAccess(pool, identity, organizationId) {
    try {
        return await withStaffActor(pool, identity, organizationId, async ({ client, principal }) => {
            const { rows } = await client.query(
                `select nullif(pg_catalog.current_setting('app.staff_time_zone', true), '') as time_zone,
                    coalesce(nullif(pg_catalog.current_setting('app.staff_time_zone_version', true), ''), '0') as time_zone_version,
                    t.credential_id, t.status, t.secret, t.last_used_counter
                 from (values (1)) requested(n)
                 left join lateral app.totp_status_v1() t on true`,
            );
            const row = rows[0];
            return {
                principal: {
                    user_id: principal.userId,
                    membership_id: principal.membershipId,
                    role_id: principal.roleId,
                    time_zone: row?.time_zone ?? null,
                    time_zone_version: row?.time_zone_version ?? '0',
                },
                totp: row?.credential_id ? {
                    credentialId: row.credential_id,
                    status: row.status,
                    secret: row.secret,
                    lastUsedCounter: Number(row.last_used_counter),
                } : null,
            };
        });
    } catch (error) {
        if (error instanceof StaffAuthorizationError && error.code === 'UNAUTHORIZED') return null;
        throw error;
    }
}
