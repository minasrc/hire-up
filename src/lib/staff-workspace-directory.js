import { StaffAuthorizationError, STAFF_PROVIDER, STAFF_ISSUER } from './staff-authorization.js';

// This pre-MFA directory returns the caller's membership/invitation labels
// only. It cannot read business records or MFA credentials.
export async function listStaffWorkspaces(pool, identity, email) {
    if (!identity || identity.provider !== STAFF_PROVIDER || identity.issuer !== STAFF_ISSUER
        || !/^[1-9][0-9]{0,20}$/.test(identity.subject ?? '')) {
        throw new StaffAuthorizationError('UNAUTHORIZED', 'Verified Google identity required.');
    }
    const client = await pool.connect();
    try {
        await client.query('begin; set local role app_staff');
        const result = await client.query('select app.staff_workspace_directory_v1($1,$2,$3,$4) result',
            [identity.provider, identity.issuer, identity.subject, email ?? null]);
        await client.query('commit');
        return result.rows[0].result;
    } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
    } finally { client.release(); }
}
