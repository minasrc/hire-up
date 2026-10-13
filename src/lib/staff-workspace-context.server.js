import 'server-only';
import { cookies, headers } from 'next/headers';
import { STAFF_WORKSPACE_COOKIE, readStaffWorkspace } from './staff-workspace-cookie.js';

export function multiWorkspaceEnabled() {
    return process.env.STAFF_MULTI_WORKSPACE_ENABLED === '1';
}

// A signed selection is a routing preference. Fresh membership and MFA checks
// still run in the normal page/API gate and in every business transaction.
export async function staffWorkspaceContext(identity, { api = false, expectedWorkspaceId = null } = {}) {
    const enabled = multiWorkspaceEnabled();
    const store = enabled ? await cookies() : null;
    const value = store?.get(STAFF_WORKSPACE_COOKIE)?.value;
    const selected = value ? readStaffWorkspace(process.env.NEXTAUTH_SECRET, value, identity.subject) : null;
    if (value && !selected) return { status: 'workspace-required' };
    const organizationId = enabled && selected ? selected : process.env.STAFF_ORGANIZATION_ID;
    if (!organizationId) return { status: 'unconfigured' };
    if (!api && enabled) {
        const expected = (await headers()).get('x-staff-page-workspace-id');
        if (expected && expected !== organizationId) return { status: 'workspace-required' };
    }
    if (api) {
        const expected = (await headers()).get('x-staff-workspace-id');
        if ((expected && expected !== organizationId)
            || (expectedWorkspaceId !== null && expectedWorkspaceId !== organizationId)
            || (enabled && selected && !expected && expectedWorkspaceId === null)) {
            return { status: 'workspace-changed' };
        }
    }
    return { status: 'ok', organizationId };
}
