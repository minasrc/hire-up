export const analysisEndpoint = '/api/staff/cv-analysis';
export class AnalysisError extends Error {
    constructor(public status: number) { super(status === 409 ? 'The draft, CV or analysis changed. Refresh and review the latest version before continuing.' : status === 401 || status === 403 ? 'CV analysis requires access to this draft and its document. Sign in again or contact your workspace administrator.' : status === 404 ? 'This CV analysis is unavailable.' : status === 400 || status === 422 ? 'Review the CV analysis status and complete its required decisions before continuing.' : 'CV analysis is temporarily unavailable. Refresh status or try again later.'); }
}
export async function analysisRequest(url: string, init?: RequestInit) {
    const response = await fetch(url, { cache: 'no-store', ...init });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body) throw new AnalysisError(response.ok ? 503 : response.status);
    return body.result ?? body;
}
export const analysisAction = (body: Record<string, unknown>) => analysisRequest(analysisEndpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000), body: JSON.stringify(body) });
export type Analysis = { id: string; draftId: string; documentRevision: number; documentSha256: string; filename: string; stage: string; status: string; errorCode: string | null; attempts: number; availableAt: string; version: number; textDecision: 'pending' | 'include' | 'exclude'; blockCount: number; textByteLength: number; pendingProposalCount: number; issues: string[]; canRetry: boolean };
export type Block = { ordinal: number; kind: 'pdf_page' | 'docx_paragraph'; page?: number; part?: string; paragraph?: number; text: string; sha256: string };
export type Evidence = { blockOrdinal: number; startByte: number; endByte: number; quote: string };
export type Proposal = { id: string; analysisId: string; draftId: string; field: string; currentValue: unknown; suggestedValue: unknown; evidence: Evidence[]; documentSha256: string; createdAt: string };
export type AnalysisSnapshot = { draftId: string; documentRevision: number; canAnalyze: boolean; analysisReviewRequired: boolean; current: Analysis | null; jobs: Analysis[]; nextAfter: string | null; proposals: Proposal[]; nextProposalAfter: string | null };
