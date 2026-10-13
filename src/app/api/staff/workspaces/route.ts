import { cookies } from 'next/headers';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { staffIdentityFromSession, staffInviteEmailFromSession } from '@/lib/staff-identity';
import { getStaffPool, resolveOrClaimStaffPrincipal } from '@/lib/staff-db.server';
import { staffGoogleCredentialStatus, staffSessionExpiresAt } from '@/lib/staff-google.server';
import { listStaffWorkspaces } from '@/lib/staff-workspace-directory';
import { multiWorkspaceEnabled } from '@/lib/staff-workspace-context.server';
import { STAFF_WORKSPACE_COOKIE, signStaffWorkspace } from '@/lib/staff-workspace-cookie';
import { STAFF_MFA_COOKIE } from '@/lib/staff-mfa-cookie';
import { staffRequestOriginAllowed } from '@/lib/staff-request-origin';
import { readTelegramJson } from '@/lib/telegram-intake-http';
import { ClientJobContractError } from '@/lib/client-job-contracts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'private, no-store' } });

async function context() {
    if (!multiWorkspaceEnabled()) return { denied: json({ error: 'Not found.' }, 404) };
    const session = await getServerSession(authOptions);
    const identity = staffIdentityFromSession(session);
    if (!identity || await staffGoogleCredentialStatus(identity.subject) === 'revoked') return { denied: json({ error: 'Sign in again.' }, 401) };
    const pool = getStaffPool();
    if (!pool || !process.env.NEXTAUTH_SECRET) return { denied: json({ error: 'Workspaces temporarily unavailable.' }, 503) };
    return { session, identity, pool, email: staffInviteEmailFromSession(session) };
}

export async function GET() {
    const access = await context();
    if (access.denied) return access.denied;
    try { return json({ workspaces: await listStaffWorkspaces(access.pool, access.identity, access.email) }); }
    catch { return json({ error: 'Workspaces temporarily unavailable.' }, 503); }
}

export async function POST(request: Request) {
    if (!staffRequestOriginAllowed(request)) return json({ error: 'Invalid request origin.' }, 403);
    const access = await context();
    if (access.denied) return access.denied;
    try {
        const input = await readTelegramJson(request, 2048);
        if (input.action !== 'select' || Object.keys(input).some(key => !['action', 'organizationId'].includes(key))
            || typeof input.organizationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.organizationId)) {
            return json({ error: 'Choose a workspace from your invitations or memberships.' }, 400);
        }
        const workspaces = await listStaffWorkspaces(access.pool, access.identity, access.email);
        if (!workspaces.some((workspace: { organizationId: string }) => workspace.organizationId === input.organizationId)) return json({ error: 'Workspace unavailable.' }, 403);
        const expires = await staffSessionExpiresAt(access.identity.subject);
        if (!expires) return json({ error: 'Sign in again.' }, 401);
        const principal = await resolveOrClaimStaffPrincipal(access.pool, access.identity, access.email, input.organizationId);
        if (!principal) return json({ error: 'Your invitation or membership changed. Refresh and try again.' }, 409);
        const store = await cookies();
        store.set(STAFF_WORKSPACE_COOKIE, signStaffWorkspace(process.env.NEXTAUTH_SECRET, access.identity.subject, input.organizationId, expires), {
            httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/',
            maxAge: Math.min(30 * 86400, Math.floor((expires - Date.now()) / 1000)),
        });
        // Each workspace verifies its own MFA credential after a selection.
        store.delete(STAFF_MFA_COOKIE);
        return json({ ok: true, destination: '/staff' });
    } catch (error) {
        if (error instanceof ClientJobContractError) return json({ error: 'Invalid workspace request.' }, 400);
        const code = (error as { code?: string }).code;
        return json({ error: code === '42501' ? 'Workspace unavailable.' : 'Unable to select this workspace. Refresh and try again.' },
            code === '42501' ? 403 : code === '23505' || code === '40001' ? 409 : code === 'INVALID_INPUT' ? 400 : 503);
    }
}
