import { randomUUID } from 'node:crypto';
import {
    changeStaffMembership,
    inviteStaffMember,
    setStaffInviteDomains,
} from '@/lib/staff-operations';
import {
    staffApiContext,
    staffErrorResponse,
    staffGateResponse,
} from '@/lib/staff-api.server';

export const runtime = 'nodejs';

export async function POST(request: Request) {
    const context = await staffApiContext();
    const denied = staffGateResponse(context);
    if (denied) {
        return denied;
    }
    const body = await request.json().catch(() => ({}));
    const action = typeof body?.action === 'string' ? body.action : 'invite';
    try {
        let result;
        if (action === 'invite') {
            result = await inviteStaffMember(
                context.pool, context.identity, context.organizationId,
                {
                    userId: randomUUID(),
                    membershipId: randomUUID(),
                    displayName: body?.displayName,
                    email: body?.email,
                    roleId: body?.roleId,
                    operationId: randomUUID(),
                },
            );
        } else if (action === 'setInviteDomains') {
            result = await setStaffInviteDomains(
                context.pool, context.identity, context.organizationId,
                { domains: body?.domains, operationId: randomUUID() },
            );
        } else if (action === 'changeMembership') {
            result = await changeStaffMembership(
                context.pool, context.identity, context.organizationId,
                {
                    membershipId: body?.membershipId,
                    roleId: body?.roleId,
                    status: body?.status,
                    version: body?.version,
                    operationId: randomUUID(),
                },
            );
        } else {
            return Response.json({ error: 'unknown action' }, { status: 400 });
        }
        return Response.json({ ok: true, result });
    } catch (error) {
        if (action === 'invite' && (error as { code?: string })?.code === '23505') {
            return Response.json({ error: 'invite already exists' }, { status: 409 });
        }
        return staffErrorResponse(error);
    }
}
