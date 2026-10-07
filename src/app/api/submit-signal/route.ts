import { createHash, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { getIntakePool } from '@/lib/intake-db.server';
import {
    listPublicJobs,
    submitPublicApplication,
} from '@/lib/intake-operations';
import {
    readApplicationFields,
    validateApplicationFields,
} from '@/lib/application';
import { validateCvFile } from '@/lib/application-file';
import { rateLimitAllow } from '@/lib/rate-limit';

export const runtime = 'nodejs';

const CV_BUCKET = 'cv-submissions';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Per-IP submission throttle. Best-effort across serverless instances; the
// durable per-address cap lives in submit_public_application_v1.
const SUBMIT_RATE_LIMIT = { limit: 5, windowMs: 10 * 60 * 1000 };

const jsonError = (code: string, message: string, status: number) => (
    NextResponse.json({ success: false, code, message }, { status })
);

const requestIp = (req: Request) => {
    const forwarded = req.headers.get('x-forwarded-for');
    if (forwarded) {
        const first = forwarded.split(',')[0]?.trim();
        if (first) {
            return first;
        }
    }
    return req.headers.get('x-real-ip') ?? 'unknown';
};

const intakeUnavailable = () => jsonError(
    'SERVICE_UNAVAILABLE',
    'Applications are temporarily unavailable. Please try again later.',
    503,
);

export async function POST(req: Request) {
    try {
        const formData = await req.formData();

        const honeypot = formData.get('website') ?? formData.get('protocol_token');
        if (typeof honeypot === 'string' && honeypot.trim()) {
            return NextResponse.json(
                { success: true, message: 'Application received.' },
                { status: 202 },
            );
        }

        if (!rateLimitAllow(`submit:${requestIp(req)}`, SUBMIT_RATE_LIMIT)) {
            return jsonError(
                'RATE_LIMITED',
                'Too many submissions. Please try again later.',
                429,
            );
        }

        const pool = getIntakePool();
        const organizationId = process.env.STAFF_ORGANIZATION_ID;
        if (!pool || !organizationId) {
            console.error('Application submission is missing intake configuration.');
            return intakeUnavailable();
        }

        let listedJobs;
        try {
            listedJobs = (await listPublicJobs(pool, organizationId))?.jobs ?? [];
        } catch (error) {
            console.error('Public job listing failed during submission:', error);
            return intakeUnavailable();
        }

        const fields = readApplicationFields(formData);
        const submissionId = formData.get('submissionId');
        if (typeof submissionId !== 'string'
            || !UUID_PATTERN.test(submissionId)) {
            return jsonError('INVALID_APPLICATION', 'Please reopen the application and try again.', 400);
        }
        const fieldValidation = validateApplicationFields(
            fields,
            listedJobs.map((job: any) => ({ id: job.slug })),
        );
        if (!fieldValidation.ok) {
            if (fieldValidation.code === 'INVALID_JOB') {
                return jsonError(
                    'INVALID_JOB',
                    'This position is no longer accepting applications.',
                    400,
                );
            }
            return jsonError(fieldValidation.code, fieldValidation.message, 400);
        }
        const job = listedJobs.find(
            (entry: any) => entry.slug === fieldValidation.job.id);
        if (!job?.applicationOpen) {
            return jsonError(
                'INVALID_JOB',
                'This position is no longer accepting applications.',
                400,
            );
        }

        const cvFile = formData.get('cvFile');
        const fileValidation = await validateCvFile(cvFile);
        if (!fileValidation.ok) {
            return jsonError(fileValidation.code, fileValidation.message, 400);
        }

        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
        const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!supabaseUrl || !serviceRoleKey) {
            console.error('Application submission is missing Supabase configuration.');
            return intakeUnavailable();
        }
        const supabase = createClient(supabaseUrl, serviceRoleKey, {
            auth: { persistSession: false, autoRefreshToken: false },
        });

        const refId = `AG-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
        const bytes = Buffer.from(await fileValidation.file.arrayBuffer());
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const filePath = `cvs/${fieldValidation.job.id}/${refId}.${fileValidation.extension}`;

        const { error: uploadError } = await supabase.storage
            .from(CV_BUCKET)
            .upload(filePath, bytes, {
                contentType: fileValidation.mimeType,
                upsert: false,
            });

        if (uploadError) {
            console.error('CV upload failed:', uploadError);
            return jsonError(
                'CV_UPLOAD_FAILED',
                'Your CV could not be uploaded. Please try again.',
                500,
            );
        }

        let result;
        try {
            result = await submitPublicApplication(pool, organizationId, {
                jobSlug: fieldValidation.job.id,
                reference: refId,
                submissionId,
                fullName: fieldValidation.fields.fullName,
                email: fieldValidation.fields.email,
                professionalUrl: fieldValidation.fields.professionalUrl || null,
                achievement: fieldValidation.fields.technicalAchievement || null,
                document: {
                    sha256,
                    sizeBytes: bytes.length,
                    mimeType: fileValidation.mimeType,
                    extension: fileValidation.extension,
                    bucket: CV_BUCKET,
                    objectKey: filePath,
                    filename: fileValidation.file.name || `cv.${fileValidation.extension}`,
                },
            });
        } catch (error: any) {
            if (['54000', 'P0002', '22023', '23505'].includes(error?.code)) {
                const { error: cleanupError } = await supabase.storage
                    .from(CV_BUCKET)
                    .remove([filePath]);
                if (cleanupError) {
                    console.error('Failed to clean up rejected CV upload:', cleanupError);
                }
            }
            if (error?.code === '23505') {
                return jsonError(
                    'SUBMISSION_CONFLICT',
                    'This submission changed while it was being retried. Reopen the form and try again.',
                    409,
                );
            }
            if (error?.code === '54000') {
                return jsonError(
                    'RATE_LIMITED',
                    'Too many submissions. Please try again later.',
                    429,
                );
            }
            if (error?.code === 'P0002') {
                return jsonError(
                    'INVALID_JOB',
                    'This position is no longer accepting applications.',
                    400,
                );
            }
            if (error?.code === '22023') {
                return jsonError(
                    'INVALID_APPLICATION',
                    'Your application could not be validated. Please check the form and try again.',
                    400,
                );
            }
            console.error('Application write failed:', error);
            return jsonError(
                'APPLICATION_SAVE_FAILED',
                'Your application could not be saved. Please try again.',
                500,
            );
        }

        if (result?.duplicate) {
            // The verified chain belongs to the original application; this
            // upload is unreferenced and would orphan.
            const { error: cleanupError } = await supabase.storage
                .from(CV_BUCKET)
                .remove([filePath]);
            if (cleanupError) {
                console.error('Failed to clean up duplicate CV upload:', cleanupError);
            }
        }

        return NextResponse.json({
            success: true,
            refId: result?.publicReference ?? refId,
        });
    } catch (error) {
        console.error('Unexpected application submission failure:', error);
        return jsonError(
            'INTERNAL_SERVER_ERROR',
            'Applications are temporarily unavailable. Please try again later.',
            500,
        );
    }
}
