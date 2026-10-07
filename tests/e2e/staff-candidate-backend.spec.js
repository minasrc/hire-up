import { createClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';
import { randomInt, randomUUID } from 'node:crypto';
import pg from 'pg';
import { encode } from 'next-auth/jwt';
import { DOCX_MIME_TYPE } from '../../src/lib/application.js';
import { createSyntheticDocx, createSyntheticPdf } from '../support/cv-fixtures.js';
import { assertLocalSupabaseTarget } from '../support/nonproduction.js';
import {
    STAFF_MFA_COOKIE,
    createStaffMfaProof,
} from '../../src/lib/staff-mfa-cookie.js';

test.skip(process.env.E2E_REAL_BACKEND !== '1',
    'Set E2E_REAL_BACKEND=1 to test the staff workspace on local Supabase.');

const ORGANIZATION_ID = process.env.STAFF_ORGANIZATION_ID
    || '9c4edd11-2571-490b-a87c-ef30b9e0a001';
const DATABASE_URL = process.env.E2E_DATABASE_URL
    || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const BASE_URL = process.env.NEXTAUTH_URL || 'http://127.0.0.1:3000';
const SESSION_SECRET = process.env.NEXTAUTH_SECRET || 'local-playwright-secret';
const GOOGLE_ISSUER = 'https://accounts.google.com';
const ADMIN_ROLE = '9c4edd11-2571-490b-a87c-ef30b9e0a011';
const numericSubject = () =>
    `${randomInt(1, 10)}${String(randomInt(0, 1e12)).padStart(12, '0')}`;
const STAFF_SUBJECT = numericSubject();
const VIEWER_SUBJECT = numericSubject();

const ids = {
    staffUser: randomUUID(),
    staffMember: randomUUID(),
    staffIdentity: randomUUID(),
    staffTotp: randomUUID(),
    viewerUser: randomUUID(),
    viewerMember: randomUUID(),
    viewerIdentity: randomUUID(),
    viewerTotp: randomUUID(),
    viewerRole: randomUUID(),
    jobClient: randomUUID(),
    jobId: randomUUID(),
    jobRevision: randomUUID(),
};

const SEED_SQL = `
insert into app.users (id, display_name, status) values
    ('${ids.staffUser}', 'E2E Staff Member', 'active'),
    ('${ids.viewerUser}', 'E2E Read Only', 'active')
on conflict (id) do nothing;

insert into app.roles (id, organization_id, key, name, status, system_kind)
values ('${ids.viewerRole}', '${ORGANIZATION_ID}', 'e2e_readonly',
    'E2E Read Only', 'active', null)
on conflict (organization_id, key) do nothing;

insert into app.role_permissions (organization_id, role_id, permission_key)
select r.organization_id, r.id, grants.permission_key
from app.roles r
join (values
    ('candidates.read'),
    ('jobs.read'),
    ('clients.read'),
    ('applications.read'),
    ('collaboration.read')
) as grants (permission_key) on true
where r.organization_id = '${ORGANIZATION_ID}' and r.key = 'e2e_readonly'
on conflict do nothing;

insert into app.organization_memberships
    (id, organization_id, user_id, role_id, status, activated_at)
select m.id, m.organization_id, m.user_id, m.role_id, 'active', now()
from (values
    ('${ids.staffMember}'::uuid, '${ORGANIZATION_ID}'::uuid,
        '${ids.staffUser}'::uuid, '${ADMIN_ROLE}'::uuid),
    ('${ids.viewerMember}'::uuid, '${ORGANIZATION_ID}'::uuid,
        '${ids.viewerUser}'::uuid,
        (select id from app.roles
            where organization_id = '${ORGANIZATION_ID}'
                and key = 'e2e_readonly'))
) as m (id, organization_id, user_id, role_id)
on conflict (id) do nothing;

insert into app.auth_identities
    (id, user_id, provider, issuer, provider_subject, verified_at) values
    ('${ids.staffIdentity}', '${ids.staffUser}', 'google', '${GOOGLE_ISSUER}',
        '${STAFF_SUBJECT}', now()),
    ('${ids.viewerIdentity}', '${ids.viewerUser}', 'google', '${GOOGLE_ISSUER}',
        '${VIEWER_SUBJECT}', now())
on conflict (id) do nothing;

insert into app.totp_credentials
    (id, organization_id, user_id, secret, status, verified_at) values
    ('${ids.staffTotp}', '${ORGANIZATION_ID}', '${ids.staffUser}',
        'JBSWY3DPEHPK3PXP', 'active', now()),
    ('${ids.viewerTotp}', '${ORGANIZATION_ID}', '${ids.viewerUser}',
        'JBSWY3DPEHPK3PXP', 'active', now())
on conflict (id) do nothing;

insert into app.clients (id, organization_id, name, status)
values ('${ids.jobClient}', '${ORGANIZATION_ID}', 'E2E Staff Client', 'active')
on conflict (id) do nothing;

insert into app.jobs
    (id, organization_id, client_id, pipeline_id, slug, title, description,
     location_display, employment_type, publication_state, application_state,
     publicly_listed, publication_reviewed_by, publication_reviewed_at,
     published_at)
values ('${ids.jobId}', '${ORGANIZATION_ID}', '${ids.jobClient}',
    (select id from app.pipelines
        where organization_id = '${ORGANIZATION_ID}'
            and key = 'default' and status = 'active'),
    'e2e-staff-unlisted-${ids.jobId.slice(0, 8)}',
    'E2E Staff Unlisted Role', 'Hidden e2e role.',
    'Remote', 'full_time', 'published', 'open', false,
    '${ids.staffMember}', now(), now())
on conflict (id) do nothing;

insert into app.job_revisions
    (id, organization_id, job_id, revision_number, title, employment_type,
     workplace_mode, description_document, description_text, status,
     published_at, published_by_membership_id,
     published_client_profile_version, published_company_name,
     published_is_stealth)
select '${ids.jobRevision}', '${ORGANIZATION_ID}', '${ids.jobId}', 1,
    'E2E Staff Unlisted Role', 'full_time', 'remote',
    doc.doc, app.job_document_text_v1(doc.doc), 'published', now(),
    '${ids.staffMember}', 1, 'E2E Staff Client', false
from (values (
    '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Hidden e2e role."}]}]}'::jsonb
)) as doc(doc)
on conflict (id) do nothing;

update app.jobs set published_revision_id = '${ids.jobRevision}'
    where id = '${ids.jobId}' and published_revision_id is null;
`;

const query = async (sql) => {
    const client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
        const result = await client.query(sql);
        return result.rows;
    } finally {
        await client.end();
    }
};

