import { cookies } from 'next/headers';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { staffIdentityFromSession } from '@/lib/staff-identity';
import { getStaffPool, resolveStaffPrincipal } from '@/lib/staff-db.server';
import {
    confirmTotpEnrollment,
    getTotpStatus,
    verifyTotpCode,
} from '@/lib/staff-mfa.server';
import {
    STAFF_MFA_COOKIE,
    STAFF_MFA_TTL_MS,
    createStaffMfaProof,
} from '@/lib/staff-mfa-cookie';

export const runtime = 'nodejs';

const json = (body: unknown, status = 200) => Response.json(body, { status });

export async function POST(request: Request) {
    const session = await getServerSession(authOptions);
    const identity = staffIdentityFromSession(session);
    if (!identity) {
        return json({ error: 'unauthorized' }, 401);
    }
    const pool = getStaffPool();
    const organizationId = process.env.STAFF_ORGANIZATION_ID;
    const secret = process.env.NEXTAUTH_SECRET;
    if (!pool || !organizationId || !secret) {
        return json({ error: 'staff workspace not configured' }, 503);
    }

    const body = await request.json().catch(() => ({}));
    const code = typeof body?.code === 'string' ? body.code : '';

    const status = await getTotpStatus(pool, identity, organizationId);
    if (!status || status.status !== 'pending') {
        return json({ error: 'no pending enrollment' }, 409);
    }
    if (verifyTotpCode(status.secret, code) === null) {
        return json({ error: 'invalid code' }, 401);
    }

    await confirmTotpEnrollment(pool, identity, organizationId, status.credentialId);
    const principal = await resolveStaffPrincipal(pool, identity, organizationId);
    if (!principal) {
        return json({ error: 'unauthorized' }, 401);
    }

    const cookieStore = await cookies();
    cookieStore.set(STAFF_MFA_COOKIE, createStaffMfaProof(secret, {
        subject: identity.subject,
        userId: principal.user_id,
        credentialId: status.credentialId,
    }), {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: STAFF_MFA_TTL_MS / 1000,
    });
    return json({ ok: true });
}
