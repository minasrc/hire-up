import 'server-only';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

let staffPool;

// Lazily creates the staff-runtime pool. Returns null when the staff workspace
// is not configured, so callers can fail closed rather than crash.
export function getStaffPool() {
    const connectionString = process.env.STAFF_DATABASE_URL;
    if (!connectionString) {
        return null;
    }
    if (!staffPool) {
        staffPool = new pg.Pool({
            connectionString,
            max: 2,
            idleTimeoutMillis: 10_000,
            connectionTimeoutMillis: 5_000,
            statement_timeout: 10_000,
            query_timeout: 11_000,
            lock_timeout: 2_000,
        });
        // Idle connection failures must not become uncaught process errors.
        staffPool.on('error', (error) => console.error('staff database connection failed', error));
    }
    return staffPool;
}

// Resolves a verified Google identity to a staff principal via
// app.resolve_staff_principal_v1, executed under the app_staff runtime role.
// Returns null when the identity is unknown, unverified, inactive, or revoked.
export async function resolveStaffPrincipal(pool, identity, organizationId) {
    const client = await pool.connect();
    try {
        await client.query('begin');
        await client.query('set local role app_staff');
        const result = await client.query(
            `select user_id, membership_id, role_id
               from app.resolve_staff_principal_v1($1, $2, $3, $4)`,
            [identity.provider, identity.issuer, identity.subject, organizationId],
        );
        await client.query('commit');
        return result.rows[0] ?? null;
    } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

// Binds a first sign-in's verified Google subject to a pending invite whose
// invited_email matches, via app.claim_staff_invite_v1. The claimer has no
// active membership yet, so the transaction installs only the organization
// context — the procedure asserts the rest. Returns the principal triple on
// claim, null when no matching invite exists.
export async function claimStaffInvite(pool, identity, email, organizationId) {
    const client = await pool.connect();
    try {
        await client.query('begin isolation level read committed');
        await client.query(`set local lock_timeout = '2s'`);
        await client.query(`set local statement_timeout = '10s'`);
        await client.query('set local role app_staff');
        await client.query(
            `select
                pg_catalog.set_config('app.actor_id', '', true),
                pg_catalog.set_config('app.organization_id', $1, true)`,
            [organizationId],
        );
        const result = await client.query(
            `select user_id, membership_id, role_id
               from app.claim_staff_invite_v1($1, $2, $3, $4, $5, $6, $7)`,
            [
                randomUUID(), identity.provider, identity.issuer, identity.subject,
                email, randomUUID(), randomUUID(),
            ],
        );
        await client.query('commit');
        return result.rows[0] ?? null;
    } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

// Canonical staff-principal lookup: resolve the bound identity first; on a
// miss, try to claim a pending invite keyed by the session's verified email,
// then re-resolve through the resolver so role/status rules stay centralized.
export async function resolveOrClaimStaffPrincipal(pool, identity, email, organizationId) {
    const resolved = await resolveStaffPrincipal(pool, identity, organizationId);
    if (resolved || !email) {
        return resolved;
    }
    await claimStaffInvite(pool, identity, email, organizationId);
    // Another request may have consumed the invitation while this one waited.
    // Re-resolve even on a zero-row claim so that request can still proceed.
    return resolveStaffPrincipal(pool, identity, organizationId);
}