const clickUntil = async (action, target, timeout = 30_000) =>
    expect(async () => {
        await action();
        await target.waitFor({ state: 'visible', timeout: 2000 });
    }).toPass({ timeout });

const staffCookies = async (subject, userId, credentialId, name, email) => {
    const sessionToken = await encode({
        token: {
            name,
            email,
            sub: subject,
            provider: 'google',
            providerAccountId: subject,
            googleRefreshToken: 'SYNTHETIC-WORKSPACE-TEST',
            emailVerified: true,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 3600,
        },
        secret: SESSION_SECRET,
    });
    const mfaProof = createStaffMfaProof(SESSION_SECRET, {
        subject,
        userId,
        credentialId,
    });
    return [
        {
            name: 'next-auth.session-token',
            value: sessionToken,
            url: BASE_URL,
            httpOnly: true,
            sameSite: 'Lax',
        },
        {
            name: STAFF_MFA_COOKIE,
            value: mfaProof,
            url: BASE_URL,
            httpOnly: true,
            sameSite: 'Lax',
        },
    ];
};

let createdCandidateId = null;
let firstDocumentId = null;
let secondDocumentId = null;
const createdEmails = [];

const cleanup = async () => {
    if (!createdEmails.length) return;
    const emails = createdEmails.map((email) => `'${email}'`).join(', ');
    createdEmails.length = 0;
    const scope = `
        select distinct i.candidate_id from app.candidate_identifiers i
        where i.organization_id = '${ORGANIZATION_ID}'
            and i.kind = 'email' and i.normalized_value in (${emails})`;
    const keys = await query(`
        select bl.object_key from app.blob_locations bl
        join app.file_blobs b on b.id = bl.blob_id
        where b.candidate_id in (${scope})`).catch(() => []);
    await query(`
        update app.candidates set current_document_id = null
            where id in (${scope});
        delete from app.application_stage_history sh
            using app.applications a
            where a.id = sh.application_id
                and a.candidate_id in (${scope});
        delete from app.application_documents ad
            using app.applications a
            where a.id = ad.application_id
                and a.candidate_id in (${scope});
        delete from app.blob_locations bl
            using app.file_blobs b
            where bl.blob_id = b.id
                and b.candidate_id in (${scope});
        delete from app.documents
            where candidate_id in (${scope});
        delete from app.file_blobs b
            where b.candidate_id in (${scope})
                and not exists (
                    select 1 from app.blob_locations bl
                    where bl.blob_id = b.id);
        delete from app.applications
            where candidate_id in (${scope});
        delete from app.candidate_notes
            where candidate_id in (${scope});
        delete from app.candidate_identifiers
            where candidate_id in (${scope});
        delete from app.candidate_sources
            where candidate_id in (${scope});
        delete from app.candidates where id in (${scope});
    `).catch(() => {});
    if (keys.length) {
        const supabase = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL || '',
            process.env.SUPABASE_SERVICE_ROLE_KEY || '',
            { auth: { persistSession: false, autoRefreshToken: false } });
        await supabase.storage.from('cv-submissions')
            .remove(keys.map((row) => row.object_key)).catch(() => {});
    }
    createdCandidateId = null;
};

