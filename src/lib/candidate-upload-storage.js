import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { candidateUploadReferenced } from './candidate-upload-operations.js';
export const CANDIDATE_CV_BUCKET = 'cv-submissions';
export function createCandidateUploadStorage() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    return url && key ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
}
export function candidateCvObjectKey(organizationId, candidateId, extension) {
    return `staff/${organizationId}/${candidateId}/${randomUUID()}.${extension}`;
}
// A lost COMMIT response is not evidence of rollback. Serialize the reference
// check with intake, and retain the private object if that check cannot finish.
export async function cleanupCandidateUpload({ check, remove }) {
    try {
        if (await check() === false) await remove();
    } catch (error) {
        console.error('candidate upload cleanup deferred', error?.code ?? 'UNKNOWN');
    }
}
export function cleanupCandidateCv(context, storage, objectKey) {
    return cleanupCandidateUpload({
        check: () => candidateUploadReferenced(context, objectKey),
        remove: async () => {
            const { error } = await storage.storage.from(CANDIDATE_CV_BUCKET).remove([objectKey]);
            if (error) throw error;
        },
    });
}
