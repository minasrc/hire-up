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
import { ClientJobContractError } from '../../src/lib/client-job-contracts.js';
import {
    getCandidateProfile,
    getCandidateProfileOptions,
    listCandidateProfiles,
    saveCandidateProfile,
} from '../../src/lib/candidate-profile-operations.js';
import { submitPublicApplication } from '../../src/lib/intake-operations.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const migrationsDir = join(repoRoot, 'supabase', 'migrations');
const PROFILE_MIGRATION = '20260930090000_candidate_profiles.sql';
const SERIALIZATION_MIGRATION = '20260930090100_candidate_intake_serialization.sql';
const PROFILE_FUNCTIONS = [
    'save_candidate_profile_v1',
    'get_candidate_profile_options_v1',
    'get_candidate_profile_v1',
    'list_candidate_profiles_v1',
];
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
];

const readMigration = (name) => readFileSync(join(migrationsDir, name), 'utf8');
const identity = (subject) => ({
    provider: 'google',
    issuer: 'https://accounts.google.com',
    subject,
});
const { ORG_B } = AUTHZ_ID;
const scalar = (container, sql) => psql(container, sql).trim();

const MEMBER_B_GONE = '90000000-0000-4000-8000-0000000000f1';
const USER_B_GONE = '90000000-0000-4000-8000-0000000000f2';
const CANDIDATE_RESTRICTED = '90000000-0000-4000-8000-0000000000f3';
const RACE_JOB = '90000000-0000-4000-8000-0000000000f4';

const profileFixtureSql = `
insert into app.users (id, display_name, status) values
    ('${USER_B_GONE}', 'Departed Member B', 'active');
insert into app.organization_memberships
    (id, organization_id, user_id, role_id, status, activated_at, revoked_at) values
    ('${MEMBER_B_GONE}', '${ORG_B}', '${USER_B_GONE}', '${CJ_ID.ROLE_B_RECRUITER}',
        'revoked', now(), now());
insert into app.candidates (id, organization_id, full_name, identity_state, lifecycle)
    values ('${CANDIDATE_RESTRICTED}', '${ORG_B}', 'Restricted Person',
        'established', 'restricted');
insert into app.candidate_identifiers (id, organization_id, candidate_id, kind,
    raw_value, normalized_value, normalization_version, verification, received_at)
    values ('${randomUUID()}', '${ORG_B}', '${CANDIDATE_RESTRICTED}', 'email',
        'restricted@example.test', 'restricted@example.test', 1, 'unverified', now());
insert into app.jobs (id, organization_id, client_id, pipeline_id, slug, title,
    description, location_display, employment_type, publication_state,
    publicly_listed, application_state, publication_reviewed_by,
    publication_reviewed_at, published_at) values
    ('${RACE_JOB}', '${ORG_B}', '${CJ_ID.CLIENT_LEGACY_B}', '${CJ_ID.PIPELINE_B}',
        'profile-race-job', 'Race Job', 'Race description', 'Remote',
        'full_time', 'published', true, 'open', '${AUTHZ_ID.MEMBER_B_ADMIN}',
        now(), now());
`;

const candidateCount = (container, email) => scalar(container, `
    select count(distinct c.id) from app.candidates c
    join app.candidate_identifiers i
        on i.organization_id = c.organization_id and i.candidate_id = c.id
    where c.organization_id = '${ORG_B}'
        and i.kind = 'email' and i.normalized_value = lower('${email}')`);

const rejectCode = async (promise, code, label) => {
    await assert.rejects(
        promise,
        (error) => error.code === code,
        label ?? `expected ${code}`,
    );
};

