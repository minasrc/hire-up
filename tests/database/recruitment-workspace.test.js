import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import {
    POSTGRES_17_IMAGE,
    assertLocalTestEnvironment,
    assertSqlstate,
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
import {
    createJobDraft,
    previewJobPublic,
    publishJobRevision,
    setJobPublicListing,
    saveClient,
} from '../../src/lib/client-job-operations.js';
import {
    addCandidateDocument,
    addCandidateToJob,
    createStaffCandidate,
    duplicateJob,
    getCandidateWorkspace,
    getClientWorkspace,
    getRecruitmentContext,
    listApplicationDirectory,
    listCandidateDirectory,
    listPrivacyCases,
    listWorkspaceJobs,
    reviewCandidateImport,
    saveCandidateProfile,
    tagCandidates,
} from '../../src/lib/recruitment-operations.js';
import { getDocumentDownload } from '../../src/lib/pipeline-operations.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const migrationsDir = join(repoRoot, 'supabase', 'migrations');
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
    '20260930090000_staff_candidate_management.sql',
    '20260930090100_staff_workspace_views.sql',
    '20260930090200_candidate_intake_safety.sql',
];

const readMigration = (name) => readFileSync(join(migrationsDir, name), 'utf8');
const identity = (subject) => ({
    provider: 'google',
    issuer: 'https://accounts.google.com',
    subject,
});
const { ORG_A, ORG_B } = AUTHZ_ID;
const scalar = (container, sql) => psql(container, sql).trim();

const rejectCode = async (promise, code, label) => {
    await assert.rejects(
        promise,
        (error) => error.code === code,
        label ?? `expected ${code}`,
    );
};

const uid = () => randomUUID();

const FIX = {
    client: uid(),
    jobListed: uid(),
    jobUnlisted: uid(),
    jobLink: uid(),
    ada: uid(),
    bob: uid(),
    casey: uid(),
    adaListed: uid(),
    adaUnlisted: uid(),
    bobListed: uid(),
    caseyUnlisted: uid(),
};

const recruitmentFixtureSql = `
insert into app.role_permissions (organization_id, role_id, permission_key) values
    ('${ORG_B}', '${CJ_ID.ROLE_B_ADMIN}', 'privacy.manage'),
    ('${ORG_B}', '${CJ_ID.ROLE_B_RECRUITER}', 'candidates.write'),
    ('${ORG_B}', '${CJ_ID.ROLE_B_RECRUITER}', 'applications.stage'),
    ('${ORG_B}', '${CJ_ID.ROLE_B_RECRUITER}', 'collaboration.read'),
    ('${ORG_B}', '${CJ_ID.ROLE_B_RECRUITER}', 'collaboration.write'),
    ('${ORG_B}', '${CJ_ID.ROLE_B_RECRUITER}', 'documents.write'),
    ('${ORG_B}', '${CJ_ID.ROLE_B_RECRUITER}', 'documents.download'),
    ('${ORG_B}', '${CJ_ID.ROLE_B_VIEWER}', 'candidates.read')
on conflict do nothing;
insert into app.clients (id, organization_id, name, status) values
    ('${FIX.client}', '${ORG_B}', 'Count Fixture Client', 'active');
insert into app.jobs (id, organization_id, client_id, pipeline_id, slug, title,
        description, location_display, employment_type, publication_state,
        application_state, publicly_listed, publication_reviewed_by,
        publication_reviewed_at, published_at) values
    ('${FIX.jobListed}', '${ORG_B}', '${FIX.client}', '${CJ_ID.PIPELINE_B}',
        'count-listed', 'Count Listed Job', 'Fixture', 'Berlin', 'full_time',
        'published', 'open', true, '${CJ_ID.MEMBER_B_ADMIN}', now(), now()),
    ('${FIX.jobUnlisted}', '${ORG_B}', '${FIX.client}', '${CJ_ID.PIPELINE_B}',
        'count-unlisted', 'Count Unlisted Job', 'Fixture', 'Remote', 'contract',
        'published', 'open', false, '${CJ_ID.MEMBER_B_ADMIN}', now(), now()),
    ('${FIX.jobLink}', '${ORG_B}', '${CJ_ID.CLIENT_LEGACY_B}', '${CJ_ID.PIPELINE_B}',
        'link-target', 'Link Target Job', 'Fixture', 'Remote', 'contract',
        'published', 'open', false, '${CJ_ID.MEMBER_B_ADMIN}', now(), now());
insert into app.candidates (id, organization_id, full_name, identity_state, lifecycle) values
    ('${FIX.ada}', '${ORG_B}', 'Count Ada', 'established', 'active'),
    ('${FIX.bob}', '${ORG_B}', 'Count Bob', 'established', 'active'),
    ('${FIX.casey}', '${ORG_B}', 'Casey Restricted', 'established', 'restricted');
insert into app.candidate_identifiers
        (id, organization_id, candidate_id, kind, raw_value, normalized_value,
         normalization_version, verification, received_at) values
    ('${uid()}', '${ORG_B}', '${FIX.casey}', 'email', 'casey@example.test',
        'casey@example.test', 1, 'unverified', now());
insert into app.applications (id, organization_id, candidate_id, job_id, pipeline_id,
        stage_id, public_reference, reference_version, received_at) values
    ('${FIX.adaListed}', '${ORG_B}', '${FIX.ada}', '${FIX.jobListed}',
        '${CJ_ID.PIPELINE_B}', '${CJ_ID.STAGE_B_2}', 'AG-000000C00A01', 1, now()),
    ('${FIX.adaUnlisted}', '${ORG_B}', '${FIX.ada}', '${FIX.jobUnlisted}',
        '${CJ_ID.PIPELINE_B}', '${CJ_ID.STAGE_B_1}', 'AG-000000C00A02', 1, now()),
    ('${FIX.bobListed}', '${ORG_B}', '${FIX.bob}', '${FIX.jobListed}',
        '${CJ_ID.PIPELINE_B}', '${CJ_ID.STAGE_B_1}', 'AG-000000C00B01', 1, now()),
    ('${FIX.caseyUnlisted}', '${ORG_B}', '${FIX.casey}', '${FIX.jobUnlisted}',
        '${CJ_ID.PIPELINE_B}', '${CJ_ID.STAGE_B_1}', 'AG-000000C00C01', 1, now());
`;

