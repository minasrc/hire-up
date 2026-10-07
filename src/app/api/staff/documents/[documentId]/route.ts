import { createClient } from '@supabase/supabase-js';
import { getDocumentDownload } from '@/lib/pipeline-operations';
import {
    staffApiContext,
    staffErrorResponse,
    staffGateResponse,
} from '@/lib/staff-api.server';

export const runtime = 'nodejs';

const SIGNED_URL_TTL_SECONDS = 60;
const PDF_MIME_TYPE = 'application/pdf';
const CACHE_PRIVATE = 'private, no-store';

// Issues a short-lived signed URL for a verified blob location. The procedure
// resolves coordinates under documents.download; the route signs and redirects.
export async function GET(
    request: Request,
    { params }: { params: Promise<{ documentId: string }> },
) {
    const context = await staffApiContext();
    const denied = staffGateResponse(context);
    if (denied) {
        return denied;
    }
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceRoleKey) {
        return Response.json({ error: 'storage is not configured' }, { status: 503 });
    }
    const { documentId } = await params;
    const searchParams = new URL(request.url).searchParams;
    const inline = searchParams.get('inline') === '1';
    const wantsJson = searchParams.get('format') === 'json';
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
        if (inline && document.mimeType !== PDF_MIME_TYPE) {
            return Response.json(
                { error: 'inline preview is only available for PDF documents' },
                { status: 400 },
            );
        }
        const previewable = inline && document.mimeType === PDF_MIME_TYPE;
        const { data, error } = await supabase.storage
            .from(document.bucket)
            .createSignedUrl(document.objectKey, SIGNED_URL_TTL_SECONDS, {
                download: previewable ? false : document.filename,
            });
        if (error || !data?.signedUrl) {
            return Response.json({ error: 'document unavailable' }, { status: 404 });
        }
        if (inline && wantsJson) {
            return Response.json(
                { url: data.signedUrl, expiresIn: SIGNED_URL_TTL_SECONDS },
                { headers: { 'Cache-Control': CACHE_PRIVATE } },
            );
        }
        return new Response(null, {
            status: 302,
            headers: {
                Location: data.signedUrl,
                'Cache-Control': CACHE_PRIVATE,
            },
        });
    } catch (error) {
        return staffErrorResponse(error);
    }
}
