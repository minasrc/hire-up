export const searchEndpoint = '/api/staff/profile-search';
export class ProfileSearchError extends Error {
    constructor(public status: number) {
        super(status === 400 || status === 422 ? 'Check the search description and filters, then try again.'
            : status === 401 || status === 403 ? 'Search access is unavailable. Sign in again or contact your workspace administrator.'
                : status === 404 ? 'This search is unavailable or has expired. Start a new search.'
                    : status === 409 ? 'This search changed. Refresh its status before trying again.'
                        : status === 429 ? 'Too many searches are waiting. Wait for an existing search to finish, then retry.'
                            : 'Search is temporarily unavailable. Retry status or use name/email lookup.');
    }
}
export async function searchRequest(url: string, init?: RequestInit) {
    const response = await fetch(url, { cache: 'no-store', ...init });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body) throw new ProfileSearchError(response.ok ? 503 : response.status);
    return body;
}
export const searchAction = (body: Record<string, unknown>) => searchRequest(searchEndpoint, { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