const FIELDS = (overrides = {}) => ({
    fullName: overrides.fullName ?? `Recruit ${uid().slice(0, 8)}`,
    headline: null,
    location: null,
    email: null,
    professionalUrl: null,
    ownerMembershipId: null,
    professionalSummary: null,
    availability: 'not_specified',
    tags: [],
    skills: [],
    experience: [],
    source: 'manual',
    ...overrides,
});

test('recruitment workspace on PostgreSQL 17', async (t) => {
    assertLocalTestEnvironment();
    const adminPassword = randomUUID();
    const pg17 = await startPostgresContainer('pgrecruitment', POSTGRES_17_IMAGE, {
        publish: true,
        password: adminPassword,
    });
    let pool;
    let pool1;
    t.after(async () => {
        await pool?.end().catch(() => {});
        await pool1?.end().catch(() => {});
        await stopAndRemoveContainer(pg17);
    });
    const pgOperator = await startPostgresContainer('pgrecruitmentop', POSTGRES_17_IMAGE);
    t.after(() => stopAndRemoveContainer(pgOperator));

    for (const fileName of MIGRATIONS) {
        psql(pg17, readMigration(fileName));
    }
    const runtimePassword = installStaffFixture(pg17);
    psql(pg17, clientJobFixtureSql);
    psql(pg17, recruitmentFixtureSql);

    pool = new pg.Pool(staffPoolOptions(pg17, runtimePassword, 6));
    pool1 = new pg.Pool(staffPoolOptions(pg17, runtimePassword, 1));
    psql(pg17, `grant app_intake to ${RUNTIME_ROLE}`);

    const admin = (fn, input) => fn(pool, identity(CJ_SUBJECTS.ADMIN), ORG_B, input);
    const recruiter = (fn, input) => fn(pool, identity(CJ_SUBJECTS.RECRUITER), ORG_B, input);
    const viewer = (fn, input) => fn(pool, identity(CJ_SUBJECTS.VIEWER), ORG_B, input);
    const orgA = (fn, input) => fn(pool, identity('1001'), ORG_A, input);

    await t.test('context reports capability-gated options', async () => {
        const context = await admin(getRecruitmentContext);
        assert.equal(context.capabilities.readCandidates, true);
        assert.equal(context.capabilities.writeCandidates, true);
        assert.equal(context.capabilities.readApplications, true);
        assert.equal(context.capabilities.writeJobs, true);
        assert.equal(context.capabilities.uploadDocuments, true);
        assert.equal(context.capabilities.downloadDocuments, true);
        assert.equal(context.capabilities.readNotes, true);
        assert.equal(context.capabilities.writeNotes, true);
        assert.equal(context.capabilities.managePrivacy, true);
        assert.ok(Array.isArray(context.owners) && context.owners.length >= 3);
        assert.ok(
            context.jobs.some((job) => job.id === FIX.jobUnlisted),
            'published open unlisted jobs must appear as add-to-job options',
        );

        const restricted = await viewer(getRecruitmentContext);
        assert.equal(restricted.capabilities.readCandidates, true);
        assert.equal(restricted.capabilities.writeCandidates, false);
        assert.equal(restricted.capabilities.readNotes, false);
        assert.equal(restricted.capabilities.writeNotes, false);
        assert.equal(restricted.capabilities.managePrivacy, false);
    });

    await t.test('candidate create, edit and stale-version guards', async () => {
        const candidateId = uid();
        const created = await admin(createStaffCandidate, {
            candidateId,
            fields: FIELDS({ fullName: 'Recruit No Email' }),
            operationId: uid(),
        });
        assert.equal(created.status, 'created');
        assert.equal(created.candidateId, candidateId);

        const workspace = await admin(getCandidateWorkspace, candidateId);
        assert.equal(workspace.candidate.fullName, 'Recruit No Email');
        const version = workspace.candidate.version;

        const updated = await admin(saveCandidateProfile, {
            candidateId,
            expectedVersion: version,
            fields: FIELDS({
                fullName: 'Recruit No Email',
                headline: 'Staff Engineer',
                location: 'Berlin',
                email: 'recruit.noemail@example.test',
                professionalSummary: 'Synthetic profile summary.',
                tags: ['platform', 'backend'],
                skills: ['postgres'],
                experience: [{
                    role: 'Engineer', company: 'Acme', period: '2020-2024',
                    description: 'Synthetic work.',
                }],
            }),
            operationId: uid(),
        });
        assert.equal(updated.status, 'updated');
        const after = await admin(getCandidateWorkspace, candidateId);
        assert.equal(after.candidate.headline, 'Staff Engineer');
        assert.equal(after.candidate.email, 'recruit.noemail@example.test');
        assert.deepEqual(after.candidate.tags, ['backend', 'platform'].sort());

        const cleared = await admin(saveCandidateProfile, {
            candidateId,
            expectedVersion: after.candidate.version,
            fields: FIELDS({ fullName: 'Recruit No Email' }),
            operationId: uid(),
        });
        assert.equal(cleared.status, 'updated');
        const clearedWorkspace = await admin(getCandidateWorkspace, candidateId);
        assert.equal(clearedWorkspace.candidate.email, null);
        assert.equal(clearedWorkspace.candidate.headline, null);
        assert.deepEqual(clearedWorkspace.candidate.tags, []);

        await rejectCode(
            admin(saveCandidateProfile, {
                candidateId,
                expectedVersion: version,
                fields: FIELDS({ fullName: 'Recruit No Email' }),
                operationId: uid(),
            }),
            '40001',
            'stale expectedVersion must raise a serialization conflict',
        );
    });

    await t.test('duplicate emails dedupe without overwriting the existing record', async () => {
        const firstId = uid();
        await admin(createStaffCandidate, {
            candidateId: firstId,
            fields: FIELDS({ fullName: 'Dedupe Original', email: 'Dedupe@Example.Test' }),
            operationId: uid(),
        });
        const second = await admin(createStaffCandidate, {
            candidateId: uid(),
            fields: FIELDS({
                fullName: 'Dedupe Different Name',
                email: 'dedupe@example.test',
            }),
            operationId: uid(),
        });
        assert.equal(second.status, 'duplicate');
        assert.equal(second.candidateId, firstId);
        const original = await admin(getCandidateWorkspace, firstId);
        assert.equal(original.candidate.fullName, 'Dedupe Original');
    });

    await t.test('distinct candidates may share a name', async () => {
        const a = await admin(createStaffCandidate, {
            candidateId: uid(),
            fields: FIELDS({ fullName: 'Shared Name Person' }),
            operationId: uid(),
        });
        const b = await admin(createStaffCandidate, {
            candidateId: uid(),
            fields: FIELDS({
                fullName: 'Shared Name Person',
                email: 'shared.other@example.test',
            }),
            operationId: uid(),
        });
        assert.equal(a.status, 'created');
        assert.equal(b.status, 'created');
        assert.notEqual(b.candidateId, a.candidateId);
    });

    await t.test('staff cannot create a record for a restricted identity', async () => {
        await rejectCode(
            admin(createStaffCandidate, {
                candidateId: uid(),
                fields: FIELDS({
                    fullName: 'Restricted Attempt',
                    email: 'casey@example.test',
                }),
                operationId: uid(),
            }),
            '42501',
            'restricted identities are denied rather than merged or overwritten',
        );
    });

    await t.test('operation replay returns the original result without new rows', async () => {
        const operationId = uid();
        const candidateId = uid();
        const first = await admin(createStaffCandidate, {
            candidateId,
            fields: FIELDS({ fullName: 'Replay Person' }),
            operationId,
        });
        const before = Number(scalar(pg17,
            `select count(*) from app.candidates where organization_id = '${ORG_B}'`));
        const replay = await admin(createStaffCandidate, {
            candidateId: uid(),
            fields: FIELDS({ fullName: 'Replay Person' }),
            operationId,
        });
        assert.equal(replay.replayed, true);
        assert.equal(replay.candidateId, first.candidateId);
        assert.equal(replay.status, 'created');
        const after = Number(scalar(pg17,
            `select count(*) from app.candidates where organization_id = '${ORG_B}'`));
        assert.equal(after, before);
    });

    await t.test('bulk tagging is atomic across targets', async () => {
        const one = uid();
        const two = uid();
        for (const id of [one, two]) {
            await admin(createStaffCandidate, {
                candidateId: id,
                fields: FIELDS(),
                operationId: uid(),
            });
        }
        const getVersion = async (id) =>
            (await admin(getCandidateWorkspace, id)).candidate.version;
        const tagged = await admin(tagCandidates, {
            candidates: [
                { candidateId: one, expectedVersion: await getVersion(one) },
                { candidateId: two, expectedVersion: await getVersion(two) },
            ],
            tag: 'bulk-tag-test',
            operationId: uid(),
        });
        assert.equal(tagged.status, 'tagged');
        const tagAudits = Number(scalar(pg17, `
            select count(*) from app.audit_events
            where action = 'candidate.tagged' and target_type = 'candidate'
                and target_id in ('${one}', '${two}')`));
        assert.equal(tagAudits, 2,
            'each tagged candidate gets its own audit entry');

        const staleTwo = Number(await getVersion(two)) - 1;
        await rejectCode(
            admin(tagCandidates, {
                candidates: [
                    { candidateId: one, expectedVersion: await getVersion(one) },
                    { candidateId: two, expectedVersion: String(staleTwo) },
                ],
                tag: 'should-rollback',
                operationId: uid(),
            }),
            '40001',
        );
        const oneAfter = await admin(getCandidateWorkspace, one);
        assert.ok(
            !oneAfter.candidate.tags.includes('should-rollback'),
            'a stale version on any target must roll back the whole tag write',
        );
    });

    await t.test('add-to-job honours published open jobs and rejects others', async () => {
        const candidateId = uid();
        await admin(createStaffCandidate, {
            candidateId,
            fields: FIELDS({ fullName: 'Job Link Candidate' }),
            operationId: uid(),
        });
        const linked = await admin(addCandidateToJob, {
            candidateId,
            jobId: FIX.jobLink,
            operationId: uid(),
        });
        assert.equal(linked.status, 'created');
        const repeat = await admin(addCandidateToJob, {
            candidateId,
            jobId: FIX.jobLink,
            operationId: uid(),
        });
        assert.equal(repeat.status, 'duplicate');
        assert.equal(repeat.applicationId, linked.applicationId);

        await rejectCode(
            admin(addCandidateToJob, {
                candidateId,
                jobId: CJ_ID.JOB_LEGACY_B,
                operationId: uid(),
            }),
            'P0002',
            'draft jobs cannot accept staff-linked candidates',
        );
    });

    await t.test('exact counts in client, job and application read models', async () => {
        const clientWorkspace = await admin(getClientWorkspace, FIX.client);
        assert.equal(clientWorkspace.openRoles, 2);
        assert.equal(clientWorkspace.applicationCount, 3);
        assert.equal(clientWorkspace.interviewingCount, 1);
        assert.equal(clientWorkspace.jobTotal, 2);
        assert.equal(clientWorkspace.recentApplications.length, 3);

        const jobs = await admin(listWorkspaceJobs, { clientId: FIX.client });
        const listed = jobs.find((job) => job.id === FIX.jobListed);
        const unlisted = jobs.find((job) => job.id === FIX.jobUnlisted);
        assert.equal(listed.applicationCount, 2);
        assert.equal(unlisted.applicationCount, 1);

        const forClient = await admin(listApplicationDirectory, { clientId: FIX.client });
        assert.equal(forClient.total, 3);
        assert.equal(forClient.allCount, 3);
        const interview = await admin(listApplicationDirectory, {
            clientId: FIX.client, stage: 'interview',
        });
        assert.equal(interview.total, 1);
        assert.equal(interview.allCount, 3);
        const forJob = await admin(listApplicationDirectory, { jobId: FIX.jobUnlisted });
        assert.equal(forJob.total, 1);

        const measured = {
            client: {
                openRoles: clientWorkspace.openRoles,
                applicationCount: clientWorkspace.applicationCount,
                interviewingCount: clientWorkspace.interviewingCount,
                recentApplications: clientWorkspace.recentApplications.length,
            },
            jobs: {
                listed: listed.applicationCount,
                unlisted: unlisted.applicationCount,
            },
            applications: {
                clientTotal: forClient.total,
                interviewTotal: interview.total,
                interviewAllCount: interview.allCount,
                jobTotal: forJob.total,
            },
        };
        await writeFile(
            join(repoRoot, 'test-results/workspace-parity-readmodels.json'),
            `${JSON.stringify(measured, null, 2)}\n`,
        );
    });

    await t.test('restricted candidates are redacted everywhere staff reads them', async () => {
        const workspace = await admin(getCandidateWorkspace, FIX.casey);
        assert.equal(workspace.candidate.lifecycle, 'restricted');
        assert.equal(workspace.candidate.fullName, 'Restricted candidate');
        assert.deepEqual(workspace.identifiers, []);
        assert.deepEqual(workspace.documents, []);
        assert.deepEqual(workspace.notes, []);

        const directory = await admin(listCandidateDirectory, {});
        const card = directory.candidates.find(
            (row) => row.candidateId === FIX.casey);
        assert.ok(card, 'the restricted row must still appear, redacted');
        assert.equal(card.fullName, 'Restricted candidate');
        assert.equal(card.email, undefined);
        assert.equal(card.lifecycle, 'restricted');
    });

    await t.test('directory pagination walks every page', async () => {
        const prefix = `pgx${uid().slice(0, 6)}`;
        const inserts = [];
        for (let index = 0; index < 27; index += 1) {
            inserts.push(`
insert into app.candidates (id, organization_id, full_name, identity_state, lifecycle)
    values ('${uid()}', '${ORG_B}', '${prefix} Candidate ${index}',
        'established', 'active');`);
        }
        psql(pg17, inserts.join('\n'));

        const first = await admin(listCandidateDirectory, { query: prefix });
        assert.equal(first.total, 27);
        assert.equal(first.candidates.length, 25);
        const second = await admin(listCandidateDirectory, { query: prefix, page: '2' });
        assert.equal(second.page, 2);
        assert.equal(second.candidates.length, 2);
        const single = await admin(listCandidateDirectory, {
            query: `${prefix} Candidate 26`,
        });
        assert.equal(single.total, 1);
    });

    await t.test('application filters, date ranges and owner scoping', async () => {
        const all = await admin(listApplicationDirectory, {});
        assert.ok(all.total >= 4);
        const reviewOnly = await admin(listApplicationDirectory, { review: '1' });
        assert.ok(reviewOnly.total >= 1);
        assert.ok(
            reviewOnly.applications.every((row) => row.stageIsInitial === true),
        );

        const today = new Date().toISOString().slice(0, 10);
        const custom = await admin(listApplicationDirectory, {
            dateRange: 'custom', from: today, to: today,
        });
        assert.ok(custom.total >= 4, 'same-day custom range must include today');
        await rejectCode(
            admin(listApplicationDirectory, {
                dateRange: 'custom', from: '2026-10-10', to: '2026-10-01',
            }),
            'INVALID_INPUT',
            'reversed custom ranges must be rejected',
        );
        await rejectCode(
            admin(listApplicationDirectory, { dateRange: 'bogus' }),
            'INVALID_INPUT',
        );
    });

    await t.test('candidate application counts hide without applications.read', async () => {
        const recruiterView = await recruiter(listCandidateDirectory, { query: 'Recruit' });
        assert.ok(recruiterView.candidates.every(
            (row) => typeof row.applicationCount === 'number'));
        const viewerView = await viewer(listCandidateDirectory, { query: 'Recruit' });
        assert.ok(
            viewerView.candidates.every((row) => row.applicationCount === null),
            'without applications.read the count must be null, never zero',
        );
    });

    await t.test('duplicating a job produces an unlisted draft and leaves the source', async () => {
        const client = await admin(saveClient, {
            clientId: uid(),
            expectedVersion: null,
            fields: {
                name: 'Duplicate Source Client',
                contactName: 'Dana Duplicate',
                contactEmail: 'dana@duplicate-source.example',
                telegramUsername: null,
                website: null,
                socialLinks: [],
                isStealth: false,
                anonymousDescription: null,
            },
            operationId: uid(),
        });
        const clientId = client.id ?? client.clientId ?? client.client?.id;
        const draft = await admin(createJobDraft, {
            jobId: uid(),
            revisionId: uid(),
            clientId,
            fields: {
                title: 'Duplicate Source Job',
                employmentType: 'full_time',
                workplaceMode: 'remote',
                locations: [],
                remoteRegions: ['Worldwide'],
                compensationMin: '100000.00',
                compensationMax: '140000.00',
                currency: 'USD',
                payPeriod: 'year',
                bonuses: [],
                descriptionDocument: {
                    type: 'doc',
                    content: [{
                        type: 'paragraph',
                        content: [{ type: 'text', text: 'Duplicate me.' }],
                    }],
                },
            },
            operationId: uid(),
        });
        const preview = await admin(previewJobPublic, { revisionId: draft.revisionId });
        await admin(publishJobRevision, {
            revisionId: draft.revisionId,
            expectedVersion: '1',
            expectedClientVersion: preview.clientVersion,
            reviewHash: preview.reviewHash,
            operationId: uid(),
        });
        await admin(setJobPublicListing, {
            jobId: draft.jobId,
            listed: true,
            expectedVersion: '2',
            operationId: uid(),
        });
        const publishedRevision = scalar(pg17,
            `select published_revision_id from app.jobs where id = '${draft.jobId}'`);
        const sourceVersion = scalar(pg17,
            `select version from app.job_revisions where id = '${publishedRevision}'`);

        const newJobId = uid();
        const duplicated = await admin(duplicateJob, {
            sourceRevisionId: publishedRevision,
            expectedSourceVersion: sourceVersion,
            clientId,
            jobId: newJobId,
            revisionId: uid(),
            operationId: uid(),
        });
        const duplicatedJobId = duplicated.jobId ?? duplicated.job?.id ?? newJobId;
        const rows = psql(pg17, `
            select publication_state, application_state, publicly_listed
            from app.jobs where id = '${duplicatedJobId}'`).trim();
        assert.match(rows, /draft/);
        assert.match(rows, /f\s*$/m, 'the duplicate must start unlisted');
        const source = psql(pg17, `
            select publication_state, publicly_listed from app.jobs
            where id = '${draft.jobId}'`).trim();
        assert.match(source, /published\|?.*t|published.*true/, 'source job stays listed and published');
    });

    await t.test('import review flags duplicates, matches and restricted rows', async () => {
        const review = await admin(reviewCandidateImport, [
            { fields: FIELDS({ fullName: 'Fresh Import Person', email: 'fresh.import@example.test' }) },
            { fields: FIELDS({ fullName: 'Dup Email Person', email: 'casey@example.test' }) },
            { fields: FIELDS({ fullName: 'Count Ada', email: 'unique.ada@example.test' }) },
            { fields: { ...FIELDS(), fullName: '' } },
        ]);
        const rows = review.rows;
        assert.equal(rows[0].status, 'ready');
        assert.equal(rows[1].status, 'blocked', 'restricted identities cannot be imported');
        assert.equal(rows[2].status, 'possible_match');
        assert.equal(rows[3].status, 'invalid');
        const withinFile = await admin(reviewCandidateImport, [
            { fields: FIELDS({ fullName: 'File Dup A', email: 'same@example.test' }) },
            { fields: FIELDS({ fullName: 'File Dup B', email: 'same@example.test' }) },
        ]);
        assert.equal(withinFile.rows[1].status, 'duplicate');
    });

    await t.test('permission gates stay fail-closed', async () => {
        await rejectCode(
            viewer(createStaffCandidate, {
                candidateId: uid(),
                fields: FIELDS(),
                operationId: uid(),
            }),
            'FORBIDDEN',
        );
        await rejectCode(
            viewer(listApplicationDirectory, {}),
            'FORBIDDEN',
        );
        await rejectCode(
            viewer(listPrivacyCases),
            'FORBIDDEN',
        );
        const cases = await admin(listPrivacyCases);
        assert.ok(Array.isArray(cases.cases));
        await rejectCode(
            orgA(getCandidateWorkspace, FIX.ada),
            'P0002',
            'cross-organisation records must not be visible',
        );
    });

    const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const staffCv = (candidateId, bytes, extension = 'pdf', filename = 'cv.pdf') => ({
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.length,
        mimeType: extension === 'pdf' ? 'application/pdf' : DOCX_MIME,
        extension,
        bucket: 'cv-submissions',
        objectKey: `staff/${ORG_B}/${candidateId}/${uid()}.${extension}`,
        filename,
    });

    await t.test('staff procedures are unreachable for non-staff roles', () => {
        for (const role of ['app_intake', 'app_worker']) {
            assertSqlstate(pg17, `
                set role ${role};
                select app.create_staff_candidate_v1(
                    '${uid()}'::uuid, '{"fullName":"Role Probe"}'::jsonb,
                    null, null, null, '${uid()}'::uuid, '${uid()}'::uuid);`,
                '42501');
            assertSqlstate(pg17,
                `set role ${role}; select app.review_candidate_import_v1('[]'::jsonb);`,
                '42501');
            assertSqlstate(pg17,
                `set role ${role}; select app.list_candidate_directory_v1('{}'::jsonb);`,
                '42501');
            assertSqlstate(pg17, `
                set role ${role};
                select app.save_candidate_profile_v1(
                    '${uid()}'::uuid, 1, '{"fullName":"x"}'::jsonb,
                    '${uid()}'::uuid, '${uid()}'::uuid);`,
                '42501');
            assertSqlstate(pg17,
                `set role ${role}; select app.get_document_download_v1('${uid()}'::uuid);`,
                '42501');
        }
        assertSqlstate(pg17,
            `set role app_staff; select app.candidate_fields_valid_v1('{}'::jsonb);`,
            '42501');
        assertSqlstate(pg17, `
            set role app_staff;
            select app.record_candidate_change_v1(
                '${uid()}'::uuid, '${uid()}'::uuid, '${uid()}'::uuid,
                'candidate.created', '${uid()}'::uuid,
                decode('${'ab'.repeat(32)}', 'hex'), '{}'::jsonb, '{}'::jsonb);`,
            '42501');
        assert.equal(scalar(pg17, `
            select coalesce(bool_or(
                pg_catalog.has_function_privilege(grantee.role, p.oid, 'execute')), false)
            from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            cross join (values ('app_intake'), ('app_worker'), ('app_staff'), ('public'))
                as grantee(role)
            where n.nspname = 'app'
                and p.proname = 'submit_public_application_core_v1'`), 'f',
            'the core intake function must be executor-only');
        assert.equal(scalar(pg17, `
            select pg_catalog.has_function_privilege('app_executor', p.oid, 'execute')
            from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app'
                and p.proname = 'submit_public_application_core_v1'`), 't');
        assert.equal(scalar(pg17, `
            select pg_catalog.has_function_privilege('app_intake', p.oid, 'execute')
            from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app'
                and p.proname = 'submit_public_application_v1'`), 't',
            'the guarded wrapper is the only intake entry point');
    });

    await t.test('CV lifecycle: metadata, versions, dedup, replay and downloads', async () => {
        const candidateId = uid();
        const created = await admin(createStaffCandidate, {
            candidateId,
            fields: FIELDS({ fullName: 'CV Lifecycle Owner' }),
            operationId: uid(),
        });
        const pdfBytes = Buffer.from('%PDF-1.4 lifecycle bytes');
        const pdfDoc = staffCv(candidateId, pdfBytes, 'pdf', 'first.pdf');
        const first = await admin(addCandidateDocument, {
            candidateId,
            expectedVersion: created.version,
            document: pdfDoc,
            operationId: uid(),
        });
        assert.equal(first.status, 'created');
        assert.ok(first.documentId);

        let workspace = await admin(getCandidateWorkspace, candidateId);
        assert.equal(workspace.documents.length, 1);
        assert.equal(workspace.documents[0].documentId, first.documentId);
        assert.equal(workspace.documents[0].filename, 'first.pdf');
        assert.equal(workspace.documents[0].current, true);
        assert.equal(workspace.documents[0].scanState, 'unscanned');
        assert.equal(workspace.documents[0].version, 1);

        const stored = scalar(pg17, `
            select encode(b.sha256, 'hex') || '|' || b.size_bytes || '|' || l.object_key
            from app.file_blobs b
            join app.blob_locations l on l.organization_id = b.organization_id
                and l.blob_id = b.id
            where b.organization_id = '${ORG_B}' and b.candidate_id = '${candidateId}'`);
        assert.equal(
            stored.split('|')[0],
            createHash('sha256').update(pdfBytes).digest('hex'),
            'the blob checksum is the uploaded byte digest');
        assert.equal(stored.split('|')[1], String(pdfBytes.length));
        assert.equal(stored.split('|')[2], pdfDoc.objectKey);

        const download = await admin(getDocumentDownload, { documentId: first.documentId });
        assert.equal(download.bucket, 'cv-submissions');
        assert.equal(download.objectKey, pdfDoc.objectKey);
        assert.equal(download.filename, 'first.pdf');

        const dedup = await admin(addCandidateDocument, {
            candidateId,
            expectedVersion: first.version,
            document: staffCv(candidateId, pdfBytes, 'pdf', 'same-bytes.pdf'),
            operationId: uid(),
        });
        assert.equal(dedup.status, 'duplicate');
        assert.equal(dedup.documentId, first.documentId);
        assert.equal(Number(scalar(pg17, `
            select count(*) from app.file_blobs
            where organization_id = '${ORG_B}' and candidate_id = '${candidateId}'`)), 1,
            'identical bytes reuse the existing blob row');

        const docxBytes = Buffer.from('PK docx lifecycle bytes');
        const docxDoc = staffCv(candidateId, docxBytes, 'docx', 'second.docx');
        const docxOp = uid();
        const second = await admin(addCandidateDocument, {
            candidateId,
            expectedVersion: first.version,
            document: docxDoc,
            operationId: docxOp,
        });
        assert.equal(second.status, 'created');
        assert.notEqual(second.documentId, first.documentId);

        const replay = await admin(addCandidateDocument, {
            candidateId,
            expectedVersion: first.version,
            document: docxDoc,
            operationId: docxOp,
        });
        assert.equal(replay.replayed, true);
        assert.equal(replay.documentId, second.documentId);
        assert.equal(Number(scalar(pg17, `
            select count(*) from app.file_blobs
            where organization_id = '${ORG_B}' and candidate_id = '${candidateId}'`)), 2,
            'a replayed operation must not write another blob row');
        assert.equal(Number(scalar(pg17, `
            select count(*) from app.documents
            where organization_id = '${ORG_B}' and candidate_id = '${candidateId}'`)), 2);

        workspace = await admin(getCandidateWorkspace, candidateId);
        const current = workspace.documents.find((row) => row.current);
        assert.equal(current.documentId, second.documentId,
            'the current pointer moves to the newest version');
        assert.equal(current.supersedesDocumentId, first.documentId);
        assert.equal(current.version, 2);

        await rejectCode(
            viewer(getDocumentDownload, { documentId: first.documentId }),
            'FORBIDDEN',
            'documents.download is required to resolve blob coordinates',
        );
        await assert.rejects(
            orgA(getDocumentDownload, { documentId: first.documentId }),
            'cross-organisation downloads must fail',
        );

        psql(pg17, `
            update app.file_blobs set scan_state = 'infected'
            where organization_id = '${ORG_B}' and candidate_id = '${candidateId}'
                and sha256 = decode('${docxDoc.sha256}', 'hex')`);
        await rejectCode(
            admin(getDocumentDownload, { documentId: second.documentId }),
            'P0002',
            'infected blobs never produce a download',
        );
    });

    await t.test('a failed bundle rolls back candidate, blob metadata and notes', async () => {
        const candidateId = uid();
        await rejectCode(
            admin(createStaffCandidate, {
                candidateId,
                fields: FIELDS({ fullName: 'Rollback Bundle' }),
                document: staffCv(candidateId, Buffer.from('%PDF rollback'), 'pdf', 'r.pdf'),
                jobId: CJ_ID.JOB_LEGACY_B,
                note: 'must not persist',
                operationId: uid(),
            }),
            'P0002',
            'a draft job target fails the whole bundle',
        );
        for (const [table, column] of [
            ['candidates', 'id'],
            ['file_blobs', 'candidate_id'],
            ['documents', 'candidate_id'],
            ['candidate_notes', 'candidate_id'],
            ['candidate_sources', 'candidate_id'],
            ['candidate_identifiers', 'candidate_id'],
            ['applications', 'candidate_id'],
        ]) {
            assert.equal(Number(scalar(pg17, `
                select count(*) from app.${table}
                where organization_id = '${ORG_B}' and ${column} = '${candidateId}'`)),
                0, `${table} must not retain a partial bundle row`);
        }
    });

    await t.test('bundle replay does not duplicate candidate, CV or application rows', async () => {
        const candidateId = uid();
        const operationId = uid();
        const input = {
            candidateId,
            fields: FIELDS({
                fullName: 'Replay Bundle',
                email: 'replay.bundle@example.test',
            }),
            document: staffCv(candidateId, Buffer.from('%PDF replay'), 'pdf', 'r.pdf'),
            jobId: FIX.jobLink,
            note: 'replay bundle note',
            operationId,
        };
        const first = await admin(createStaffCandidate, input);
        assert.equal(first.status, 'created');
        const count = (table, column = 'candidate_id') => Number(scalar(pg17, `
            select count(*) from app.${table}
            where organization_id = '${ORG_B}' and ${column} = '${candidateId}'`));
        const before = {
            candidates: count('candidates', 'id'),
            blobs: count('file_blobs'),
            documents: count('documents'),
            applications: count('applications'),
            notes: count('candidate_notes'),
        };
        assert.deepEqual(before, {
            candidates: 1, blobs: 1, documents: 1, applications: 1, notes: 1,
        });
        const replay = await admin(createStaffCandidate, input);
        assert.equal(replay.replayed, true);
        assert.equal(replay.candidateId, candidateId);
        assert.deepEqual({
            candidates: count('candidates', 'id'),
            blobs: count('file_blobs'),
            documents: count('documents'),
            applications: count('applications'),
            notes: count('candidate_notes'),
        }, before, 'replay must return the receipt without repeating any write');
    });

    await t.test('staff and public same-email writes serialize on the org lock', async () => {
        const { submitPublicApplication } =
            await import('../../src/lib/intake-operations.js');
        const email = `race.${uid().slice(0, 8)}@example.test`;
        const reference = `AG-${randomBytes(6).toString('hex').toUpperCase()}`;
        const [staffResult, intakeResult] = await Promise.all([
            admin(createStaffCandidate, {
                candidateId: uid(),
                fields: FIELDS({ fullName: 'Race Staff Side', email }),
                operationId: uid(),
            }),
            submitPublicApplication(pool1, ORG_B, {
                jobSlug: 'count-listed',
                reference,
                fullName: 'Race Public Side',
                email,
                professionalUrl: null,
                achievement: null,
                document: null,
            }),
        ]);
        const candidatesWithEmail = Number(scalar(pg17, `
            select count(distinct candidate_id) from app.candidate_identifiers
            where organization_id = '${ORG_B}' and kind = 'email'
                and normalized_value = '${email}'`));
        assert.equal(candidatesWithEmail, 1,
            'the org lock must serialize staff and public same-email writes');
        const winner = scalar(pg17, `
            select distinct c.id::text from app.candidates c
            join app.candidate_identifiers i
                on i.organization_id = c.organization_id and i.candidate_id = c.id
            where c.organization_id = '${ORG_B}' and i.normalized_value = '${email}'`);
        if (staffResult.status === 'created') {
            assert.equal(staffResult.candidateId, winner);
            assert.equal(intakeResult.candidateId, winner);
            assert.equal(intakeResult.reusedCandidate, true);
        } else {
            assert.equal(staffResult.status, 'duplicate');
            assert.equal(staffResult.candidateId, winner);
            assert.equal(intakeResult.candidateId, winner);
            assert.equal(intakeResult.reusedCandidate, false);
        }
        assert.equal(intakeResult.accepted, true);
        assert.equal(Number(scalar(pg17, `
            select count(*) from app.applications
            where organization_id = '${ORG_B}' and candidate_id = '${winner}'
                and job_id = '${FIX.jobListed}'`)), 1,
            'the public application always lands once on the target job');
    });

    await t.test('same stage keys across pipelines merge into one count', async () => {
        const pipeline2 = uid();
        const stage2Review = uid();
        const stage2Interview = uid();
        const job2 = uid();
        const candidate2 = uid();
        const application2 = uid();
        psql(pg17, `
            insert into app.pipelines (id, organization_id, key, name, status) values
                ('${pipeline2}', '${ORG_B}', 'executive', 'Executive search', 'active');
            insert into app.pipeline_stages
                    (id, organization_id, pipeline_id, key, label, kind, position, is_initial)
                values
                ('${stage2Review}', '${ORG_B}', '${pipeline2}',
                    'review', 'Screen', 'active', 0, true),
                ('${stage2Interview}', '${ORG_B}', '${pipeline2}',
                    'interview', 'Panel', 'active', 1, false);
            insert into app.jobs (id, organization_id, client_id, pipeline_id, slug,
                    title, description, location_display, employment_type,
                    publication_state, application_state) values
                ('${job2}', '${ORG_B}', '${CJ_ID.CLIENT_LEGACY_B}', '${pipeline2}',
                    'pipeline-two-job', 'Pipeline Two Job', 'Fixture', 'Remote',
                    'contract', 'draft', 'open');
            insert into app.candidates (id, organization_id, full_name,
                    identity_state, lifecycle) values
                ('${candidate2}', '${ORG_B}', 'Pipeline Two Candidate',
                    'established', 'active');
            insert into app.applications (id, organization_id, candidate_id, job_id,
                    pipeline_id, stage_id, public_reference, reference_version,
                    received_at) values
                ('${application2}', '${ORG_B}', '${candidate2}', '${job2}',
                    '${pipeline2}', '${stage2Interview}', 'AG-AAAA00000BB2', 1, now());
        `);
        const directory = await admin(listApplicationDirectory, {});
        const interviewStages = directory.stages.filter(
            (stage) => stage.key === 'interview');
        assert.equal(interviewStages.length, 1,
            'same-key stages across pipelines merge into one entry');
        assert.equal(interviewStages[0].count, 2);
        assert.ok(interviewStages[0].label.includes('Interview'));
        assert.ok(interviewStages[0].label.includes('Panel'));
        const filtered = await admin(listApplicationDirectory, { stage: 'interview' });
        assert.equal(filtered.total, 2,
            'filtering by the shared key reaches every pipeline');
    });

    await t.test('non-superuser operator applies the recruitment migrations', () => {
        psql(pgOperator, `
            create role staff_operator nologin nosuperuser createrole bypassrls;
            grant create on database postgres to staff_operator with grant option;
        `);
        for (const fileName of MIGRATIONS) {
            psql(pgOperator,
                `set session authorization staff_operator;\n${readMigration(fileName)}`);
        }
        const NEW_FUNCTIONS = [
            'candidate_contact_v1', 'candidate_fields_valid_v1',
            'record_candidate_change_v1', 'save_candidate_profile_v1',
            'tag_candidates_v1', 'add_candidate_to_job_v1',
            'add_candidate_document_v1', 'create_staff_candidate_v1',
            'staff_upload_referenced_v1', 'get_recruitment_context_v1',
            'candidate_card_v1', 'list_candidate_directory_v1',
            'get_candidate_workspace_v2', 'staff_job_card_v1',
            'list_workspace_jobs_v1', 'get_job_workspace_v2',
            'application_card_v1', 'list_application_directory_v1',
            'get_client_workspace_v1', 'list_privacy_cases_v1',
            'duplicate_job_v2', 'submit_public_application_v1',
            'submit_public_application_core_v1', 'get_document_download_v1',
            'review_candidate_import_v1',
        ];
        assert.equal(scalar(pgOperator, `
            select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            join pg_roles r on r.oid = p.proowner
            where n.nspname = 'app'
                and p.proname in ('${NEW_FUNCTIONS.join("','")}')
                and r.rolname = 'app_executor'`),
            String(NEW_FUNCTIONS.length),
            'every new routine is owned by app_executor');
        const DEFINER = NEW_FUNCTIONS.filter((name) => ![
            'candidate_contact_v1', 'candidate_fields_valid_v1',
            'record_candidate_change_v1', 'candidate_card_v1',
            'staff_job_card_v1', 'application_card_v1',
        ].includes(name));
        assert.equal(scalar(pgOperator, `
            select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app'
                and p.proname in ('${DEFINER.join("','")}')
                and p.prosecdef`),
            String(DEFINER.length),
            'staff entry points run security definer; helpers stay invoker');
        for (const role of ['app_executor', 'app_staff', 'app_intake']) {
            assert.equal(scalar(pgOperator, `
                select pg_catalog.has_schema_privilege('${role}', 'app', 'create')`),
                'f', `${role} must not hold CREATE on the app schema`);
        }
        assert.equal(scalar(pgOperator, `
            select count(*) from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
            join pg_roles r on r.oid = c.relowner
            where n.nspname = 'app' and c.relkind = 'r'
                and c.relname in ('candidate_sources', 'candidate_notes',
                    'pipeline_stages', 'documents', 'file_blobs', 'blob_locations')
                and r.rolname = 'app_owner'
                and c.relrowsecurity and c.relforcerowsecurity`),
            '6');
    });
});
