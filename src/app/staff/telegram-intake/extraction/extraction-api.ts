import { staffWorkspaceFetch } from '@/lib/staff-workspace-fetch';
import { privateAccessDenied } from './private-snapshot-guard';
import { staffAuthRecovery } from '@/lib/staff-auth-recovery';
export const extractionEndpoint = '/api/staff/telegram-extraction';
export class ExtractionError extends Error {
    constructor(public status: number, public fields?: unknown) {
        super(status === 409 ? 'This record changed. Refresh it and review the latest values before trying again.'
            : status === 422 ? 'This batch still has unresolved candidate decisions or suggestions. Finish their review first.'
                : status === 428 ? 'Authenticator verification is required to view this extraction.'
                : status === 401 || status === 403 ? 'You do not have access to this extraction. Sign in again or contact your workspace administrator.'
                    : status === 404 ? 'Candidate extraction is not available in this workspace yet.'
                        : 'Candidate extraction is temporarily unavailable. Retry after checking the worker connection.');
    }
}
export async function extractionRequest(url = extractionEndpoint, init?: RequestInit) {
    const response = await staffWorkspaceFetch(url, { cache: 'no-store', ...init });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new ExtractionError(response.status, body?.fieldErrors ?? body?.fields);
    if (!body) throw new ExtractionError(503);
    return body;
}
export function extractionAction(body: Record<string, unknown>) {
    return extractionRequest(extractionEndpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

export function extractionAccessLost(failure: unknown, epoch: number) {
    if (!(failure instanceof ExtractionError) || !privateAccessDenied(failure.status)) return false;
    if (epoch !== staffAuthRecovery.requestEpoch()) return true;
    if (failure.status === 403) window.dispatchEvent(new CustomEvent('staff-session-invalidated', { detail: { recoverable: false } }));
    else staffAuthRecovery.require(failure.status, epoch);
    return true;
}
