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
    installStaffFixture,
    staffPoolOptions,
} from '../support/staff-authorization.js';
import { PRIVACY_MIGRATIONS } from '../support/privacy-foundation.js';
import { PRIVACY_OPS_MIGRATION } from '../support/privacy-operations.js';
import {
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
    '20261002100000_candidate_upload.sql',
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

test('candidate upload PostgreSQL atomicity, email safety and retry receipts', async (t) => {
    assertLocalTestEnvironment();
    const container = await startPostgresContainer('pgupload', POSTGRES_17_IMAGE, { publish: true });
    let pool;
    t.after(async () => { await pool?.end(); await stopAndRemoveContainer(container); });
    for (const file of MIGRATIONS) {
        if (file === '20261002100000_candidate_upload.sql') {
            for (const extra of (process.env.CANDIDATE_UPLOAD_EXTRA_MIGRATIONS ?? '').split(',').filter(Boolean)) psql(container, readFileSync(extra, 'utf8'));
        }
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
    psql(container, `update app.candidates set lifecycle = 'restricted' where id = '${input.candidateId}'`);
    await assert.rejects(save(makeInput('secondary@example.test', [])), { code: '42501' });
    psql(container, `update app.candidates set secondary_emails = array['clear@example.test'] where id = '${noSecondary.candidateId}'`);
    psql(container, `update app.candidates set full_name = null where id = '${noSecondary.candidateId}'`);
    assert.equal(scalar(container, `select count(*) from app.candidates where id = '${noSecondary.candidateId}' and first_name is null and last_name is null and compensation_preference is null and cardinality(secondary_emails) = 0`), '1');
    psql(container, `update app.candidates set lifecycle = 'deleted' where id = '${input.candidateId}'`);
    assert.equal(scalar(container, `select count(*) from app.candidates where id = '${input.candidateId}' and first_name is null and last_name is null and compensation_preference is null and cardinality(secondary_emails) = 0`), '1');
});
