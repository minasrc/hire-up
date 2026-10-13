import { createHash } from 'node:crypto';
import { after } from 'next/server';
import { staffApiContext, staffGateResponse } from '@/lib/staff-api.server';
import { ClientJobContractError } from '@/lib/client-job-contracts';
import { validateCvFile } from '@/lib/application-file';
import { validateCvFileMetadata, MAX_CV_SIZE_BYTES } from '@/lib/application';
import { assertCandidateCvFilename } from '@/lib/candidate-upload-contracts';
import { CANDIDATE_CV_BUCKET, createCandidateUploadStorage, candidateCvObjectKey } from '@/lib/candidate-upload-storage';
import { telegramReviewMatches, matchTelegramReview, refreshTelegramReview, listTelegramDrafts, getTelegramDraft, createTelegramDraft, updateTelegramDraft, decideTelegramDraft, registerTelegramWorker, revokeTelegramWorker, enqueueTelegramEmbedding, telegramCvTarget, attachTelegramCv } from '@/lib/telegram-intake-operations';
import { readTelegramJson, telegramErrorResponse, telegramFeatureResponse, telegramJson, telegramOriginAllowed } from '@/lib/telegram-intake-http';
import { cleanupTelegramUploads, reserveTelegramUpload } from '@/lib/telegram-upload-cleanup';
import { telegramCvDocument } from '@/lib/telegram-intake-operations';

export const runtime = 'nodejs';
type RouteContext = { params: Promise<{ path: string[] }> };

