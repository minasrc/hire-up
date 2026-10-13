import 'server-only';
import { staffRequestOriginAllowed } from './staff-request-origin.js';
import { staffWorkspaceContext } from './staff-workspace-context.server.js';
import { cookies } from 'next/headers';
import { getServerSession } from 'next-auth';
import { authOptions } from './auth-options';
import { staffIdentityFromSession } from './staff-identity';
import { getStaffPool, resolveStaffPrincipal } from './staff-db.server';
import { staffGoogleCredentialStatus } from './staff-google.server';
import { reserveMfaAttempt } from './staff-mfa.server';
import { STAFF_MFA_COOKIE, STAFF_MFA_TTL_MS, createStaffMfaProof } from './staff-mfa-cookie';

export const mfaJson = (body, status = 200, headers = {}) => Response.json(body, {
    status, headers: { 'cache-control': 'no-store', ...headers },
});

export async function staffMfaContext(request) {
    if (!staffRequestOriginAllowed(request)) {
        return { denied: mfaJson({ error: 'forbidden' }, 403) };
    }
    const session = await getServerSession(authOptions);
    const identity = staffIdentityFromSession(session);
    if (!identity) return { denied: mfaJson({ error: 'unauthorized' }, 401) };
    const pool = getStaffPool();
    const workspace = await staffWorkspaceContext(identity, { api: true });
    if (workspace.status !== 'ok') return { denied: mfaJson({ error: 'Choose a workspace to continue.', code: 'WORKSPACE_CHANGED' }, 409, { 'x-staff-workspace-changed': '1' }) };
    const organizationId = workspace.organizationId;
    const secret = process.env.NEXTAUTH_SECRET;
    if (!pool || !organizationId || !secret) {
        return { denied: mfaJson({ error: 'mfa temporarily unavailable' }, 503) };
    }
    if (await staffGoogleCredentialStatus(identity.subject) === 'revoked') {
        return { denied: mfaJson({ error: 'unauthorized' }, 401) };
    }
    const retryAfter = await reserveMfaAttempt(pool, identity, organizationId);
    if (retryAfter > 0) {
        return { denied: mfaJson({ error: 'too many attempts', retryAfter }, 429,
            { 'retry-after': String(retryAfter) }) };
    }
    return { pool, identity, organizationId, secret };
}

export async function issueMfaProof(context, credentialId) {
    const { pool, identity, organizationId, secret } = context;
    const principal = await resolveStaffPrincipal(pool, identity, organizationId);
    if (!principal) return false;
    const cookieStore = await cookies();
    cookieStore.set(STAFF_MFA_COOKIE, createStaffMfaProof(secret, {
        subject: identity.subject, userId: principal.user_id, credentialId,
    }), {
        httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
        path: '/', maxAge: STAFF_MFA_TTL_MS / 1000,
    });
    return true;
}

export function mfaFailure(error) {
    if (error?.code === 'UNAUTHORIZED' || error?.code === '42501') {
        return mfaJson({ error: 'unauthorized' }, 401);
    }
    if (error?.code === '23514' || error?.code === 'P0002') {
        return mfaJson({ error: 'invalid code' }, 401);
    }
    console.error('MFA operation unavailable');
    return mfaJson({ error: 'mfa temporarily unavailable' }, 503);
}
