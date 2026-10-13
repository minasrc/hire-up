import 'server-only';
import { staffWorkspaceContext } from './staff-workspace-context.server.js';
import { cookies } from 'next/headers';
import { getServerSession } from 'next-auth';
import { authOptions } from './auth-options';
import { staffIdentityFromSession, staffInviteEmailFromSession } from './staff-identity';
import { getStaffPool, resolveOrClaimStaffAccess } from './staff-db.server';
import { staffGoogleCredentialStatus } from './staff-google.server';
import { StaffOperationsError } from './staff-operations';
import { STAFF_MFA_COOKIE, readStaffMfaProof } from './staff-mfa-cookie';
import { ClientJobContractError } from './client-job-contracts';
import { StaffAuthorizationError } from './staff-authorization';

// Staff API boundary: session + resolved principal + active TOTP credential +
// a valid staff_mfa proof. Data-bearing routes must not run without all four.
/** @param {{ expectedWorkspaceId?: string | null }} [options] */
export async function staffApiContext({ expectedWorkspaceId = null } = {}) {
    const session = await getServerSession(authOptions);
    const identity = staffIdentityFromSession(session);
    if (!identity) {
        return { status: 'unauthorized' };
    }
    const pool = getStaffPool();
    const workspace = await staffWorkspaceContext(identity, { api: true, expectedWorkspaceId });
    if (workspace.status !== 'ok') return workspace;
    const organizationId = workspace.organizationId;
    const secret = process.env.NEXTAUTH_SECRET;
    if (!pool || !organizationId || !secret) {
        return { status: 'unconfigured' };
    }
    // Same Google-credential revalidation as the page gate: a suspended
    // account is denied on the next API call, not at next sign-in.
    if (await staffGoogleCredentialStatus(identity.subject) === 'revoked') {
        return { status: 'unauthorized' };
    }
    let principal;
    let totp;
    try {
        const access = await resolveOrClaimStaffAccess(
            pool, identity, staffInviteEmailFromSession(session), organizationId);
        principal = access?.principal ?? null;
        if (!principal) {
            return { status: 'unauthorized' };
        }
        totp = access.totp;
        if (!totp || totp.status !== 'active') {
            return { status: 'mfa-required' };
        }
    } catch (error) {
        if (error?.code === '42501' || error?.code === '23505') {
            return { status: 'unauthorized' };
        }
        console.error('staff API resolution failed', error);
        return { status: 'unavailable' };
    }
    const cookieStore = await cookies();
    const proof = readStaffMfaProof(
        secret,
        cookieStore.get(STAFF_MFA_COOKIE)?.value,
        {
            subject: identity.subject,
            userId: principal.user_id,
            credentialId: totp.credentialId,
        },
    );
    if (!proof) {
        return { status: 'mfa-required' };
    }
    return { status: 'ok', session, identity, principal, pool, organizationId };
}

export function staffGateResponse(context) {
    if (context.status === 'ok') {
        return null;
    }
    if (context.status === 'workspace-changed' || context.status === 'workspace-required') {
        return Response.json({ error: 'Workspace changed. Choose a workspace to continue.', code: 'WORKSPACE_CHANGED' },
            { status: 409, headers: { 'cache-control': 'private, no-store', 'x-staff-workspace-changed': '1' } });
    }
    if (context.status === 'unconfigured' || context.status === 'unavailable') {
        return Response.json({ error: 'workspace temporarily unavailable' }, { status: 503 });
    }
    if (context.status === 'mfa-required') {
        return Response.json({ error: 'mfa required' }, { status: 428 });
    }
    return Response.json({ error: 'unauthorized' }, { status: 401 });
}

// Maps the contract/authorization/database error vocabulary onto HTTP.
export function staffErrorResponse(error) {
    if (error instanceof ClientJobContractError
        || error instanceof StaffOperationsError) {
        return Response.json(
            { error: 'invalid input', fields: error.fieldErrors }, { status: 400 });
    }
    if (error instanceof StaffAuthorizationError) {
        const status = error.code === 'FORBIDDEN' ? 403 : 401;
        return Response.json({ error: error.code.toLowerCase() }, { status });
    }
    const mapped = {
        '22023': 400, '23505': 409, '23514': 422, '40001': 409,
        '42501': 403, P0002: 404,
    };
    if (typeof error?.code === 'string' && error.code in mapped) {
        return Response.json({ error: 'operation rejected', code: error.code }, { status: mapped[error.code] });
    }
    throw error;
}
