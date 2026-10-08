import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import {
    POSTGRES_17_IMAGE,
    assertLocalTestEnvironment,
    psql,
    startPostgresContainer,
    stopAndRemoveContainer,
} from '../support/foundation-docker.js';
import {
    AUTHZ_ID,
    GOOGLE_MIGRATION,
    INVITES_MIGRATION,
    INVITE_DOMAINS_MIGRATION,
    RUNTIME_ROLE,
    installStaffFixture,
    staffPoolOptions,
} from '../support/staff-authorization.js';
import { PRIVACY_MIGRATIONS } from '../support/privacy-foundation.js';
import { PRIVACY_OPS_MIGRATION } from '../support/privacy-operations.js';
import {
    CJ_ID,
    CJ_SUBJECTS,
    WORKFLOW_MIGRATION,
    clientJobFixtureSql,
} from '../support/client-job-workflows.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const migrationsDir = join(repoRoot, 'supabase', 'migrations');
const PROFILE_MIGRATION = '20260930090000_candidate_profiles.sql';
const SERIALIZATION_MIGRATION = '20260930090100_candidate_intake_serialization.sql';
const MIGRATIONS = [
    '20260922090000_foundation_roles.sql',
    '20260922090100_foundation_schema.sql',
    '20260922090200_foundation_seed.sql',
    '20260922130000_staff_authorization_core.sql',
    GOOGLE_MIGRATION,
    ...PRIVACY_MIGRATIONS,
    PRIVACY_OPS_MIGRATION,
    WORKFLOW_MIGRATION,
    '20260925100000_staff_totp.sql',
    '20260925110000_staff_listing.sql',
    INVITES_MIGRATION,
    INVITE_DOMAINS_MIGRATION,
    '20260925140000_application_pipeline.sql',
    '20260926140000_public_intake.sql',
    '20260928100000_staff_workspace.sql',
    '20260928220000_job_visibility.sql',
    PROFILE_MIGRATION,
    SERIALIZATION_MIGRATION,
    '20261001090000_public_intake_duplicate_review.sql',
    '20261001100000_candidate_merge.sql',
    '20261002100000_candidate_upload.sql',
    '20261009090000_document_preview_versions.sql',
];

const readMigration = (name) => readFileSync(join(migrationsDir, name), 'utf8');
const identity = (subject) => ({
    provider: 'google',
    issuer: 'https://accounts.google.com',
    subject,
});
const { ORG_B } = AUTHZ_ID;
const scalar = (container, sql) => psql(container, sql).trim();

import { saveCandidateUpload, candidateUploadReferenced, getCandidateUploadDetails } from '../../src/lib/candidate-upload-operations.js';
import { submitPublicApplication } from '../../src/lib/intake-operations.js';
import { listCandidateDuplicateReviews, getCandidateDuplicateComparison, mergeCandidateDuplicates } from '../../src/lib/duplicate-review-operations.js';
import { getCandidateProfile, resolveCandidateRedirect } from '../../src/lib/candidate-profile-read.js';
import { getDocumentDownload } from '../../src/lib/pipeline-operations.js';

