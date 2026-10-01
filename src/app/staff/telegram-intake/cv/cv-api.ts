export const cvEndpoint = '/api/staff/telegram-cv';
export class CvRequestError extends Error {
    constructor(public status: number) {
        super(status === 409 ? 'The draft, attachment or connection changed. Refresh retrieval status before trying again.'
            : status === 400 || status === 422 ? 'This file cannot be retrieved in its current state. Refresh status and review the attachment details.'
                : status === 401 || status === 403 ? 'You do not have access to retrieve CVs. Sign in again or contact your workspace administrator.'
                    : status === 404 ? 'CV retrieval is not available for this draft.'
                        : 'CV retrieval is temporarily unavailable. Retry after checking the Mac connection.');
    }
}
export async function cvRequest(url: string, init?: RequestInit) {
    const response = await fetch(url, { cache: 'no-store', ...init });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body) throw new CvRequestError(response.status || 503);
    return body;
}
