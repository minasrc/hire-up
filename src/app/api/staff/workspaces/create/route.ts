import { staffApiContext, staffGateResponse, staffErrorResponse } from '@/lib/staff-api.server';
import { multiWorkspaceEnabled } from '@/lib/staff-workspace-context.server';
import { staffRequestOriginAllowed } from '@/lib/staff-request-origin';
import { createStaffWorkspace } from '@/lib/staff-workspace-operations';
import { readTelegramJson } from '@/lib/telegram-intake-http';

export const runtime = 'nodejs';
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'private, no-store' } });

export async function POST(request: Request) {
    if (!multiWorkspaceEnabled()) return json({ error: 'Not found.' }, 404);
    if (!staffRequestOriginAllowed(request)) return json({ error: 'Invalid request origin.' }, 403);
    const context = await staffApiContext();
    const denied = staffGateResponse(context);
    if (denied) return denied;
    try {
        return json(await createStaffWorkspace(context.pool, context.identity, context.organizationId,
            await readTelegramJson(request, 2048)));
    } catch (error) {
        if ((error as { code?: string }).code === '53300') return json({ error: 'Workspace capacity is reached. Contact the platform operator before creating another workspace.' }, 429);
        try { return staffErrorResponse(error); }
        catch { return json({ error: 'Workspace creation could not be confirmed. Retry the same request to check its status.' }, 503); }
    }
}
