import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from './auth-options';
import { staffIdentityFromSession, staffInviteEmailFromSession } from './staff-identity';
import { getStaffPool, resolveOrClaimStaffAccess } from './staff-db.server';
import { staffGoogleCredentialStatus } from './staff-google.server';
import { staffWorkspaceContext, multiWorkspaceEnabled } from './staff-workspace-context.server.js';
import { listStaffWorkspaces } from './staff-workspace-directory.js';
import { STAFF_MFA_COOKIE, readStaffMfaProof } from './staff-mfa-cookie';

/**
 * @typedef {{ provider: string, issuer: string, subject: string }} StaffGateIdentity
 * @typedef {{ user_id: string, membership_id: string, role_id: string, workspace_name?: string | null, time_zone?: string | null, time_zone_version?: string }} StaffGatePrincipal
 * @typedef {import('next-auth').Session} StaffGateSession
 * @typedef {import('pg').Pool} StaffGatePool
 * @typedef {{ status: string, credentialId?: string, secret?: string } | null} StaffGateTotp
 * @typedef {{ stage: 'resolved' | 'mfa-pending' | 'verified', session: StaffGateSession,
 *   identity: StaffGateIdentity, principal: StaffGatePrincipal, totp: StaffGateTotp,
 *   pool: StaffGatePool, organizationId: string }} StaffGateResolved
 * @typedef {{ stage: 'signed-out' }
 *   | { stage: 'workspace-required' } | { stage: 'reauthenticate' } | { stage: 'unavailable' }
 *   | { stage: 'unresolved', session: StaffGateSession, identity: StaffGateIdentity }
 *   | StaffGateResolved} StaffGateResult
 */

// React cache shares this result only within one server render. API mutations
// continue using their uncached staffApiContext and fresh transaction checks.
// One server-side gate for every staff surface. Stages:
//   signed-out   → no session or non-Google provider
//   reauthenticate → Google credential needs renewal
//   unavailable  → workspace access could not be checked
//   unresolved   → Google identity with no active staff membership
//   resolved     → active principal, but TOTP not yet active
//   mfa-pending  → active credential without a valid staff_mfa proof
//   verified     → full gate satisfied (session + principal + MFA proof)
/** @returns {Promise<StaffGateResult>} */
async function resolveStaffGate() {
    const session = await getServerSession(authOptions);
    const identity = staffIdentityFromSession(session);
    if (!identity) {
        return { stage: 'signed-out' };
    }

    // A suspended/deleted Google account must lose access on its next staff
    // request, not when the session expires. 'unknown' fails open — a Google
    // outage must not lock out the workspace — while 'revoked' fails closed.
    if (await staffGoogleCredentialStatus(identity.subject) === 'revoked') {
        return { stage: 'reauthenticate' };
    }

    const pool = getStaffPool();
    const workspace = await staffWorkspaceContext(identity);
    if (workspace.status === 'workspace-required') return { stage: 'workspace-required' };
    const organizationId = workspace.organizationId;
    if (!pool || !organizationId || !process.env.NEXTAUTH_SECRET) {
        return { stage: 'unavailable' };
    }

    let principal = null;
    let totp = null;
    try {
        const access = await resolveOrClaimStaffAccess(
            pool, identity, staffInviteEmailFromSession(session), organizationId);
        principal = access?.principal ?? null;
        totp = access?.totp ?? null;
    } catch (error) {
        if (error?.code === '42501' || error?.code === '23505') {
            return { stage: 'unresolved', session, identity };
        }
        console.error('staff gate resolution failed', error);
        return { stage: 'unavailable' };
    }
    if (!principal) {
        if (multiWorkspaceEnabled()) {
            try {
                const workspaces = await listStaffWorkspaces(pool, identity, staffInviteEmailFromSession(session));
                if (workspaces.length) return { stage: 'workspace-required' };
            } catch { return { stage: 'unavailable' }; }
        }
        return { stage: 'unresolved', session, identity };
    }

    const base = { session, identity, principal, totp, pool, organizationId };
    if (!totp || totp.status !== 'active') {
        return { stage: 'resolved', ...base };
    }
    const cookieStore = await cookies();
    const proof = readStaffMfaProof(
        process.env.NEXTAUTH_SECRET,
        cookieStore.get(STAFF_MFA_COOKIE)?.value,
        {
            subject: identity.subject,
            userId: principal.user_id,
            credentialId: totp.credentialId,
        },
    );
    return { stage: proof ? 'verified' : 'mfa-pending', ...base };
}

export const staffGate = cache(resolveStaffGate);

// Enforces the full gate for data-bearing staff pages; throws redirect() for
// any stage that is not 'verified'.
/** @returns {Promise<StaffGateResolved & { stage: 'verified' }>} */
export async function requireStaffVerified() {
    const gate = await staffGate();
    if (gate.stage === 'unavailable') {
        redirect('/staff/unavailable');
    }
    if (gate.stage === 'signed-out' || gate.stage === 'reauthenticate') {
        redirect('/staff/sign-in');
    }
    if (gate.stage === 'workspace-required') redirect('/staff/workspaces');
    if (gate.stage === 'unresolved') {
        redirect('/staff/no-access');
    }
    if (gate.stage === 'resolved') {
        redirect('/staff/mfa/enroll');
    }
    if (gate.stage === 'mfa-pending') {
        redirect('/staff/mfa/verify');
    }
    return gate;
}
