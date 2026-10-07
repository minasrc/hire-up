import { randomUUID } from 'node:crypto';

import { createClient } from '@supabase/supabase-js';

import { staffUploadReferenced } from './recruitment-operations.js';
import { ClientJobContractError } from './client-job-contracts.js';

export const CV_BUCKET = 'cv-submissions';

const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

export function assertCvFilename(filename) {
    if (
        typeof filename !== 'string' || filename.length === 0
        || filename.length > 512 || CONTROL_CHARS.test(filename)
    ) {
        throw new ClientJobContractError({ cvFile: 'The file name is not usable.' });
    }
    return filename;
}

export function createStaffCvStorage() {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceRoleKey) return null;
    return createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
}

export function staffCvObjectKey(organizationId, candidateId, extension) {
    return `staff/${organizationId}/${candidateId}/${randomUUID()}.${extension}`;
}

export async function removeUploadedObject(supabase, objectKey) {
    try {
        const { error } = await supabase.storage.from(CV_BUCKET).remove([objectKey]);
        if (error) {
            console.error(
                'upload cleanup failed', error?.statusCode ?? error?.name ?? 'UNKNOWN');
        }
    } catch (error) {
        console.error(
            'upload cleanup failed', (error)?.code ?? error?.name ?? 'UNKNOWN');
    }
}

export async function cleanupUploadDecision({ check, remove }) {
    let referenced = null;
    try {
        referenced = await check();
    } catch (error) {
        console.error(
            'upload reference check failed',
            (error)?.code ?? 'UNKNOWN',
        );
    }
    if (referenced === false) {
        await remove();
    }
}

export function cleanupUploadedObject(context, supabase, objectKey) {
    return cleanupUploadDecision({
        check: () => staffUploadReferenced(
            context.pool, context.identity, context.organizationId, objectKey),
        remove: () => removeUploadedObject(supabase, objectKey),
    });
}

export function shouldDiscardResultUpload(result) {
    return result?.status === 'duplicate' || result?.replayed === true;
}

export function createCandidateGateError(capabilities, { hasCv, hasJob, noteAllowed }) {
    if (!capabilities?.writeCandidates) return 'permission denied';
    if (hasCv && !capabilities?.uploadDocuments) return 'permission denied';
    if (hasJob && !capabilities?.addApplications) return 'permission denied';
    if (!noteAllowed) return 'permission denied';
    return null;
}
