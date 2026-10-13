const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const WORKSPACE_CHANGED_EVENT = 'staff-workspace-changed';

export function staffWorkspaceUrl(href) {
    if (typeof document === 'undefined' || typeof window === 'undefined' || !window.location?.origin) return href;
    const meta = document.querySelector('meta[name="staff-workspace-id"]');
    if (meta?.dataset?.multiWorkspace !== '1' || !uuid.test(meta.content ?? '')) return href;
    const destination = new URL(href, window.location.href);
    if (destination.origin !== window.location.origin || !/^\/staff(?:\/|$)/.test(destination.pathname)) return href;
    destination.searchParams.set('_workspace', meta.content);
    return `${destination.pathname}${destination.search}${destination.hash}`;
}

export function refreshStaffWorkspace(router) {
    if (typeof window === 'undefined' || !window.location?.href) { router.refresh(); return; }
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const scoped = staffWorkspaceUrl(current);
    if (scoped === current) router.refresh();
    else router.replace(scoped, { scroll: false });
}

function visibleWorkspace() {
    if (typeof document === 'undefined') return null;
    const value = document.querySelector('meta[name="staff-workspace-id"]')?.content;
    return value && uuid.test(value) ? value : null;
}

// Bind requests to the workspace that rendered the form. A different tab may
// change the shared cookie; the server compares this hint before any mutation.
export async function staffWorkspaceFetch(input, init) {
    const expected = visibleWorkspace();
    let staffRequest = false;
    if (typeof window !== 'undefined' && window.location?.origin) {
        const raw = input instanceof Request ? input.url : String(input);
        const url = new URL(raw, window.location.origin);
        staffRequest = url.origin === window.location.origin && url.pathname.startsWith('/api/staff/');
    }
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (staffRequest && expected) headers.set('x-staff-workspace-id', expected);
    // Staff APIs return data. Refuse redirects so the scope header cannot be
    // forwarded to a storage provider or another origin. File links navigate
    // natively through the separately scoped document GET route.
    const response = await fetch(input, { ...init, headers, ...(staffRequest ? { redirect: 'error' } : {}) });
    if (staffRequest && (response.headers.get('x-staff-workspace-changed') === '1' || (expected && expected !== visibleWorkspace()))) {
        await response.body?.cancel().catch(() => {});
        window.dispatchEvent(new Event(WORKSPACE_CHANGED_EVENT));
        return Response.json({ error: 'Workspace changed. Reload to continue.', code: 'WORKSPACE_CHANGED' }, { status: 409 });
    }
    return response;
}