test.beforeEach(async () => {
    assertLocalSupabaseTarget(process.env.NEXT_PUBLIC_SUPABASE_URL || '');
    await query(SEED_SQL);
});

test.afterEach(async () => {
    await cleanup();
});

test('staff create a candidate with a CV and manage document versions', async ({
    page,
    context,
}) => {
    test.setTimeout(240_000);
    await context.addCookies(await staffCookies(
        STAFF_SUBJECT, ids.staffUser, ids.staffTotp,
        'E2E Staff Member', 'e2e-staff@invalid.test'));
    await page.goto('/staff/candidates', { waitUntil: 'domcontentloaded' });
    const dialog = page.getByRole('dialog');
    await clickUntil(
        () => page.getByRole('button', { name: 'Add candidate' }).first().click(),
        dialog);
    const email = `e2e-candidate-${randomUUID().slice(0, 8)}@invalid.test`;
    createdEmails.push(email);
    await dialog.locator('#add-candidate-name').fill('E2E Storage Candidate');
    await dialog.locator('#add-candidate-email').fill(email);
    const jobSelect = dialog.locator('#add-candidate-job');
    if (await jobSelect.count()) {
        const option = jobSelect.locator(
            `option[value="${ids.jobId}"]`);
        if (await option.count()) {
            await jobSelect.selectOption(ids.jobId);
        }
    }
    const pdfBytes = createSyntheticPdf();
    await dialog.locator('#add-candidate-cv').setInputFiles({
        name: 'e2e-cv.pdf',
        mimeType: 'application/pdf',
        buffer: pdfBytes,
    });
    const posted = page.waitForResponse((response) => (
        response.url().includes('/api/staff/candidates')
        && !response.url().includes('/import')
        && response.request().method() === 'POST'));
    await dialog.getByRole('button', { name: 'Add candidate' }).click();
    const createResponse = await posted;
    expect(createResponse.ok()).toBe(true);
    await page.waitForURL(/\/staff\/candidates\/[0-9a-f-]{36}$/);
    createdCandidateId = page.url().split('/').pop();
    await page.getByText('E2E Storage Candidate').first().waitFor();

    const documents = await query(`
        select d.id::text, d.original_filename, d.version,
               bl.object_key, bl.bucket
        from app.documents d
        join app.blob_locations bl on bl.blob_id = d.blob_id
        where d.organization_id = '${ORGANIZATION_ID}'
            and d.candidate_id = '${createdCandidateId}'`);
    expect(documents).toHaveLength(1);
    expect(documents[0].bucket).toBe('cv-submissions');
    expect(documents[0].object_key).toContain('staff/');
    firstDocumentId = documents[0].id;

    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL || '',
        process.env.SUPABASE_SERVICE_ROLE_KEY || '',
        { auth: { persistSession: false, autoRefreshToken: false } });
    const download = await supabase.storage
        .from('cv-submissions')
        .download(documents[0].object_key);
    expect(download.error).toBeNull();
    expect(Buffer.from(await download.data.arrayBuffer())).toEqual(pdfBytes);

    await expect(async () => {
        await page.getByRole('tab', { name: /Documents/ }).click();
        await page.waitForURL(/tab=documents/, { timeout: 2000 });
    }).toPass();
    await page.getByText('e2e-cv.pdf').first().waitFor();

    const downloadResponse = await page.request.get(
        `/api/staff/documents/${firstDocumentId}`);
    expect(downloadResponse.ok()).toBe(true);
    expect(Buffer.from(await downloadResponse.body())).toEqual(pdfBytes);

    const inline = await page.request.get(
        `/api/staff/documents/${firstDocumentId}?inline=1&format=json`);
    expect(inline.ok()).toBe(true);
    const inlinePayload = await inline.json();
    expect(inlinePayload.url).toMatch(/^https?:\/\//);

    const docxBytes = createSyntheticDocx();
    await page.locator('#candidate-cv-file').setInputFiles({
        name: 'e2e-cv-v2.docx',
        mimeType: DOCX_MIME_TYPE,
        buffer: docxBytes,
    });
    const uploaded = page.waitForResponse((response) => (
        response.url().includes('/documents')
        && response.request().method() === 'POST' && response.ok()));
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    await uploaded;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(async () => {
        await page.getByRole('tab', { name: /Documents/ }).click();
        await page.waitForURL(/tab=documents/, { timeout: 2000 });
    }).toPass();
    const versionSelect = page.locator('#candidate-doc-version');
    await expect(versionSelect.locator('option')).toHaveCount(2);
    const versions = await query(`
        select d.id::text, d.version, bl.object_key from app.documents d
        join app.blob_locations bl on bl.blob_id = d.blob_id
        where d.organization_id = '${ORGANIZATION_ID}'
            and d.candidate_id = '${createdCandidateId}'
        order by d.version`);
    expect(versions).toHaveLength(2);
    secondDocumentId = versions[1].id;
    const docxDownload = await supabase.storage
        .from('cv-submissions')
        .download(versions[1].object_key);
    expect(docxDownload.error).toBeNull();
    expect(Buffer.from(await docxDownload.data.arrayBuffer()))
        .toEqual(docxBytes);
    await page.getByText('Preview unavailable for this file').waitFor();
    const secondDownload = await page.request.get(
        `/api/staff/documents/${secondDocumentId}`);
    expect(secondDownload.ok()).toBe(true);
    expect(Buffer.from(await secondDownload.body())).toEqual(docxBytes);
    await versionSelect.selectOption(firstDocumentId);
    await page.getByText('e2e-cv.pdf').first().waitFor();
});

