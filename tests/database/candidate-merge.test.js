import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import {
    POSTGRES_17_IMAGE, assertLocalTestEnvironment, psql,
    startPostgresContainer, stopAndRemoveContainer,
} from '../support/foundation-docker.js';
import {
    AUTHZ_ID, GOOGLE_MIGRATION, INVITES_MIGRATION,
    INVITE_DOMAINS_MIGRATION, installStaffFixture, staffPoolOptions,
} from '../support/staff-authorization.js';
import { PRIVACY_MIGRATIONS } from '../support/privacy-foundation.js';
import { PRIVACY_OPS_MIGRATION } from '../support/privacy-operations.js';
import { CJ_ID, WORKFLOW_MIGRATION, clientJobFixtureSql } from '../support/client-job-workflows.js';
import {
    getCandidateDuplicateComparison, listCandidateDuplicateReviews,
    mergeCandidateDuplicates,
} from '../../src/lib/duplicate-review-operations.js';
import { getCandidateProfile, resolveCandidateRedirect } from '../../src/lib/candidate-profile-operations.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const org = AUTHZ_ID.ORG_B;
const admin = { provider: 'google', issuer: 'https://accounts.google.com', subject: '1002' };
const recruiter = { provider: 'google', issuer: 'https://accounts.google.com', subject: '2002' };
const migrations = [
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
    '20260930090000_candidate_profiles.sql',
    '20260930090100_candidate_intake_serialization.sql',
    '20261001090000_public_intake_duplicate_review.sql',
    '20261001100000_candidate_merge.sql',
];

