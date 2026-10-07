import { randomUUID } from 'node:crypto';

const KNOWN_PERMISSION_KEYS = new Set([
    'applications.read',
    'applications.stage',
    'audit.read',
    'candidates.merge',
    'candidates.read',
    'candidates.write',
    'clients.read',
    'clients.write',
    'collaboration.read',
    'collaboration.write',
    'data.export',
    'documents.download',
    'documents.write',
    'duplicates.review',
    'jobs.read',
    'jobs.write',
    'organization.manage',
    'pipelines.manage',
    'privacy.manage',
    'roles.manage',
    'staff.manage',
]);

// Static commands use one simple-protocol exchange. Keep untrusted values in
// the parameterized statements below, after the transaction context is cleared.
const TRANSACTION_SETUP = `begin isolation level read committed;
    set local lock_timeout = '2s';
    set local statement_timeout = '10s';
    select
        pg_catalog.set_config('app.actor_id', '', true),
        pg_catalog.set_config('app.organization_id', '', true),
        pg_catalog.set_config('app.identity_provider', '', true),
        pg_catalog.set_config('app.identity_issuer', '', true),
        pg_catalog.set_config('app.identity_subject', '', true);`;

export const STAFF_PROVIDER = 'google';
export const STAFF_ISSUER = 'https://accounts.google.com';
const SUBJECT_PATTERN = /^[1-9][0-9]{0,20}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class StaffAuthorizationError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'StaffAuthorizationError';
        this.code = code;
    }
}

export async function withStaffTransaction(
    pool,
    verifiedIdentity,
    organizationId,
    requiredPermissions,
    operation,
) {
    if (!verifiedIdentity
        || verifiedIdentity.provider !== STAFF_PROVIDER
        || verifiedIdentity.issuer !== STAFF_ISSUER
        || typeof verifiedIdentity.subject !== 'string'
        || !SUBJECT_PATTERN.test(verifiedIdentity.subject)) {
        throw new StaffAuthorizationError(
            'INVALID_CONTEXT',
            'verifiedIdentity must be a server-verified supported provider subject',
        );
    }
    if (typeof organizationId !== 'string' || !UUID_PATTERN.test(organizationId)) {
        throw new StaffAuthorizationError('INVALID_CONTEXT', 'organizationId must be a UUID');
    }
    if (!Array.isArray(requiredPermissions)
        || requiredPermissions.length === 0
        || requiredPermissions.some((key) => !KNOWN_PERMISSION_KEYS.has(key))) {
        throw new StaffAuthorizationError(
            'INVALID_CONTEXT',
            'requiredPermissions must be a nonempty array of catalog permission keys',
        );
    }
    if (typeof operation !== 'function') {
        throw new StaffAuthorizationError('INVALID_CONTEXT', 'operation must be a function');
    }

    const client = await pool.connect();
    let released = false;
    const release = (error) => {
        if (!released) {
            released = true;
            client.release(error);
        }
    };

    try {
        await client.query(TRANSACTION_SETUP);
        const resolved = await client.query(
            'select user_id, membership_id, role_id'
                + ' from app.resolve_staff_principal_v1($1, $2, $3, $4)',
            [
                verifiedIdentity.provider,
                verifiedIdentity.issuer,
                verifiedIdentity.subject,
                organizationId,
            ],
        );
        if (resolved.rows.length !== 1) {
            throw new StaffAuthorizationError(
                'UNAUTHORIZED',
                'identity does not resolve to an active staff membership',
            );
        }
        const principal = resolved.rows[0];
        await client.query(
            `select
                pg_catalog.set_config('app.actor_id', $1, true),
                pg_catalog.set_config('app.organization_id', $2, true)`,
            [principal.user_id, organizationId],
        );
        const permissions = await client.query(
            `select app.has_permission_v1(permission.key) as allowed
             from pg_catalog.unnest($1::text[]) as permission(key)`,
            [requiredPermissions],
        );
        if (permissions.rows.length !== requiredPermissions.length
            || permissions.rows.some(({ allowed }) => allowed !== true)) {
            throw new StaffAuthorizationError(
                'FORBIDDEN',
                'a required permission is not granted',
            );
        }
        const result = await operation({
            client,
            principal: {
                userId: principal.user_id,
                membershipId: principal.membership_id,
                roleId: principal.role_id,
                organizationId,
            },
            auditId: randomUUID(),
            correlationId: randomUUID(),
        });
        await client.query('commit');
        release();
        return result;
    } catch (error) {
        let rollbackError;
        try {
            await client.query('rollback');
        } catch (caught) {
            rollbackError = caught;
        }
        release(rollbackError);
        throw error;
    }
}

// Resolve the identity to a principal AND install the trusted actor context
// (app.actor_id / app.organization_id) for the duration of one transaction.
// Unlike withStaffTransaction this performs no permission check — it exists
// for self-service operations whose procedures assert only an active
// membership (TOTP enrollment/verification).
export async function withStaffActor(pool, identity, organizationId, operation) {
    if (!identity
        || identity.provider !== STAFF_PROVIDER
        || identity.issuer !== STAFF_ISSUER
        || typeof identity.subject !== 'string'
        || !SUBJECT_PATTERN.test(identity.subject)) {
        throw new StaffAuthorizationError(
            'INVALID_CONTEXT',
            'identity must be a server-verified supported provider subject',
        );
    }
    if (typeof organizationId !== 'string' || !UUID_PATTERN.test(organizationId)) {
        throw new StaffAuthorizationError('INVALID_CONTEXT', 'organizationId must be a UUID');
    }
    if (typeof operation !== 'function') {
        throw new StaffAuthorizationError('INVALID_CONTEXT', 'operation must be a function');
    }

    const client = await pool.connect();
    let releaseError;
    try {
        await client.query(`${TRANSACTION_SETUP} set local role app_staff;`);
        const resolved = await client.query(
            'select user_id, membership_id, role_id'
                + ' from app.resolve_staff_principal_v1($1, $2, $3, $4)',
            [identity.provider, identity.issuer, identity.subject, organizationId],
        );
        if (resolved.rows.length !== 1) {
            throw new StaffAuthorizationError(
                'UNAUTHORIZED',
                'identity does not resolve to an active staff membership',
            );
        }
        const principal = resolved.rows[0];
        await client.query(
            `select
                pg_catalog.set_config('app.actor_id', $1, true),
                pg_catalog.set_config('app.organization_id', $2, true)`,
            [principal.user_id, organizationId],
        );
        const result = await operation({
            client,
            principal: {
                userId: principal.user_id,
                membershipId: principal.membership_id,
                roleId: principal.role_id,
                organizationId,
            },
            auditId: randomUUID(),
            correlationId: randomUUID(),
        });
        await client.query('commit');
        return result;
    } catch (error) {
        await client.query('rollback').catch((error) => { releaseError = error; });
        throw error;
    } finally {
        client.release(releaseError);
    }
}
