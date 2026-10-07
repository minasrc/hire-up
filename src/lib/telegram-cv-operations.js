import { createHash } from 'node:crypto';
import { withStaffTransaction } from './staff-authorization.js';
import { assertUuid } from './candidate-profile-contracts.js';
import { ClientJobContractError } from './client-job-contracts.js';
import { assertCandidateCvFilename } from './candidate-upload-contracts.js';
import { validateCvFile } from './application-file.js';
import { validateCvFileMetadata } from './application.js';
import { CANDIDATE_CV_BUCKET } from './candidate-upload-storage.js';
import { cvStaffAction, cvWorkerInput, cvAttachmentCursor, TELEGRAM_CV_MAX_BYTES } from './telegram-cv-contracts.js';
const result = async (client, sql, args) => (await client.query(sql, args)).rows[0].result;
const staff = (pool, identity, org, fn) => withStaffTransaction(pool, identity, org, ['candidates.read', 'candidates.write', 'documents.write'], fn);
export function telegramCvStatus(pool, identity, org, draftId, after = null) {
    const cursor = cvAttachmentCursor(after);
    return staff(pool, identity, org, ({ client }) => result(client, 'select app.telegram_cv_status_v1($1,$2,$3,$4) as result', [assertUuid(draftId, 'draftId'), cursor?.jobId ?? null, cursor?.messageId ?? null, cursor?.attachmentIndex ?? null]));
}
export function telegramCvBatchStatus(pool, identity, org, extractionJobId, after = null) {
    const cursor = after == null ? null : cvAttachmentCursor(`${extractionJobId}:${after}`);
    return staff(pool, identity, org, ({ client }) => result(client, 'select app.cv_bootstrap_status_v1($1,$2,$3) result', [assertUuid(extractionJobId, 'extractionJobId'), cursor?.messageId ?? null, cursor?.attachmentIndex ?? null]));
}
export function telegramCvAction(pool, identity, org, input) {
    const action = cvStaffAction(input);
    return staff(pool, identity, org, ({ client }) => result(client, 'select app.telegram_cv_action_v1($1::jsonb) as result', [JSON.stringify(action)]));
}
async function worker(pool, token, fn) {
    if (!/^[A-Za-z0-9_-]{64}$/.test(token ?? '')) { const error = new Error('Unauthorized'); error.code = '42501'; throw error; }
    const client = await pool.connect();
    try {
        await client.query("begin isolation level read committed; set local role app_telegram_worker; set local statement_timeout='10s'; set local lock_timeout='2s'");
        const output = await fn(client); await client.query('commit'); return output;
    } catch (error) { await client.query('rollback').catch(() => {}); throw error; }
    finally { client.release(); }
}
const proofArgs = (token, p) => [token, p.connectionId, p.generation, p.connectionLeaseToken, p.accountUserId];
export function telegramCvWorkerOperation(pool, token, action, input) {
    if (!['claim', 'defer'].includes(action)) throw new ClientJobContractError({ action: 'Invalid CV action.' });
    const parsed = cvWorkerInput(action, input); const args = proofArgs(token, parsed.proof);
    return worker(pool, token, client => action === 'claim'
        ? result(client, 'select app.telegram_cv_claim_v1($1,$2,$3,$4,$5) as result', args)
        : result(client, 'select app.telegram_cv_defer_v1($1,$2,$3,$4,$5,$6,$7,$8,$9) as result', [...args, parsed.jobId, parsed.jobLeaseToken, parsed.code, parsed.retryAfterSeconds]));
}
const invalidFile = () => { throw new ClientJobContractError({ cv: 'Only a matching PDF or DOCX CV up to 4 MB can be retrieved.' }); };
async function stage(pool, token, parsed, action, type = null, extension = null) {
    const output = await worker(pool, token, client => result(client, 'select app.telegram_cv_upload_stage_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) as result', [...proofArgs(token, parsed.proof), parsed.jobId, parsed.jobLeaseToken, parsed.sourceDigest, parsed.sha256, parsed.sizeBytes, action, type, extension]));
    if (output.expired) { const error = new Error('Upload reservation expired'); error.code = '40001'; throw error; }
    return output;
}
// readBytes runs only after authenticated preflight, and after that transaction
// commits. The injected storage seam is also used by disposable integration tests.
export async function uploadTelegramCv(pool, token, input, readBytes, storage) {
    const parsed = cvWorkerInput('upload', input);
    const preflight = await stage(pool, token, parsed, 'preflight');
    if (preflight.completed) return preflight.completed;
    const content = await readBytes();
    if (!(content instanceof Uint8Array) || content.byteLength === 0 || content.byteLength > TELEGRAM_CV_MAX_BYTES || content.byteLength !== parsed.sizeBytes) invalidFile();
    const sha256 = createHash('sha256').update(content).digest('hex'); if (sha256 !== parsed.sha256) invalidFile();
    const filename = assertCandidateCvFilename(preflight.filename);
    const file = new File([content], filename);
    if (!validateCvFileMetadata(file).ok) invalidFile();
    const validated = await validateCvFile(file).catch(() => ({ ok: false }));
    if (!validated.ok || filename.split('.').pop()?.toLowerCase() !== validated.extension) invalidFile();
    const reservation = await stage(pool, token, parsed, 'reserve', validated.mimeType, validated.extension);
    if (reservation.completed) return reservation.completed;
    const bucket = storage.storage.from(CANDIDATE_CV_BUCKET);
    const upload = await bucket.upload(reservation.objectKey, content, { contentType: validated.mimeType, upsert: false });
    if (upload?.error) {
        const status = Number(upload.error.statusCode ?? upload.error.status);
        const duplicate400 = status === 400 && (['Duplicate', 'ResourceAlreadyExists', 'already_exists'].includes(upload.error.code)
            || ['asset already exists', 'the resource already exists'].includes(String(upload.error.message ?? '').toLowerCase()));
        if (status !== 409 && !duplicate400) throw new Error('Storage unavailable');
        // An earlier upload may have succeeded before its response was lost.
        // Never overwrite an existing key: verify the reserved object's bytes.
        const existing = await bucket.download(reservation.objectKey);
        if (existing?.error || !existing?.data || existing.data.size !== content.byteLength) throw new Error('Storage verification unavailable');
        const bytes = new Uint8Array(await existing.data.arrayBuffer());
        if (bytes.byteLength !== content.byteLength || createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('Storage verification unavailable');
    } else if (!upload) throw new Error('Storage unavailable');
    // An uncertain final COMMIT retains the object. Retry checks the receipt
    // before reading/uploading bytes; manual uploads and closed drafts fence it.
    const finalized = await stage(pool, token, parsed, 'finalize');
    return finalized.completed;
}
