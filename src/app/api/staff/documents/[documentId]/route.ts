import { createClient } from '@supabase/supabase-js';
import mammoth from 'mammoth';
import { documentWorkspaceExpectation } from '@/lib/staff-document-workspace';
import { getDocumentDownload } from '@/lib/pipeline-operations';
import {
    staffApiContext,
    staffErrorResponse,
    staffGateResponse,
} from '@/lib/staff-api.server';

export const runtime = 'nodejs';

const SIGNED_URL_TTL_SECONDS = 60;
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Issues a short-lived signed URL for a verified blob location. The procedure
// resolves coordinates under documents.download; the route signs and redirects.
export async function GET(
    request: Request,
    { params }: { params: Promise<{ documentId: string }> },
) {
    const context = await staffApiContext({ expectedWorkspaceId: documentWorkspaceExpectation(request.url) });
    const denied = staffGateResponse(context);
    if (denied) {
        if (denied.headers.get('x-staff-workspace-changed') === '1'
            && request.headers.get('sec-fetch-dest') === 'document') {
            return new Response(null, { status: 303, headers: {
                location: '/staff/workspaces',
                'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer',
            } });
        }
        return denied;
    }
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceRoleKey) {
        return Response.json({ error: 'storage is not configured' }, { status: 503 });
    }
    const { documentId } = await params;
    const view = new URL(request.url).searchParams.get('view');
    if (view !== null && view !== 'inline' && view !== 'text' && view !== 'bytes') {
        return Response.json({ error: 'unsupported view' }, { status: 400 });
    }
    try {
        const document = await getDocumentDownload(
            context.pool, context.identity, context.organizationId,
            { documentId },
        );
        if (!document) {
            return Response.json({ error: 'not found' }, { status: 404 });
        }
        const supabase = createClient(supabaseUrl, serviceRoleKey, {
            auth: { persistSession: false, autoRefreshToken: false },
        });
        if (view === 'text' || view === 'bytes') {
            if ((view === 'text' && document.mimeType !== DOCX_MIME)
                || (view === 'bytes' && document.mimeType !== 'application/pdf')) {
                return Response.json({ error: 'preview is unavailable for this file type' }, {
                    status: 415,
                    headers: { 'cache-control': 'private, no-store' },
                });
            }
            // The database checks fresh permissions/lifecycle before revealing
            // this version. Older databases safely fall back to a full response.
            const version = typeof document.previewVersion === 'string'
                && /^[a-f0-9]{64}$/.test(document.previewVersion)
                ? `"preview-v1-${view}-${document.previewVersion}"` : null;
            const privateHeaders = {
                'cache-control': 'private, no-store',
                'x-content-type-options': 'nosniff',
                ...(version ? { etag: version } : {}),
            };
            if (version && request.headers.get('if-none-match') === version) {
                return new Response(null, { status: 304, headers: privateHeaders });
            }
            const { data: file, error: downloadError } = await supabase.storage
                .from(document.bucket).download(document.objectKey);
            if (downloadError || !file) {
                return Response.json({ error: 'document unavailable' }, { status: 404 });
            }
            if (file.size > MAX_PREVIEW_BYTES) {
                return Response.json({ error: 'document is too large to preview' }, { status: 413 });
            }
            const buffer = Buffer.from(await file.arrayBuffer());
            if (view === 'bytes') {
                return new Response(buffer, {
                    headers: {
                        'content-type': 'application/pdf',
                        'content-disposition': 'inline',
                        ...privateHeaders,
                    },
                });
            }
            const { value } = await mammoth.extractRawText({ buffer });
            return Response.json({ text: value.slice(0, 200_000) }, {
                headers: privateHeaders,
            });
        }
        if (view === 'inline' && document.mimeType !== 'application/pdf') {
            return Response.json({ error: 'inline preview is unavailable for this file type' }, {
                status: 415,
            });
        }
        const { data, error } = await supabase.storage
            .from(document.bucket)
            .createSignedUrl(document.objectKey, SIGNED_URL_TTL_SECONDS,
                view === 'inline' ? undefined : { download: document.filename });
        if (error || !data?.signedUrl) {
            return Response.json({ error: 'document unavailable' }, { status: 404 });
        }
        return new Response(null, {
            status: 302,
            headers: {
                location: data.signedUrl,
                'cache-control': 'private, no-store',
                'referrer-policy': 'no-referrer',
            },
        });
    } catch (error) {
        return staffErrorResponse(error);
    }
}