test('admin merges applications, emails and identical CVs atomically', async (t) => {
    assertLocalTestEnvironment();
    const db = await startPostgresContainer('pgmergereview', POSTGRES_17_IMAGE, {
        publish: true,
    });
    let pool;
    t.after(async () => {
        if (pool) await pool.end();
        stopAndRemoveContainer(db);
    });
    for (const name of migrations) {
        psql(db, readFileSync(join(root, 'supabase', 'migrations', name), 'utf8'));
    }
    const password = installStaffFixture(db);
    psql(db, clientJobFixtureSql);
    pool = new pg.Pool(staffPoolOptions(db, password, 2));

    const source = randomUUID();
    const target = CJ_ID.CANDIDATE_B;
    const sourceId = randomUUID();
    const targetId = randomUUID();
    const sourceEmail = randomUUID();
    const targetEmail = randomUUID();
    const secondaryEmail = randomUUID();
    const sourceApp = randomUUID();
    const sourceBlob = randomUUID();
    const targetBlob = randomUUID();
    const extraBlob = randomUUID();
    const sourceDoc = randomUUID();
    const targetDoc = randomUUID();
    const extraDoc = randomUUID();
    const job = randomUUID();
    const note = randomUUID();
    const sha = 'a'.repeat(64);
    const otherSha = 'b'.repeat(64);
    psql(db, `
        insert into app.role_permissions (organization_id, role_id, permission_key)
        values ('${org}', '${CJ_ID.ROLE_B_ADMIN}', 'duplicates.review'),
            ('${org}', '${CJ_ID.ROLE_B_ADMIN}', 'candidates.merge'),
            ('${org}', '${CJ_ID.ROLE_B_RECRUITER}', 'duplicates.review');
        insert into app.jobs (id, organization_id, client_id, pipeline_id, slug,
            title, description, location_display, employment_type,
            publication_state, application_state)
        values ('${job}', '${org}', '${CJ_ID.CLIENT_LEGACY_B}',
            '${CJ_ID.PIPELINE_B}', 'second-synthetic-job', 'Second Job',
            'Synthetic', 'Remote', 'full_time', 'draft', 'open');
        insert into app.candidates (id, organization_id, full_name, identity_state,
            lifecycle) values ('${source}', '${org}', 'Source Candidate', 'provisional', 'active');
        insert into app.candidate_sources (id, organization_id, candidate_id, kind,
            received_at) values
            ('${sourceId}', '${org}', '${source}', 'public_application', now()),
            ('${targetId}', '${org}', '${target}', 'manual', now());
        insert into app.candidate_identifiers (id, organization_id, candidate_id,
            kind, raw_value, normalized_value, normalization_version, verification,
            source_id, received_at) values
            ('${sourceEmail}', '${org}', '${source}', 'email', 'sam@example.test',
                'sam@example.test', 1, 'unverified', '${sourceId}', now()),
            ('${secondaryEmail}', '${org}', '${source}', 'email', 'other@example.test',
                'other@example.test', 1, 'unverified', '${sourceId}', now()),
            ('${targetEmail}', '${org}', '${target}', 'email', 'SAM@example.test',
                'sam@example.test', 1, 'unverified', '${targetId}', now());
        insert into app.applications (id, organization_id, candidate_id, job_id,
            pipeline_id, stage_id, public_reference, reference_version,
            source_id, received_at) values ('${sourceApp}', '${org}', '${source}',
            '${job}', '${CJ_ID.PIPELINE_B}', '${CJ_ID.STAGE_B_1}',
            'AG-BBBB00000001', 1, '${sourceId}', now());
        insert into app.file_blobs (id, organization_id, candidate_id, sha256,
            size_bytes, mime_type, extension, lifecycle, scan_state) values
            ('${sourceBlob}', '${org}', '${source}', decode('${sha}', 'hex'),
                512, 'application/pdf', 'pdf', 'live', 'unscanned'),
            ('${targetBlob}', '${org}', '${target}', decode('${sha}', 'hex'),
                512, 'application/pdf', 'pdf', 'live', 'unscanned'),
            ('${extraBlob}', '${org}', '${source}', decode('${otherSha}', 'hex'),
                256, 'application/pdf', 'pdf', 'live', 'unscanned');
        insert into app.blob_locations (id, organization_id, blob_id, backend_key,
            bucket, object_key, state, is_primary, verified_sha256,
            verified_size_bytes, verified_at) values
            ('${randomUUID()}', '${org}', '${sourceBlob}', 'supabase_storage',
                'cv-submissions', '${sourceBlob}.pdf', 'available', true,
                decode('${sha}', 'hex'), 512, now()),
            ('${randomUUID()}', '${org}', '${targetBlob}', 'supabase_storage',
                'cv-submissions', '${targetBlob}.pdf', 'available', true,
                decode('${sha}', 'hex'), 512, now()),
            ('${randomUUID()}', '${org}', '${extraBlob}', 'supabase_storage',
                'cv-submissions', '${extraBlob}.pdf', 'available', true,
                decode('${otherSha}', 'hex'), 256, now());
        update app.blob_locations set state = 'missing'
        where blob_id = '${targetBlob}';
        insert into app.documents (id, organization_id, candidate_id, blob_id,
            purpose, original_filename, source_id, received_at, lifecycle) values
            ('${sourceDoc}', '${org}', '${source}', '${sourceBlob}', 'cv',
                'source.pdf', '${sourceId}', now(), 'active'),
            ('${targetDoc}', '${org}', '${target}', '${targetBlob}', 'cv',
                'target.pdf', '${targetId}', now(), 'active'),
            ('${extraDoc}', '${org}', '${source}', '${extraBlob}', 'cv',
                'extra.pdf', '${sourceId}', now(), 'active');
        insert into app.application_documents (organization_id, candidate_id,
            application_id, document_id, submitted_filename, attached_at) values
            ('${org}', '${source}', '${sourceApp}', '${sourceDoc}', 'source.pdf', now());
        update app.candidates set current_document_id = '${sourceDoc}'
        where id = '${source}';
        update app.candidates set current_document_id = '${targetDoc}'
        where id = '${target}';
        insert into app.candidate_notes (id, organization_id, candidate_id,
            author_membership_id, body) values ('${note}', '${org}', '${source}',
            '${AUTHZ_ID.MEMBER_B_ADMIN}', 'Source note');
    `);

    const queue = await listCandidateDuplicateReviews(pool, admin, org);
    const review = queue.reviews.find((item) =>
        [item.candidateAId, item.candidateBId].includes(source)
        && [item.candidateAId, item.candidateBId].includes(target));
    assert.ok(review);
    const comparison = await getCandidateDuplicateComparison(pool, admin, org, {
        reviewId: review.id,
    });
    assert.equal(comparison.canMerge, true);
    const expectedTargetVersion = Number(comparison.candidateA.candidate.candidateId === target
        ? comparison.candidateA.candidate.version : comparison.candidateB.candidate.version);
    const expectedSourceVersion = Number(comparison.candidateA.candidate.candidateId === source
        ? comparison.candidateA.candidate.version : comparison.candidateB.candidate.version);
    const request = {
        reviewId: review.id, expectedVersion: review.version, targetCandidateId: target,
        expectedTargetVersion, expectedSourceVersion, primaryEmail: 'SAM@example.test',
    };
    await assert.rejects(
        mergeCandidateDuplicates(pool, recruiter, org, request),
        (error) => error.code === 'FORBIDDEN',
    );
    const result = await mergeCandidateDuplicates(pool, admin, org, request);
    assert.equal(result.targetCandidateId, target);
    assert.equal(result.sourceCandidateId, source);
    assert.equal(await resolveCandidateRedirect(pool, admin, org, source), target);
    const profile = await getCandidateProfile(pool, admin, org, { candidateId: target });
    assert.equal(profile.applications.length, 2);
    assert.equal(profile.documents.length, 3);
    assert.equal(profile.notes.length, 1);
    assert.equal(profile.candidate.email, 'SAM@example.test');
    assert.equal(psql(db, `select count(*) from app.candidate_identifiers
        where candidate_id = '${target}' and kind = 'email'`).trim(), '3');
    assert.equal(psql(db, `select count(*) from app.file_blobs
        where candidate_id = '${source}' and lifecycle = 'retired'`).trim(), '1');
    assert.equal(psql(db, `select count(*) from app.documents
        where candidate_id = '${target}' and blob_id = '${targetBlob}'`).trim(), '2');
    assert.equal(psql(db, `select count(*) from app.blob_locations
        where blob_id = '${targetBlob}'`).trim(), '2');
    assert.equal(psql(db, `select object_key from app.blob_locations
        where blob_id = '${targetBlob}' and is_primary`).trim(), `${sourceBlob}.pdf`);
    assert.equal(psql(db, `select count(*) from app.file_blobs
        where candidate_id = '${target}' and id = '${extraBlob}' and lifecycle = 'live'`).trim(), '1');
    assert.equal(psql(db, `select count(*) from app.candidate_merge_events
        where source_candidate_id = '${source}' and target_candidate_id = '${target}'`).trim(), '1');
    const retry = await mergeCandidateDuplicates(pool, admin, org, request);
    assert.equal(retry.replayed, true);

    const privacyA = randomUUID();
    const privacyB = randomUUID();
    psql(db, `
        insert into app.candidates (id, organization_id, full_name,
            identity_state, lifecycle) values
            ('${privacyA}', '${org}', 'Privacy A', 'provisional', 'active'),
            ('${privacyB}', '${org}', 'Privacy B', 'provisional', 'active');
        insert into app.candidate_identifiers (id, organization_id,
            candidate_id, kind, raw_value, normalized_value,
            normalization_version, verification, received_at) values
            ('${randomUUID()}', '${org}', '${privacyA}', 'email',
                'privacy@example.test', 'privacy@example.test', 1, 'unverified', now()),
            ('${randomUUID()}', '${org}', '${privacyB}', 'email',
                'privacy@example.test', 'privacy@example.test', 1, 'unverified', now());
        insert into app.privacy_requests (id, organization_id, candidate_id,
            kind, status, received_at) values ('${randomUUID()}', '${org}',
            '${privacyA}', 'access', 'received', now());
    `);
    const privacyQueue = await listCandidateDuplicateReviews(pool, admin, org);
    const privacyReview = privacyQueue.reviews.find((item) =>
        [item.candidateAId, item.candidateBId].includes(privacyA)
        && [item.candidateAId, item.candidateBId].includes(privacyB));
    assert.ok(privacyReview);
    await assert.rejects(mergeCandidateDuplicates(pool, admin, org, {
        reviewId: privacyReview.id, expectedVersion: privacyReview.version,
        targetCandidateId: privacyB, expectedTargetVersion: 1,
        expectedSourceVersion: 1, primaryEmail: 'privacy@example.test',
    }), (error) => error.code === '23514');
    assert.equal(psql(db, `select count(*) from app.candidates
        where id in ('${privacyA}', '${privacyB}') and lifecycle = 'active'`).trim(), '2');
});