test('candidate profiles on PostgreSQL 17', async (t) => {
    assertLocalTestEnvironment();
    const pg17 = await startPostgresContainer('pgprofiles', POSTGRES_17_IMAGE, {
        publish: true,
    });
    let pool;
    t.after(async () => {
        await pool?.end().catch(() => {});
        await stopAndRemoveContainer(pg17);
    });
    const pgOperator = await startPostgresContainer('pgprofilesop', POSTGRES_17_IMAGE);
    t.after(() => stopAndRemoveContainer(pgOperator));

    for (const fileName of MIGRATIONS) {
        psql(pg17, readMigration(fileName));
    }
    const runtimePassword = installStaffFixture(pg17);
    psql(pg17, clientJobFixtureSql);
    psql(pg17, profileFixtureSql);
    psql(pg17, `grant app_intake to ${RUNTIME_ROLE}`);

    pool = new pg.Pool(staffPoolOptions(pg17, runtimePassword, 4));

    const admin = (fn, input) => fn(pool, identity(CJ_SUBJECTS.ADMIN), ORG_B, input);
    const recruiter = (fn, input) =>
        fn(pool, identity(CJ_SUBJECTS.RECRUITER), ORG_B, input);
    const intake = (input) => submitPublicApplication(pool, ORG_B, input);

    const newCandidate = (fields, extra = {}) => admin(saveCandidateProfile, {
        candidateId: randomUUID(),
        expectedVersion: null,
        fields,
        operationId: randomUUID(),
        ...extra,
    });
    const intakeInput = (email, reference) => ({
        jobSlug: 'profile-race-job',
        reference,
        fullName: 'Race Applicant',
        email,
        professionalUrl: null,
        achievement: null,
        document: null,
    });

    await t.test('name-only create persists and reads back', async () => {
        const created = await newCandidate({ fullName: 'Name Only' });
        assert.equal(created.status, 'created');
        assert.equal(created.version, '1');
        const profile = await admin(getCandidateProfile, {
            candidateId: created.candidateId });
        assert.equal(profile.candidate.fullName, 'Name Only');
        assert.equal(profile.candidate.email, null);
        assert.equal(profile.candidate.professionalUrl, null);
        assert.equal(profile.candidate.headline, null);
        assert.equal(profile.candidate.location, null);
        assert.equal(profile.candidate.ownerMembershipId, null);
        assert.equal(profile.candidate.professionalSummary, null);
        assert.equal(profile.profileOptions.canWrite, true);
    });

    await t.test('all seven fields edit, clear and read back in get and list', async () => {
        const created = await newCandidate({ fullName: 'Seven Fields' });
        const updated = await admin(saveCandidateProfile, {
            candidateId: created.candidateId,
            expectedVersion: '1',
            fields: {
                fullName: 'Seven Renamed',
                email: 'seven@example.test',
                professionalUrl: 'https://example.test/seven',
                headline: 'Staff Engineer',
                location: 'Berlin',
                ownerMembershipId: CJ_ID.MEMBER_B_REC,
                professionalSummary: 'Built pipelines.',
            },
            operationId: randomUUID(),
        });
        assert.equal(updated.status, 'updated');
        assert.equal(updated.version, '2');

        const profile = await admin(getCandidateProfile, {
            candidateId: created.candidateId });
        assert.equal(profile.candidate.fullName, 'Seven Renamed');
        assert.equal(profile.candidate.email, 'seven@example.test');
        assert.equal(profile.candidate.professionalUrl, 'https://example.test/seven');
        assert.equal(profile.candidate.headline, 'Staff Engineer');
        assert.equal(profile.candidate.location, 'Berlin');
        assert.equal(profile.candidate.ownerMembershipId, CJ_ID.MEMBER_B_REC);
        assert.equal(profile.candidate.professionalSummary, 'Built pipelines.');
        assert.equal(profile.candidate.ownerName, 'Synthetic Recruiter B');

        const listed = await admin(listCandidateProfiles, { query: 'seven' });
        const row = listed.candidates.find(
            (entry) => entry.candidateId === created.candidateId);
        assert.equal(row.email, 'seven@example.test');
        assert.equal(row.headline, 'Staff Engineer');
        assert.equal(row.location, 'Berlin');

        const cleared = await admin(saveCandidateProfile, {
            candidateId: created.candidateId,
            expectedVersion: '2',
            fields: {
                fullName: 'Seven Renamed',
                email: null,
                professionalUrl: null,
                headline: null,
                location: null,
                ownerMembershipId: null,
                professionalSummary: null,
            },
            operationId: randomUUID(),
        });
        assert.equal(cleared.status, 'updated');
        const afterClear = await admin(getCandidateProfile, {
            candidateId: created.candidateId });
        assert.equal(afterClear.candidate.email, null);
        assert.equal(afterClear.candidate.professionalUrl, null);
        assert.equal(afterClear.candidate.headline, null);
        assert.equal(afterClear.candidate.location, null);
        assert.equal(afterClear.candidate.ownerMembershipId, null);
        assert.equal(afterClear.candidate.professionalSummary, null);
        const listedAfter = await admin(listCandidateProfiles, { query: 'seven' });
        const clearedRow = listedAfter.candidates.find(
            (entry) => entry.candidateId === created.candidateId);
        assert.equal(clearedRow.email, null,
            'directory shows cleared email despite retained identifier rows');
        assert.equal(scalar(pg17, `
            select count(*) from app.candidate_identifiers
            where organization_id = '${ORG_B}'
                and candidate_id = '${created.candidateId}'
                and kind = 'email'`), '1',
            'the historic identifier row is retained for evidence');
    });

    await t.test('invalid and cross-organization owners are rejected', async () => {
        await rejectCode(admin(saveCandidateProfile, {
            candidateId: randomUUID(),
            expectedVersion: null,
            fields: { fullName: 'Bad Owner', ownerMembershipId: AUTHZ_ID.MEMBER_ADMIN1 },
            operationId: randomUUID(),
        }), '22023', 'a membership from another organization must be rejected');
        await rejectCode(admin(saveCandidateProfile, {
            candidateId: randomUUID(),
            expectedVersion: null,
            fields: { fullName: 'Revoked Owner', ownerMembershipId: MEMBER_B_GONE },
            operationId: randomUUID(),
        }), '22023', 'a revoked membership must be rejected');
    });

    await t.test('case-folded duplicate email returns the existing candidate', async () => {
        const created = await newCandidate({
            fullName: 'Folded Case', email: 'Folded@Example.test' });
        const duplicate = await newCandidate({
            fullName: 'Folded Other', email: 'folded@EXAMPLE.test' });
        assert.equal(duplicate.status, 'duplicate');
        assert.equal(duplicate.candidateId, created.candidateId);
        assert.equal(candidateCount(pg17, 'folded@example.test'), '1');
        const profile = await admin(getCandidateProfile, {
            candidateId: created.candidateId });
        assert.equal(profile.candidate.fullName, 'Folded Case',
            'the original profile is not overwritten by the duplicate');
    });

    await t.test('same name without email creates distinct candidates', async () => {
        const first = await newCandidate({ fullName: 'Shared Name' });
        const second = await newCandidate({ fullName: 'Shared Name' });
        assert.equal(first.status, 'created');
        assert.equal(second.status, 'created');
        assert.notEqual(first.candidateId, second.candidateId);
    });

    await t.test('sources, audit and receipt rows are written', async () => {
        const operationId = randomUUID();
        const created = await newCandidate(
            { fullName: 'Audit Trail' }, { operationId });
        await admin(saveCandidateProfile, {
            candidateId: created.candidateId,
            expectedVersion: '1',
            fields: { fullName: 'Audit Trail', headline: 'Audited' },
            operationId: randomUUID(),
        });
        assert.deepEqual(
            scalar(pg17, `
                select string_agg(kind || ':' || context_summary, ' | ' order by received_at)
                from app.candidate_sources
                where organization_id = '${ORG_B}'
                    and candidate_id = '${created.candidateId}'`),
            'manual:Added by staff | manual:Profile updated by staff');
        assert.deepEqual(
            scalar(pg17, `
                select string_agg(action, ',' order by occurred_at)
                from app.audit_events
                where organization_id = '${ORG_B}'
                    and target_id = '${created.candidateId}'`),
            'candidate.created,candidate.updated');
        assert.equal(scalar(pg17, `
            select details -> 'field_names' ? 'headline' from app.audit_events
            where organization_id = '${ORG_B}'
                and target_id = '${created.candidateId}'
                and action = 'candidate.updated'`), 't');
        assert.equal(scalar(pg17, `
            select kind from app.recruitment_operation_receipts
            where organization_id = '${ORG_B}'
                and operation_id = '${operationId}'`), 'candidate.created');

        const replay = await newCandidate(
            { fullName: 'Audit Trail' }, { operationId });
        assert.deepEqual(
            { status: replay.status, version: replay.version,
                candidateId: replay.candidateId },
            created,
            'a replayed operation returns the stored result');
        assert.equal(scalar(pg17, `
            select count(*) from app.audit_events
            where organization_id = '${ORG_B}'
                and target_id = '${created.candidateId}'`), '2',
            'replay does not write another audit row');
        assert.equal(scalar(pg17, `
            select count(*) from app.recruitment_operation_receipts
            where organization_id = '${ORG_B}'
                and operation_id = '${operationId}'`), '1');
    });

    await t.test('email conflict on edit raises 23505 and stale version 40001', async () => {
        const first = await newCandidate({
            fullName: 'First Owner', email: 'conflict@example.test' });
        const second = await newCandidate({ fullName: 'Second Owner' });
        await rejectCode(admin(saveCandidateProfile, {
            candidateId: second.candidateId,
            expectedVersion: '1',
            fields: { fullName: 'Second Owner', email: 'CONFLICT@example.test' },
            operationId: randomUUID(),
        }), '23505', 'taking another candidate email is a unique conflict');
        await rejectCode(admin(saveCandidateProfile, {
            candidateId: first.candidateId,
            expectedVersion: '9',
            fields: { fullName: 'First Owner' },
            operationId: randomUUID(),
        }), '40001', 'a stale expected version is a serialization failure');
    });

    await t.test('restricted candidates cannot be created or written', async () => {
        const blocked = await newCandidate(
            { fullName: 'New Person', email: 'RESTRICTED@example.test' })
            .then(() => null, (error) => error);
        assert.ok(blocked instanceof Error);
        assert.equal(blocked.code, '42501',
            'an existing restricted candidate blocks creation with that email');
        await rejectCode(admin(saveCandidateProfile, {
            candidateId: CANDIDATE_RESTRICTED,
            expectedVersion: '1',
            fields: { fullName: 'Restricted Person' },
            operationId: randomUUID(),
        }), 'P0002', 'editing a restricted candidate is not found');
    });

    await t.test('public applications still land after serialization wrapper', async () => {
        const submitted = await intake(intakeInput(
            'intake@example.test', 'AG-CDEF00000001'));
        assert.equal(submitted.accepted, true);
        assert.equal(submitted.duplicate, false);
        assert.equal(scalar(pg17, `
            select count(*) from app.applications
            where organization_id = '${ORG_B}'
                and public_reference = 'AG-CDEF00000001'`), '1');
    });

    await t.test('concurrent staff and public submissions share one candidate', async () => {
        const email = `race-${randomUUID()}@example.test`;
        const [staffResult, intakeResult] = await Promise.all([
            admin(saveCandidateProfile, {
                candidateId: randomUUID(),
                expectedVersion: null,
                fields: { fullName: 'Race Staff', email },
                operationId: randomUUID(),
            }),
            intake(intakeInput(email, 'AG-CDEF00000002')),
        ]);
        assert.equal(intakeResult.accepted, true);
        assert.ok(
            staffResult.status === 'created' || staffResult.status === 'duplicate',
            `unexpected staff result ${JSON.stringify(staffResult)}`);
        assert.equal(candidateCount(pg17, email), '1',
            'staff and public submissions for the same email share one candidate');
        assert.equal(scalar(pg17, `
            select count(*) from app.applications
            where organization_id = '${ORG_B}'
                and public_reference = 'AG-CDEF00000002'`), '1');
    });

    await t.test('role boundaries hold on the new and private functions', async () => {
        await rejectCode(recruiter(saveCandidateProfile, {
            candidateId: randomUUID(),
            expectedVersion: null,
            fields: { fullName: 'Read Only' },
            operationId: randomUUID(),
        }), 'FORBIDDEN', 'a candidates.read-only member cannot write');
        const options = await recruiter(getCandidateProfileOptions);
        assert.equal(options.canWrite, false);
        assert.ok(Array.isArray(options.owners));
        assert.equal(options.currentMembershipId, CJ_ID.MEMBER_B_REC);

        for (const fn of [
            `app.submit_public_application_core_v1(
                '${randomUUID()}', '${randomUUID()}', '${randomUUID()}',
                '${randomUUID()}', '${randomUUID()}', '${randomUUID()}',
                '${randomUUID()}', '${randomUUID()}', '${randomUUID()}',
                '${randomUUID()}', '${randomUUID()}', 'x', 'AG-0123456789AB',
                'x', 'x@x.test', null, null, null, null, null, null,
                null, null, null)`,
            `app.save_candidate_profile_v1('${randomUUID()}', null,
                '{}'::jsonb, '${randomUUID()}', '${randomUUID()}')`,
            `app.get_candidate_profile_v1('${randomUUID()}')`,
            'app.get_candidate_profile_options_v1()',
            'app.list_candidate_profiles_v1(null, 10)',
        ]) {
            assertSqlstate(pg17, `
                set role app_intake;
                select pg_catalog.set_config('app.organization_id', '${ORG_B}', false);
                select ${fn};`, '42501');
        }
    });

    await t.test('function ownership, search path and ACLs are locked down', async () => {
        assert.equal(scalar(pg17, `
            select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            join pg_roles r on r.oid = p.proowner
            where n.nspname = 'app'
                and p.proname in ('${PROFILE_FUNCTIONS.join("','")}',
                    'submit_public_application_v1',
                    'submit_public_application_core_v1')
                and p.prosecdef and r.rolname = 'app_executor'`),
            String(PROFILE_FUNCTIONS.length + 2));
        assert.equal(scalar(pg17, `
            select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app'
                and p.proname in ('${PROFILE_FUNCTIONS.join("','")}',
                    'submit_public_application_core_v1')
                and p.proconfig::text like '%search_path=pg_catalog, app, pg_temp%'`),
            String(PROFILE_FUNCTIONS.length + 1));
        assert.equal(scalar(pg17, `
            select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            join pg_roles r on r.oid = p.proowner
            where n.nspname = 'app' and p.proname = 'candidate_contact_v1'
                and not p.prosecdef and r.rolname = 'app_executor'`), '1');
        for (const fn of PROFILE_FUNCTIONS) {
            assert.equal(scalar(pg17, `
                select count(*) from pg_proc p
                join pg_namespace n on n.oid = p.pronamespace
                cross join lateral aclexplode(p.proacl) acl
                where n.nspname = 'app' and p.proname = '${fn}'
                    and acl.grantee <> p.proowner
                    and acl.grantee <> 'app_staff'::regrole`), '0',
                `only app_staff may execute ${fn}`);
        }
        assert.equal(scalar(pg17, `
            select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            cross join lateral aclexplode(p.proacl) acl
            where n.nspname = 'app'
                and p.proname = 'submit_public_application_core_v1'
                and acl.grantee <> p.proowner`), '0',
            'the private intake core has no grants beyond its owner');
        assert.equal(scalar(pg17, `
            select pg_catalog.has_schema_privilege('app_executor', 'app', 'create')`),
            'f');
        assert.equal(scalar(pg17, `
            select count(*) from pg_policy pol
            join pg_class c on c.oid = pol.polrelid
            join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'app' and c.relname = 'candidates'
                and pol.polname in ('executor_candidate_profiles_insert',
                    'executor_candidate_profiles_update')`), '2');
    });

    await t.test('non-superuser operator applies the migrations', () => {
        psql(pgOperator, `
            create role staff_operator nologin nosuperuser createrole bypassrls;
            grant create on database postgres to staff_operator with grant option;
        `);
        for (const fileName of MIGRATIONS) {
            psql(pgOperator,
                `set session authorization staff_operator;\n${readMigration(fileName)}`);
        }
        assert.equal(scalar(pgOperator, `
            select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            join pg_roles r on r.oid = p.proowner
            where n.nspname = 'app'
                and p.proname in ('${PROFILE_FUNCTIONS.join("','")}')
                and p.prosecdef and r.rolname = 'app_executor'`),
            String(PROFILE_FUNCTIONS.length));
        assert.equal(scalar(pgOperator, `
            select pg_catalog.has_schema_privilege('app_executor', 'app', 'create')`),
            'f');
    });

    await t.test('contract errors surface before a connection is needed', async () => {
        const deadPool = {
            connect: async () => {
                throw new Error('pool.connect must not be reached');
            },
        };
        await assert.rejects(
            saveCandidateProfile(deadPool, identity(CJ_SUBJECTS.ADMIN), ORG_B, {
                candidateId: randomUUID(),
                expectedVersion: '0',
                fields: { fullName: 'Zero Version' },
                operationId: randomUUID(),
            }),
            (error) => error instanceof ClientJobContractError,
            'version zero is rejected before connecting',
        );
        await assert.rejects(
            saveCandidateProfile(deadPool, identity(CJ_SUBJECTS.ADMIN), ORG_B, {
                candidateId: randomUUID(),
                expectedVersion: null,
                fields: { fullName: 'Bad Key', nickname: 'x' },
                operationId: randomUUID(),
            }),
            (error) => error instanceof ClientJobContractError,
            'unknown field keys are rejected before connecting',
        );
        await assert.rejects(
            saveCandidateProfile(deadPool, identity(CJ_SUBJECTS.ADMIN), ORG_B, {
                candidateId: 'not-a-uuid',
                expectedVersion: null,
                fields: { fullName: 'Bad Id' },
                operationId: randomUUID(),
            }),
            (error) => error instanceof ClientJobContractError,
        );
        await assert.rejects(
            getCandidateProfile(deadPool, identity(CJ_SUBJECTS.ADMIN), ORG_B, {
                candidateId: 'nope' }),
            (error) => error instanceof ClientJobContractError,
        );
        await assert.rejects(
            saveCandidateProfile(deadPool, identity(CJ_SUBJECTS.ADMIN), ORG_B, {
                candidateId: randomUUID(),
                expectedVersion: null,
                fields: { fullName: 'No Operation' },
                operationId: 'not-an-operation-id',
            }),
            (error) => error instanceof ClientJobContractError,
            'a malformed operation identifier is rejected before connecting',
        );
    });
});