test('candidate upload PostgreSQL atomicity, email safety and retry receipts', async (t) => {
    assertLocalTestEnvironment();
    const container = await startPostgresContainer('pgupload', POSTGRES_17_IMAGE, { publish: true });
    let pool;
    t.after(async () => { await pool?.end(); await stopAndRemoveContainer(container); });
    for (const file of MIGRATIONS) {
        psql(container, readMigration(file));
    }
    const password = installStaffFixture(container);
    psql(container, clientJobFixtureSql);
    pool = new pg.Pool(staffPoolOptions(container, password, 4));
    const actor = identity(CJ_SUBJECTS.ADMIN);
    const context = { pool, identity: actor, organizationId: ORG_B };
    const makeInput = (primaryEmail = 'upload@example.test', secondaryEmails = ['secondary@example.test']) => {
        const candidateId = randomUUID();
        return { candidateId, operationId: randomUUID(),
            fields: { firstName: 'Ada', lastName: 'Lovelace', primaryEmail, secondaryEmails, compensationPreference: 'EUR 100k' },
            document: { filename: 'CV.pdf', sha256: 'a'.repeat(64), sizeBytes: 500, extension: 'pdf', mimeType: 'application/pdf', objectKey: `staff/${ORG_B}/${candidateId}/${randomUUID()}.pdf` } };
    };
    const save = (input) => saveCandidateUpload(pool, actor, ORG_B, input);
    const input = makeInput();
    const result = await save(input);
    assert.equal(result.status, 'created');
    assert.equal(result.candidateId, input.candidateId);
    assert.equal(await candidateUploadReferenced(context, input.document.objectKey), true);
    assert.deepEqual(await getCandidateUploadDetails(pool, actor, ORG_B, { candidateId: result.candidateId }), { firstName: 'Ada', lastName: 'Lovelace', compensationPreference: 'EUR 100k', secondaryEmails: ['secondary@example.test'] });
    psql(container, `update app.candidates set contact_email = null where id = '${result.candidateId}'`);
    assert.deepEqual((await getCandidateUploadDetails(pool, actor, ORG_B, { candidateId: result.candidateId })).secondaryEmails, ['secondary@example.test']);
    psql(container, `update app.candidates set contact_email = 'SECONDARY@example.test' where id = '${result.candidateId}'`);
    assert.deepEqual((await getCandidateUploadDetails(pool, actor, ORG_B, { candidateId: result.candidateId })).secondaryEmails, []);
    psql(container, `update app.candidates set contact_email = 'upload@example.test' where id = '${result.candidateId}'`);
    assert.equal(scalar(container, `select count(*) from app.candidate_identifiers where candidate_id = '${result.candidateId}' and kind = 'email'`), '2');
    assert.equal(scalar(container, `select scan_state from app.file_blobs where candidate_id = '${result.candidateId}'`), 'unscanned');
    assert.equal(scalar(container, `select count(*) from app.documents d join app.candidates c on c.current_document_id = d.id where c.id = '${result.candidateId}'`), '1');
    const retry = makeInput(); retry.operationId = input.operationId;
    const replay = await save(retry);
    assert.equal(replay.replayed, true); assert.equal(replay.candidateId, input.candidateId);
    assert.equal(await candidateUploadReferenced(context, retry.document.objectKey), false);
    await assert.rejects(save({ ...retry, document: { ...retry.document, sha256: 'b'.repeat(64) } }), { code: '23505' });
    for (const candidate of [makeInput('secondary@example.test', []), makeInput('new@example.test', ['upload@example.test'])]) {
        const duplicate = await save(candidate); assert.equal(duplicate.status, 'duplicate'); assert.equal(duplicate.candidateId, input.candidateId);
        assert.equal(await candidateUploadReferenced(context, candidate.document.objectKey), false);
    }
    const broken = makeInput('rollback@example.test', []); broken.document.mimeType = 'text/plain';
    await assert.rejects(save(broken), { code: '22023' });
    assert.equal(scalar(container, `select count(*) from app.candidates where id = '${broken.candidateId}'`), '0');
    const concurrent = [makeInput('race1@example.test', ['shared@example.test']), makeInput('race2@example.test', ['shared@example.test'])];
    const raced = await Promise.all(concurrent.map(save));
    assert.deepEqual(raced.map(r => r.status).sort(), ['created','duplicate']);
    const noSecondary = await save(makeInput('single@example.test', [])); assert.equal(noSecondary.status, 'created');
    await assert.rejects(saveCandidateUpload(pool, identity(CJ_SUBJECTS.VIEWER), ORG_B, makeInput('denied@example.test', [])), { code: 'FORBIDDEN' });
    await t.test('uploaded CV survives duplicate intake and either merge direction', async () => {
        const jobId = randomUUID();
        psql(container, `
            grant app_intake to ${RUNTIME_ROLE};
            insert into app.role_permissions (organization_id, role_id, permission_key) values
                ('${ORG_B}', '${CJ_ID.ROLE_B_ADMIN}', 'duplicates.review'),
                ('${ORG_B}', '${CJ_ID.ROLE_B_ADMIN}', 'candidates.merge');
            insert into app.jobs (id,organization_id,client_id,pipeline_id,slug,title,description,
                location_display,employment_type,publication_state,application_state,
                publicly_listed,publication_reviewed_by,publication_reviewed_at,published_at)
            values ('${jobId}','${ORG_B}','${CJ_ID.CLIENT_LEGACY_B}','${CJ_ID.PIPELINE_B}',
                'upload-merge-job','Upload merge job','Synthetic','Remote','full_time','published','open',
                true,'${AUTHZ_ID.MEMBER_B_ADMIN}',now(),now());
        `);
        for (const keepUploaded of [true, false]) {
            const suffix = keepUploaded ? 'target' : 'source';
            const primary = `merge-${suffix}@example.test`;
            const secondary = `merge-${suffix}-secondary@example.test`;
            const uploadedInput = makeInput(primary, [secondary]);
            const uploaded = await save(uploadedInput);
            const intake = await submitPublicApplication(pool, ORG_B, {
                jobSlug: 'upload-merge-job', reference: keepUploaded ? 'AG-BBBB00000071' : 'AG-BBBB00000072',
                fullName: 'Ada Lovelace', email: secondary.toUpperCase(),
                professionalUrl: null, achievement: null, document: null, submissionId: randomUUID(),
            });
            assert.equal(intake.accepted, true);
            assert.notEqual(intake.candidateId, uploaded.candidateId, 'intake queues the possible match without auto-merging');
            const queue = await listCandidateDuplicateReviews(pool, actor, ORG_B);
            const review = queue.reviews.find((item) =>
                [item.candidateAId,item.candidateBId].includes(uploaded.candidateId)
                && [item.candidateAId,item.candidateBId].includes(intake.candidateId));
            assert.ok(review, 'uploaded secondary email participates in duplicate review');
            const comparison = await getCandidateDuplicateComparison(pool, actor, ORG_B, { reviewId: review.id });
            const targetId = keepUploaded ? uploaded.candidateId : intake.candidateId;
            const sourceId = keepUploaded ? intake.candidateId : uploaded.candidateId;
            const versionFor = (id) => [comparison.candidateA,comparison.candidateB].find((entry) => entry.candidate.candidateId === id).candidate.version;
            const merge = await mergeCandidateDuplicates(pool, actor, ORG_B, {
                reviewId: review.id, expectedVersion: review.version, targetCandidateId: targetId,
                expectedTargetVersion: versionFor(targetId), expectedSourceVersion: versionFor(sourceId),
                primaryEmail: secondary,
            });
            assert.equal(merge.targetCandidateId, targetId);
            assert.equal(await resolveCandidateRedirect(pool, actor, ORG_B, sourceId), targetId);
            const profile = await getCandidateProfile(pool, actor, ORG_B, { candidateId: targetId });
            assert.equal(profile.candidate.email.toLowerCase(), secondary, 'explicit merge primary controls displayed primary');
            assert.equal(profile.documents.length, 1);
            assert.equal(profile.applications.length, 1);
            assert.deepEqual([...new Set(profile.identifiers.filter((entry) => entry.kind === 'email').map((entry) => entry.value.toLowerCase()))].sort(), [primary,secondary].sort());
            assert.equal(await candidateUploadReferenced(context, uploadedInput.document.objectKey), true, 'merge cannot orphan the uploaded object');
            assert.equal(scalar(container, `select count(*) from app.documents d join app.file_blobs b on b.id = d.blob_id join app.blob_locations l on l.blob_id = b.id
                where d.id = '${uploaded.documentId}' and d.candidate_id = '${targetId}' and b.candidate_id = '${targetId}'
                and l.object_key = '${uploadedInput.document.objectKey}' and l.state = 'available'`), '1');
            const details = await getCandidateUploadDetails(pool, actor, ORG_B, { candidateId: targetId });
            assert.deepEqual(details.secondaryEmails, [], 'promoted upload secondary is not duplicated beneath current primary');
        }
    });
    await t.test('preview versions remain authorized, audited and sensitive to document state', async () => {
        const previewCandidate = await save(makeInput('preview-version@example.test', []));
        const candidateId = previewCandidate.candidateId;
        const documentId = scalar(container, `select current_document_id from app.candidates where id = '${candidateId}'`);
        const read = () => getDocumentDownload(pool, actor, ORG_B, { documentId });
        const first = await read();
        assert.match(first.previewVersion, /^[a-f0-9]{64}$/);
        assert.equal((await read()).previewVersion, first.previewVersion);
        assert.equal(scalar(container, `select count(*) from app.audit_events where target_id = '${documentId}' and action = 'document.downloaded'`), '2');
        psql(container, `update app.documents set original_filename = 'Revised.pdf', version = version + 1 where id = '${documentId}'`);
        assert.notEqual((await read()).previewVersion, first.previewVersion);
        for (const lifecycle of ['restricted', 'retired']) {
            psql(container, `update app.documents set lifecycle = '${lifecycle}' where id = '${documentId}'`);
            await assert.rejects(read(), { code: 'P0002' });
        }
        psql(container, `update app.documents set lifecycle = 'active' where id = '${documentId}';
            update app.file_blobs set scan_state = 'infected' where candidate_id = '${candidateId}'`);
        await assert.rejects(read(), { code: '42501' });
        psql(container, `update app.file_blobs set scan_state = 'unscanned' where candidate_id = '${candidateId}';
            update app.candidates set lifecycle = 'restricted' where id = '${candidateId}'`);
        await assert.rejects(read(), { code: 'P0002' });
        psql(container, `update app.candidates set lifecycle = 'active' where id = '${candidateId}';
            delete from app.role_permissions where organization_id = '${ORG_B}' and role_id = '${CJ_ID.ROLE_B_ADMIN}' and permission_key = 'documents.download'`);
        await assert.rejects(read(), { code: 'FORBIDDEN' });
        psql(container, `insert into app.role_permissions(organization_id, role_id, permission_key) values ('${ORG_B}', '${CJ_ID.ROLE_B_ADMIN}', 'documents.download');
            update app.organization_memberships set status = 'revoked', revoked_at = now() where id = '${CJ_ID.MEMBER_B_ADMIN}'`);
        await assert.rejects(read(), { code: 'UNAUTHORIZED' });
        psql(container, `update app.organization_memberships set status = 'active', revoked_at = null where id = '${CJ_ID.MEMBER_B_ADMIN}'`);
        assert.ok((await read()).previewVersion);
    });
    psql(container, `update app.candidates set lifecycle = 'restricted' where id = '${input.candidateId}'`);
    await assert.rejects(save(makeInput('secondary@example.test', [])), { code: '42501' });
    psql(container, `update app.candidates set secondary_emails = array['clear@example.test'] where id = '${noSecondary.candidateId}'`);
    psql(container, `update app.candidates set full_name = null where id = '${noSecondary.candidateId}'`);
    assert.equal(scalar(container, `select count(*) from app.candidates where id = '${noSecondary.candidateId}' and first_name is null and last_name is null and compensation_preference is null and cardinality(secondary_emails) = 0`), '1');
    psql(container, `update app.candidates set lifecycle = 'deleted' where id = '${input.candidateId}'`);
    assert.equal(scalar(container, `select count(*) from app.candidates where id = '${input.candidateId}' and first_name is null and last_name is null and compensation_preference is null and cardinality(secondary_emails) = 0`), '1');
});