test('anonymous and read-only staff cannot write candidate storage', async ({
    browser,
}) => {
    const deniedEmail = `denied-${randomUUID().slice(0, 8)}@invalid.test`;
    const multipart = {
        action: 'createCandidate',
        fields: JSON.stringify({
            fullName: 'Denied Candidate',
            email: deniedEmail,
            source: 'manual',
        }),
        operationId: randomUUID(),
        cvFile: {
            name: 'cv.pdf',
            mimeType: 'application/pdf',
            buffer: createSyntheticPdf(),
        },
    };

    const anonymous = await browser.newContext({ baseURL: BASE_URL });
    try {
        const response = await anonymous.request.post(
            '/api/staff/candidates', { multipart });
        expect(response.status()).toBe(401);
    } finally {
        await anonymous.close();
    }

    const viewer = await browser.newContext({ baseURL: BASE_URL });
    try {
        await viewer.addCookies(await staffCookies(
            VIEWER_SUBJECT, ids.viewerUser, ids.viewerTotp,
            'E2E Read Only', 'e2e-viewer@invalid.test'));
        const response = await viewer.request.post(
            '/api/staff/candidates', {
                multipart: {
                    ...multipart,
                    operationId: randomUUID(),
                },
            });
        expect(response.status()).toBe(403);
    } finally {
        await viewer.close();
    }

    const created = await query(`
        select count(*)::text as count from app.candidate_identifiers
        where organization_id = '${ORGANIZATION_ID}'
            and kind = 'email' and normalized_value = '${deniedEmail}'`);
    expect(created[0].count).toBe('0');
});
