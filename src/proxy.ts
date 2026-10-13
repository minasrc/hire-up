import { NextResponse, type NextRequest } from 'next/server';

// Preserve the workspace that rendered a programmatic navigation/filter URL.
// This is an expectation, never authority: the page gate still verifies the
// signed cookie, current Google account, membership and workspace MFA.
export function proxy(request: NextRequest) {
    const headers = new Headers(request.headers);
    headers.delete('x-staff-page-workspace-id');
    const expected = request.nextUrl.searchParams.getAll('_workspace');
    if (process.env.STAFF_MULTI_WORKSPACE_ENABLED === '1' && expected.length) {
        const value = expected.length === 1 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(expected[0])
            ? expected[0] : 'invalid';
        headers.set('x-staff-page-workspace-id', value);
    }
    return NextResponse.next({ request: { headers } });
}

export const config = { matcher: '/staff/:path*' };