async function handle(request: Request, { params }: RouteContext) {
    const disabled = telegramFeatureResponse(); if (disabled) return disabled;
    if (request.method !== 'GET' && !telegramOriginAllowed(request)) return telegramJson({ error: 'Invalid request origin.' }, 403);
    const context = await staffApiContext();
    const denied = staffGateResponse(context); if (denied) return denied;
    const { path } = await params;
    const [resource, id, action] = path;
    const args = [context.pool, context.identity, context.organizationId] as const;
    try {
        if (path.length > 3) return telegramJson({ error: 'not found' }, 404);
        if (resource === 'drafts' && !id && request.method === 'GET') {
            const q = new URL(request.url).searchParams;
            return telegramJson({ result: await listTelegramDrafts(...args, { view: q.get('view') ?? 'ready', missing: q.get('missing') || null, q: q.get('q') ?? '', page: Number(q.get('page') ?? 1) }) });
        }
        if (resource === 'drafts' && !id && request.method === 'POST') return telegramJson({ result: await createTelegramDraft(...args, await readTelegramJson(request)) }, 201);
        if (resource === 'drafts' && id && !action && request.method === 'GET') return telegramJson({ result: await getTelegramDraft(...args, id) });
        if (resource === 'drafts' && id && !action && request.method === 'PATCH') return telegramJson({ result: await updateTelegramDraft(...args, id, await readTelegramJson(request)) });
        if (resource === 'drafts' && id && action === 'matches' && request.method === 'GET') return telegramJson({ result: await telegramReviewMatches(...args, id, new URL(request.url).searchParams.get('q') ?? '') });
        if (resource === 'drafts' && id && action === 'match' && request.method === 'POST') return telegramJson({ result: await matchTelegramReview(...args, id, await readTelegramJson(request)) });
        if (resource === 'drafts' && id && action === 'refresh' && request.method === 'POST') return telegramJson({ result: await refreshTelegramReview(...args, id, await readTelegramJson(request)) });
        if (resource === 'drafts' && id && action === 'decision' && request.method === 'POST') {
            const result = await decideTelegramDraft(...args, id, await readTelegramJson(request));
            const storage = createCandidateUploadStorage();
            if (storage) after(() => cleanupTelegramUploads(...args, storage).then(() => {}, () => {}));
            return telegramJson({ result, ...(result.status === 'duplicate' ? { error: 'A candidate with one of these emails already exists.' } : {}) }, result.status === 'duplicate' ? 409 : 200);
        }
        if (resource === 'uploads' && id === 'cleanup' && !action && request.method === 'POST') {
            const storage = createCandidateUploadStorage();
            if (!storage) return telegramJson({ error: 'CV storage is not configured.' }, 503);
            return telegramJson({ result: await cleanupTelegramUploads(...args, storage) });
        }
        if (resource === 'drafts' && id && action === 'cv' && request.method === 'GET') {
            const document = await telegramCvDocument(...args, id);
            const storage = createCandidateUploadStorage();
            if (!storage) return telegramJson({ error: 'CV storage is not configured.' }, 503);
            const { data, error } = await storage.storage.from(CANDIDATE_CV_BUCKET).createSignedUrl(document.objectKey, 60, { download: document.filename });
            if (error || !data?.signedUrl) throw new Error('Storage unavailable');
            return new Response(null, { status: 302, headers: { location: data.signedUrl, 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' } });
        }
        if (resource === 'drafts' && id && action === 'index' && request.method === 'POST') return telegramJson({ result: await enqueueTelegramEmbedding(...args, id) }, 202);
        if (resource === 'workers' && !id && request.method === 'POST') {
            const body = await readTelegramJson(request);
            return telegramJson({ result: await registerTelegramWorker(...args, body.name) }, 201);
        }
        if (resource === 'workers' && id && !action && request.method === 'DELETE') return telegramJson({ result: await revokeTelegramWorker(...args, id) });
        if (resource === 'drafts' && id && action === 'cv' && request.method === 'POST') {
            const target = await telegramCvTarget(...args, id);
            // Bound multipart bytes even when content-length is absent or false.
            const bytes = new Uint8Array(await readMultipartBytes(request, MAX_CV_SIZE_BYTES + 65536));
            const form = await new Request('http://localhost', { method: 'POST', headers: { 'content-type': request.headers.get('content-type') ?? '' }, body: bytes }).formData();
            for (const key of Array.from(form.keys())) if (!['expectedVersion', 'cvFile'].includes(key) || form.getAll(key).length !== 1) throw new ClientJobContractError({ cv: 'Unexpected upload fields.' });
            const file = form.get('cvFile');
            const metadata = validateCvFileMetadata(file);
            if (!metadata.ok) throw new ClientJobContractError({ cv: metadata.message });
            const validated = await validateCvFile(file).catch(() => ({ ok: false, message: 'Invalid CV.' }));
            if (!validated.ok) throw new ClientJobContractError({ cv: 'Only valid PDF or DOCX CVs up to 4 MB are accepted.' });
            const typed = validated as { extension: string; mimeType: string };
            const filename = assertCandidateCvFilename((file as File).name);
            if (filename.split('.').pop()?.toLowerCase() !== typed.extension) throw new ClientJobContractError({ cv: 'File contents must match its extension.' });
            const storage = createCandidateUploadStorage();
            if (!storage) return telegramJson({ error: 'CV storage is not configured.' }, 503);
            const objectKey = candidateCvObjectKey(context.organizationId, target, typed.extension);
            const content = Buffer.from(await (file as File).arrayBuffer());
            await reserveTelegramUpload(...args, id, Number(form.get('expectedVersion')), objectKey);
            const upload = await storage.storage.from(CANDIDATE_CV_BUCKET).upload(objectKey, content, { contentType: typed.mimeType, upsert: false });
            if (upload.error) throw new Error('Storage unavailable');
            // On an uncertain commit retain the private object; never delete a possibly referenced CV.
            const result = await attachTelegramCv(...args, id, Number(form.get('expectedVersion')), {
                filename, objectKey, sha256: createHash('sha256').update(content).digest('hex'), sizeBytes: content.length,
                extension: typed.extension, mimeType: typed.mimeType,
            });
            after(() => cleanupTelegramUploads(...args, storage).then(() => {}, () => {}));
            return telegramJson({ result });
        }
        return telegramJson({ error: 'not found' }, 404);
    } catch (error) { return telegramErrorResponse(error); }
}
async function readMultipartBytes(request: Request, maximum: number) {
    const reader = request.body?.getReader(); if (!reader) throw new ClientJobContractError({ cv: 'Attach a CV.' });
    let length = 0; const chunks: Buffer[] = [];
    try {
        while (true) {
            const { done, value } = await reader.read(); if (done) break;
            length += value.length;
            if (length > maximum) { await reader.cancel(); throw new ClientJobContractError({ cv: 'The CV must be 4 MB or smaller.' }); }
            chunks.push(Buffer.from(value));
        }
        return Buffer.concat(chunks);
    } finally { reader.releaseLock(); }
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
