import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import {
    POSTGRES_16_IMAGE,
    POSTGRES_17_IMAGE,
    assertLocalTestEnvironment,
    assertSqlstate,
    psql,
    psqlExpectError,
    publishedPort,
    startPostgresContainer,
    stopAndRemoveContainer,
} from '../support/foundation-docker.js';
import {
    AUTHZ_ID,
    GOOGLE_ISSUER,
    GOOGLE_MIGRATION,
    installStaffFixture,
    RUNTIME_ROLE,
    staffPoolOptions,
} from '../support/staff-authorization.js';
import {
    AUTH_ROUTINE_SNAPSHOT_SQL,
    PRIVACY_MIGRATIONS,
} from '../support/privacy-foundation.js';
import { PRIVACY_OPS_MIGRATION } from '../support/privacy-operations.js';
import {
    CJ_ID,
    CJ_SUBJECTS,
    WORKFLOW_FUNCTIONS,
    WORKFLOW_HELPER_FUNCTIONS,
    WORKFLOW_MIGRATION,
    clientJobFixtureSql,
} from '../support/client-job-workflows.js';
import {
    beginJobRevision,
    createJobDraft,
    duplicateJob,
    getClient,
    getJobPublication,
    getJobWorkspace,
    listClients,
    listJobs,
    previewJobPublic,
    publishJobRevision,
    saveClient,
    saveClientDraft,
    saveClientWithDetails,
    saveJobDraft,
} from '../../src/lib/client-job-operations.js';
import { EMPTY_JOB_DOCUMENT } from '../../src/lib/client-job-contracts.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const migrationsDir = join(repoRoot, 'supabase', 'migrations');
const PREFIX_MIGRATIONS = [
    '20260922090000_foundation_roles.sql',
    '20260922090100_foundation_schema.sql',
    '20260922090200_foundation_seed.sql',
    '20260922130000_staff_authorization_core.sql',
    GOOGLE_MIGRATION,
    ...PRIVACY_MIGRATIONS,
    PRIVACY_OPS_MIGRATION,
];
const LISTING_MIGRATION = '20260925110000_staff_listing.sql';
const PIPELINE_MIGRATION = '20260925140000_application_pipeline.sql';
const PIPELINE_FUNCTIONS = [
    'list_applications_v1',
    'list_candidates_v1',
    'get_candidate_workspace_v1',
    'transition_application_stage_v1',
    'add_candidate_note_v1',
    'get_document_download_v1',
];
const INTAKE_MIGRATION = '20260926140000_public_intake.sql';
const INTAKE_FUNCTIONS = [
    'list_public_jobs_v1',
    'submit_public_application_v1',
    'set_job_public_listing_v1',
];
const readMigration = (name) => readFileSync(join(migrationsDir, name), 'utf8');
const identity = (subject) => ({ provider: 'google', issuer: GOOGLE_ISSUER, subject });
const { ORG_A, ORG_B } = AUTHZ_ID;
const scalar = (container, sql) => psql(container, sql).trim();

const staffPreamble = (actor, org) => `
    set role app_staff;
    select pg_catalog.set_config('app.actor_id', '${actor ?? ''}', false),
           pg_catalog.set_config('app.organization_id', '${org ?? ''}', false);
`;
const staffBad = (container, actor, org, sql, code) => assertSqlstate(
    container,
    `${staffPreamble(actor, org)} ${sql}`,
    code,
);

const rejectCode = async (promise, code, label) => {
    await assert.rejects(
        promise,
        (error) => error.code === code,
        label ?? `expected ${code}`,
    );
};

const CLIENT_FIELDS = {
    name: 'Synthetic Agency One',
    contactName: 'Dana Example',
    contactEmail: 'dana@agency-one.example',
    telegramUsername: '@dana_ops',
    website: 'https://agency-one.example',
    socialLinks: [{ platform: 'linkedin', url: 'https://linkedin.com/company/agency-one' }],
    isStealth: false,
    anonymousDescription: null,
};

const STEALTH_FIELDS = {
    name: 'Quantum Stealth GmbH',
    contactName: 'Erika Stealth',
    contactEmail: 'erika@quantum-stealth.example',
    telegramUsername: null,
    website: 'https://quantum-stealth.example',
    socialLinks: [{ platform: 'x', url: 'https://x.com/quantumstealth' }],
    isStealth: true,
    anonymousDescription: 'A synthetic confidential robotics company.',
};

const JD_DOCUMENT = {
    type: 'doc',
    content: [
        {
            type: 'heading',
            attrs: { level: 2 },
            content: [{ type: 'text', text: 'Mission' }],
        },
        {
            type: 'paragraph',
            content: [
                { type: 'text', text: 'Build ' },
                {
                    type: 'text',
                    text: 'synthetic products',
                    marks: [
                        { type: 'bold' },
                        { type: 'link', attrs: { href: 'https://agency-one.example/jd' } },
                    ],
                },
            ],
        },
        {
            type: 'bulletList',
            content: [{
                type: 'listItem',
                content: [
                    { type: 'paragraph', content: [{ type: 'text', text: 'First duty' }] },
                ],
            }],
        },
    ],
};

const JOB_FIELDS = {
    title: 'Synthetic Staff Engineer',
    employmentType: 'full_time',
    workplaceMode: 'remote',
    locations: [],
    remoteRegions: ['Worldwide'],
    compensationMin: '120000.00',
    compensationMax: '180000.50',
    currency: 'USD',
    payPeriod: 'year',
    bonuses: [{ type: 'equity', details: 'Synthetic equity grant' }],
    descriptionDocument: JD_DOCUMENT,
};

const auditCount = (container, operationId) => Number(scalar(container, `
    select count(*) from app.audit_events where id = '${operationId}'`));
const receiptCount = (container, operationId) => Number(scalar(container, `
    select count(*) from app.recruitment_operation_receipts
    where operation_id = '${operationId}'`));

test('client job workflows on PostgreSQL 17', async (t) => {
    assertLocalTestEnvironment();
    const adminPassword = randomUUID();
    const pg17 = await startPostgresContainer('pgclientjobs', POSTGRES_17_IMAGE, {
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
    const pg16 = await startPostgresContainer('pgclientjobs16', POSTGRES_16_IMAGE);
    t.after(() => stopAndRemoveContainer(pg16));
    const pgOperator = await startPostgresContainer('pgclientjobsop', POSTGRES_17_IMAGE);
    t.after(() => stopAndRemoveContainer(pgOperator));

    for (const fileName of PREFIX_MIGRATIONS) {
        psql(pg17, readMigration(fileName));
    }
    const runtimePassword = installStaffFixture(pg17);
    psql(pg17, clientJobFixtureSql);

    const snapshotBefore = scalar(pg17, `
        select jsonb_agg(row_to_json(x) order by x.ord, x.id)::text
        from (
            select 1 ord, id::text,
                to_jsonb(c) - 'contact_name' - 'contact_email' - 'telegram_username'
                    - 'website' - 'social_links' - 'is_stealth' - 'anonymous_description'
                    - 'public_profile_version'
                from app.clients c
            union all select 2, id::text,
                to_jsonb(j) - 'published_revision_id' - 'publicly_listed'
                    from app.jobs j
            union all select 3, id::text, to_jsonb(a) from app.applications a
            union all select 4, id::text, to_jsonb(cd) from app.candidates cd
            union all select 5, id::text, to_jsonb(e) from app.audit_events e
        ) x
    `);
    const authRoutinesBefore = psql(pg17, AUTH_ROUTINE_SNAPSHOT_SQL);

    psql(pg17, readMigration(WORKFLOW_MIGRATION));
    psql(pg17, readMigration(LISTING_MIGRATION));
    psql(pg17, readMigration(PIPELINE_MIGRATION));
    psql(pg17, readMigration(INTAKE_MIGRATION));
    // The intake subtests drive app_intake through the shared runtime
    // credential; other suites assert the credential holds only app_staff.
    psql(pg17, `grant app_intake to ${RUNTIME_ROLE}`);

    pool = new pg.Pool(staffPoolOptions(pg17, runtimePassword, 4));
    pool1 = new pg.Pool(staffPoolOptions(pg17, runtimePassword, 1));

    const admin = (fn, input) => fn(pool, identity(CJ_SUBJECTS.ADMIN), ORG_B, input);
    const recruiter = (fn, input) => fn(pool, identity(CJ_SUBJECTS.RECRUITER), ORG_B, input);
    const viewer = (fn, input) => fn(pool, identity(CJ_SUBJECTS.VIEWER), ORG_B, input);

    const createClient = async (fields = CLIENT_FIELDS, subject = CJ_SUBJECTS.RECRUITER) => {
        const result = await saveClient(pool, identity(subject), ORG_B, {
            clientId: randomUUID(),
            expectedVersion: null,
            fields,
            operationId: randomUUID(),
        });
        return result.id;
    };
    const createClientDraft = async (fields = {
        ...CLIENT_FIELDS,
        contactName: null,
        contactEmail: null,
    }) => {
        const result = await saveClientDraft(pool, identity(CJ_SUBJECTS.RECRUITER), ORG_B, {
            clientId: randomUUID(),
            expectedVersion: null,
            fields,
            operationId: randomUUID(),
        });
        return result.id;
    };
    const createDraft = async (clientId, fields = JOB_FIELDS) => {
        const result = await createJobDraft(pool, identity(CJ_SUBJECTS.RECRUITER), ORG_B, {
            jobId: randomUUID(),
            revisionId: randomUUID(),
            clientId,
            fields,
            operationId: randomUUID(),
        });
        return result;
    };

    await t.test('migration preserves data, routines, ownership and access shape', () => {
        const snapshotAfter = scalar(pg17, `
            select jsonb_agg(row_to_json(x) order by x.ord, x.id)::text
            from (
                select 1 ord, id::text,
                    to_jsonb(c) - 'contact_name' - 'contact_email' - 'telegram_username'
                        - 'website' - 'social_links' - 'is_stealth' - 'anonymous_description'
                        - 'public_profile_version'
                    from app.clients c
                union all select 2, id::text,
                    to_jsonb(j) - 'published_revision_id' - 'publicly_listed'
                        from app.jobs j
                union all select 3, id::text, to_jsonb(a) from app.applications a
                union all select 4, id::text, to_jsonb(cd) from app.candidates cd
                union all select 5, id::text, to_jsonb(e) from app.audit_events e
            ) x
        `);
        assert.deepEqual(JSON.parse(snapshotAfter), JSON.parse(snapshotBefore),
            'pre-existing clients, jobs, applications, candidates and audits are unchanged');

        assert.equal(psql(pg17, AUTH_ROUTINE_SNAPSHOT_SQL), authRoutinesBefore,
            'the five authorization routines must be unchanged');

        assert.equal(scalar(pg17, `
            select is_stealth is null and public_profile_version = 1
            from app.clients where id = '${CJ_ID.CLIENT_LEGACY_B}'`), 't',
        'legacy clients start unassessed rather than named or stealth');

        assert.equal(scalar(pg17, `
            select bool_and(publicly_listed) from app.jobs
            where organization_id = '${ORG_B}'`), 't',
        'existing jobs default to publicly listed');

        for (const table of ['job_revisions', 'recruitment_operation_receipts']) {
            assert.equal(scalar(pg17, `
                select count(*) from pg_class c
                join pg_namespace n on n.oid = c.relnamespace
                join pg_roles r on r.oid = c.relowner
                where n.nspname = 'app' and c.relname = '${table}' and c.relkind = 'r'
                    and r.rolname = 'app_owner'
                    and c.relrowsecurity and c.relforcerowsecurity`), '1',
            `${table} must be app_owner-owned with forced RLS`);
        }
        assert.equal(scalar(pg17, `
            select count(*) from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
            cross join lateral aclexplode(c.relacl) acl
            where n.nspname = 'app' and c.relkind = 'r'
                and c.relname in ('clients', 'jobs', 'job_revisions',
                    'recruitment_operation_receipts', 'pipelines')
                and acl.grantee = 'app_executor'::regrole
                and acl.privilege_type in ('DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES')`), '0');
        assert.equal(scalar(pg17, `
            select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            join pg_roles r on r.oid = p.proowner
            where n.nspname = 'app'
                and p.proname in ('${WORKFLOW_FUNCTIONS.join("','")}')
                and p.prosecdef and r.rolname = 'app_executor'
                and coalesce(p.proconfig::text, '')
                    like '%search_path=pg_catalog, app, pg_temp%'`),
            String(WORKFLOW_FUNCTIONS.length));
        assert.equal(scalar(pg17, `
            select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            join pg_roles r on r.oid = p.proowner
            where n.nspname = 'app'
                and p.proname in ('${WORKFLOW_HELPER_FUNCTIONS.join("','")}')
                and not p.prosecdef and r.rolname = 'app_owner'`),
            String(WORKFLOW_HELPER_FUNCTIONS.length));
        assert.equal(scalar(pg17, `
            select coalesce(bool_or(acl.grantee = 0), false)
            from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            cross join lateral aclexplode(
                coalesce(p.proacl, acldefault('f', p.proowner))) acl
            where n.nspname = 'app'
                and p.proname in (
                    '${[...WORKFLOW_FUNCTIONS, ...WORKFLOW_HELPER_FUNCTIONS].join("','")}'
                )`), 'f');
        assert.equal(scalar(pg17, `
            select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            cross join lateral aclexplode(p.proacl) acl
            where n.nspname = 'app'
                and p.proname in ('${WORKFLOW_FUNCTIONS.join("','")}')
                and acl.grantee <> p.proowner
                and acl.grantee <> 'app_staff'::regrole`), '0');
        assert.equal(scalar(pg17, `
            select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            cross join lateral aclexplode(p.proacl) acl
            where n.nspname = 'app'
                and p.proname in ('${WORKFLOW_HELPER_FUNCTIONS.join("','")}')
                and acl.grantee <> p.proowner
                and acl.grantee <> 'app_executor'::regrole`), '0');
        assert.equal(scalar(pg17, `
            select count(*) from pg_constraint con
            join pg_class c on c.oid = con.conrelid
            join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'app' and c.relname = 'audit_events'
                and con.conname = 'audit_events_action_check'
                and pg_get_constraintdef(con.oid) like '%client.saved%'
                and pg_get_constraintdef(con.oid) like '%staff.membership.changed%'
                and pg_get_constraintdef(con.oid) like '%privacy.subject.restricted%'`), '1');
        assert.equal(scalar(pg17, `
            select pg_catalog.has_schema_privilege('app_executor', 'app', 'create')`), 'f');
    });

    await t.test('client save validates, versions and gates stealth reveal on admin', async () => {
        const namedId = await createClient();
        const named = await recruiter(getClient, { clientId: namedId });
        assert.equal(named.name, 'Synthetic Agency One');
        assert.equal(named.contactEmail, 'dana@agency-one.example');
        assert.equal(named.telegramUsername, 'dana_ops');
        assert.equal(named.version, '1');
        assert.equal(named.publicProfileVersion, '1');

        await rejectCode(saveClient(pool, identity(CJ_SUBJECTS.RECRUITER), ORG_B, {
            clientId: randomUUID(),
            expectedVersion: null,
            fields: { ...CLIENT_FIELDS, contactEmail: 'not-an-email' },
            operationId: randomUUID(),
        }), 'INVALID_INPUT', 'JS contract rejects before the database');

        staffBad(pg17, CJ_ID.USER_B_REC, ORG_B, `
            select app.save_client_v1('${randomUUID()}'::uuid, null, '{
                "name": "No Contact",
                "contactName": "",
                "contactEmail": "",
                "telegramUsername": null,
                "website": null,
                "socialLinks": [],
                "isStealth": false,
                "anonymousDescription": null}'::jsonb,
                '${randomUUID()}'::uuid, '${randomUUID()}'::uuid)`, '22023');
        staffBad(pg17, CJ_ID.USER_B_REC, ORG_B, `
            select app.save_client_v1('${randomUUID()}'::uuid, null, '{
                "name": "Stealth Without Brief",
                "contactName": "E S",
                "contactEmail": "e@s.example",
                "telegramUsername": null,
                "website": null,
                "socialLinks": [],
                "isStealth": true,
                "anonymousDescription": null}'::jsonb,
                '${randomUUID()}'::uuid, '${randomUUID()}'::uuid)`, '22023');

        const stealthId = await createClient(STEALTH_FIELDS);
        const stealth = await recruiter(getClient, { clientId: stealthId });
        assert.equal(stealth.isStealth, true);

        const edited = await recruiter(saveClient, {
            clientId: stealthId,
            expectedVersion: '1',
            fields: { ...STEALTH_FIELDS, contactName: 'Erika S.' },
            operationId: randomUUID(),
        });
        assert.equal(edited.version, '2');
        assert.equal(edited.publicProfileVersion, '1',
            'private contact edits do not advance the public profile version');

        await rejectCode(recruiter(saveClient, {
            clientId: stealthId,
            expectedVersion: '2',
            fields: { ...STEALTH_FIELDS, isStealth: false },
            operationId: randomUUID(),
        }), '42501', 'recruiter cannot reveal a stealth client');

        const revealed = await admin(saveClient, {
            clientId: stealthId,
            expectedVersion: '2',
            fields: { ...STEALTH_FIELDS, isStealth: false },
            operationId: randomUUID(),
        });
        assert.equal(revealed.version, '3');
        assert.equal(revealed.publicProfileVersion, '2',
            'stealth reveal advances the public profile version');

        await rejectCode(recruiter(saveClient, {
            clientId: stealthId,
            expectedVersion: '2',
            fields: STEALTH_FIELDS,
            operationId: randomUUID(),
        }), '40001', 'stale client version is rejected');

        await rejectCode(viewer(getClient, { clientId: namedId }), 'FORBIDDEN',
            'a member without clients.read cannot read clients');
        await rejectCode(viewer(saveClient, {
            clientId: randomUUID(),
            expectedVersion: null,
            fields: CLIENT_FIELDS,
            operationId: randomUUID(),
        }), 'FORBIDDEN');
    });

    await t.test('client save snapshots are authorized, canonical and replay-safe', async () => {
        const clientId = await createClient();
        const operationId = randomUUID();
        const input = { clientId, expectedVersion: '1', fields: { ...CLIENT_FIELDS, name: '  Saved snapshot  ' }, operationId };
        const saved = await recruiter(saveClientWithDetails, input);
        assert.equal(saved.version, '2');
        assert.equal(saved.client.name, 'Saved snapshot');
        assert.equal(saved.client.telegramUsername, 'dana_ops');
        assert.deepEqual(saved.client, await recruiter(getClient, { clientId }));
        assert.deepEqual(await recruiter(saveClientWithDetails, input), { ...saved, replayed: true });
        assert.equal(auditCount(pg17, operationId), 1);
        assert.equal(receiptCount(pg17, operationId), 1);
        await recruiter(saveClient, { clientId, expectedVersion: '2', fields: { ...CLIENT_FIELDS, name: 'Later editor' }, operationId: randomUUID() });
        const replay = await recruiter(saveClientWithDetails, input);
        assert.equal(replay.replayed, true);
        assert.equal(replay.version, '2');
        assert.equal(replay.client.version, '3');
        assert.equal(replay.client.name, 'Later editor');
        assert.equal(auditCount(pg17, operationId), 1);
        await rejectCode(recruiter(saveClientWithDetails, { ...input, operationId: randomUUID() }), '40001');
        await rejectCode(viewer(saveClientWithDetails, { ...input, expectedVersion: '3', operationId: randomUUID() }), 'FORBIDDEN');
        await rejectCode(saveClientWithDetails(pool, identity(CJ_SUBJECTS.RECRUITER), ORG_A, { ...input, expectedVersion: '3', operationId: randomUUID() }), 'UNAUTHORIZED');
    });
    await t.test('a failed snapshot read rolls back the write and its receipt', async () => {
        const clientId = await createClient();
        const before = await recruiter(getClient, { clientId });
        const operationId = randomUUID();
        psql(pg17, 'alter function app.get_client_v1(uuid) rename to get_client_snapshot_failure_test');
        try {
            await rejectCode(recruiter(saveClientWithDetails, { clientId, expectedVersion: '1', fields: { ...CLIENT_FIELDS, name: 'Must roll back' }, operationId }), '42883');
        } finally {
            psql(pg17, 'alter function app.get_client_snapshot_failure_test(uuid) rename to get_client_v1');
        }
        assert.deepEqual(await recruiter(getClient, { clientId }), before);
        assert.equal(auditCount(pg17, operationId), 0);
        assert.equal(receiptCount(pg17, operationId), 0);
    });

    await t.test('client drafts sanitize optional fields and activate separately', async () => {
        const draftId = await createClientDraft({
            name: 'Draft Robotics Co',
            contactName: null,
            contactEmail: null,
            telegramUsername: 'ab',
            website: 'draft-robotics.example',
            socialLinks: [
                { platform: 'github', url: 'linkedin.com/in/draft' },
                { platform: 'github', url: 'github.com/draft-robotics' },
            ],
            isStealth: true,
            anonymousDescription: null,
        });
        const draft = await recruiter(getClient, { clientId: draftId });
        assert.equal(draft.status, 'draft');
        assert.equal(draft.website, 'https://draft-robotics.example');
        assert.equal(draft.telegramUsername, null);
        assert.deepEqual(draft.socialLinks, [
            { platform: 'github', url: 'https://github.com/draft-robotics' },
        ]);
        assert.equal(scalar(pg17, `
            select status || ':' || coalesce(anonymous_description, '<null>')
            from app.clients where id = '${draftId}'`), 'draft:<null>');

        const rawDraftId = randomUUID();
        const rawResult = JSON.parse(psql(pg17, `${staffPreamble(CJ_ID.USER_B_REC, ORG_B)}
            select app.save_client_draft_v1('${rawDraftId}'::uuid, null, '{
                "name": "Raw Draft Co",
                "contactName": "  Raw Contact  ",
                "contactEmail": "not-an-email",
                "telegramUsername": "@@bad",
                "website": "raw-draft.example",
                "socialLinks": [
                    {"platform":"github","url":"linkedin.com/in/raw"},
                    {"platform":"x","url":"twitter.com/raw-draft"}
                ],
                "isStealth": false,
                "anonymousDescription": "   "}'::jsonb,
                '${randomUUID()}'::uuid, '${randomUUID()}'::uuid)`)
            .trim().split('\n').at(-1));
        assert.equal(rawResult.status, 'draft');
        assert.equal(scalar(pg17, `
            select contact_name || ':' || coalesce(contact_email, '<null>') || ':'
                || coalesce(telegram_username, '<null>') || ':' || website || ':'
                || coalesce(anonymous_description, '<null>')
            from app.clients where id = '${rawDraftId}'`),
            'Raw Contact:<null>:<null>:https://raw-draft.example:<null>');
        assert.equal(scalar(pg17, `
            select social_links = '[{"platform":"x","url":"https://twitter.com/raw-draft"}]'::jsonb
            from app.clients where id = '${rawDraftId}'`), 't');

        await rejectCode(recruiter(createJobDraft, {
            jobId: randomUUID(),
            revisionId: randomUUID(),
            clientId: draftId,
            fields: JOB_FIELDS,
            operationId: randomUUID(),
        }), '23514', 'draft clients cannot receive jobs');

        staffBad(pg17, CJ_ID.USER_B_REC, ORG_B, `
            select app.save_client_v1('${randomUUID()}'::uuid, null, '{
                "name": "Mismatched Social",
                "contactName": "E S",
                "contactEmail": "e@s.example",
                "telegramUsername": null,
                "website": null,
                "socialLinks": [{"platform":"github","url":"https://linkedin.com/in/x"}],
                "isStealth": false,
                "anonymousDescription": null}'::jsonb,
                '${randomUUID()}'::uuid, '${randomUUID()}'::uuid)`, '22023');

        const activated = await recruiter(saveClient, {
            clientId: draftId,
            expectedVersion: '1',
            fields: {
                ...STEALTH_FIELDS,
                name: 'Draft Robotics Co',
                website: 'https://draft-robotics.example',
                socialLinks: [
                    { platform: 'github', url: 'https://github.com/draft-robotics' },
                ],
            },
            operationId: randomUUID(),
        });
        assert.equal(activated.status, 'active');
        assert.equal(activated.version, '2');

        await rejectCode(recruiter(saveClientDraft, {
            clientId: draftId,
            expectedVersion: '2',
            fields: {
                ...CLIENT_FIELDS,
                contactName: null,
                contactEmail: null,
            },
            operationId: randomUUID(),
        }), '23514', 'an active client cannot be saved through the draft endpoint');

        const archivedId = await createClientDraft();
        psql(pg17, `
            update app.clients set status = 'archived' where id = '${archivedId}'`);
        await rejectCode(recruiter(saveClient, {
            clientId: archivedId,
            expectedVersion: '1',
            fields: CLIENT_FIELDS,
            operationId: randomUUID(),
        }), '23514', 'archived clients cannot be activated by an ordinary save');
    });

    await t.test('job drafts, locking order and publication lifecycle', async () => {
        const clientId = await createClient();

        await rejectCode(recruiter(createJobDraft, {
            jobId: randomUUID(),
            revisionId: randomUUID(),
            clientId: CJ_ID.CLIENT_LEGACY_B,
            fields: JOB_FIELDS,
            operationId: randomUUID(),
        }), '23514', 'an unconfigured legacy client cannot accept jobs');
        await rejectCode(recruiter(createJobDraft, {
            jobId: randomUUID(),
            revisionId: randomUUID(),
            clientId: randomUUID(),
            fields: JOB_FIELDS,
            operationId: randomUUID(),
        }), 'P0002', 'foreign client ids are scoped out');

        const partial = await createDraft(clientId, {
            ...JOB_FIELDS,
            title: 'Partial draft',
            employmentType: null,
            workplaceMode: null,
            locations: [],
            remoteRegions: [],
            compensationMin: null,
            compensationMax: null,
            currency: null,
            payPeriod: null,
            bonuses: [],
            descriptionDocument: EMPTY_JOB_DOCUMENT,
        });
        assert.equal(partial.status, 'draft');
        assert.equal(partial.jobVersion, '1');
        await rejectCode(recruiter(previewJobPublic, {
            revisionId: partial.revisionId,
        }), '23514', 'incomplete drafts cannot be previewed for publication');

        const job = await createDraft(clientId);
        assert.equal(job.status, 'draft');
        assert.equal(scalar(pg17, `
            select slug from app.jobs where id = '${job.jobId}'`), `job-${job.jobId}`);
        assert.equal(scalar(pg17, `
            select publication_state || ':' || application_state || ':' || employment_type
            from app.jobs where id = '${job.jobId}'`), 'draft:open:');
        assert.equal(scalar(pg17, `
            select description_text from app.job_revisions where id = '${job.revisionId}'`),
            'Mission\nBuild synthetic products\nFirst duty');

        const workspace = await recruiter(getJobWorkspace, { jobId: job.jobId });
        assert.equal(workspace.job.id, job.jobId);
        assert.equal(workspace.draft.id, job.revisionId);
        assert.equal(workspace.draft.revisionNumber, 1);
        assert.equal(workspace.published, null);
        assert.equal(workspace.publicationNeedsReview, false);

        const saved = await recruiter(saveJobDraft, {
            revisionId: job.revisionId,
            expectedVersion: '1',
            fields: { ...JOB_FIELDS, title: 'Synthetic Staff Engineer II' },
            operationId: randomUUID(),
        });
        assert.equal(saved.revisionVersion, '2');
        assert.equal(saved.jobVersion, '1',
            'draft autosaves do not advance the job version');
    });

    await t.test('raw SQL input validation mirrors the JS contract', () => {
        const call = (fields, ready = false) => `
            select app.job_fields_valid_v1('${JSON.stringify(fields)}'::jsonb, ${ready})`;
        assert.equal(scalar(pg17, call(JOB_FIELDS, true)), 't');
        assert.equal(scalar(pg17, call({ ...JOB_FIELDS, title: 'x'.repeat(201) })), 'f');
        assert.equal(scalar(pg17, call({ ...JOB_FIELDS, compensationMin: '1.234' })), 'f');
        assert.equal(scalar(pg17, call({
            ...JOB_FIELDS, compensationMin: '200', compensationMax: '100',
        })), 'f');
        assert.equal(scalar(pg17, call({ ...JOB_FIELDS, currency: 'usd' })), 'f');
        assert.equal(scalar(pg17, call({ ...JOB_FIELDS, remoteRegions: ['Worldwide'] }, true)), 't');
        assert.equal(scalar(pg17, call({
            ...JOB_FIELDS, workplaceMode: 'onsite', locations: ['London', 'Cardiff'], remoteRegions: [],
        }, true)), 't');
        assert.equal(scalar(pg17, call({ ...JOB_FIELDS, remoteRegions: ['EU'] }, true)), 't');
        assert.equal(scalar(pg17, call({ ...JOB_FIELDS, locations: ['Not A Real Place'] })), 'f');
        assert.equal(scalar(pg17, call({ ...JOB_FIELDS, remoteRegions: [{ bad: 'value' }] })), 'f');
        assert.equal(scalar(pg17, call({ ...JOB_FIELDS, workplaceMode: 'remote', remoteRegions: [] }, true)), 'f');
        assert.equal(scalar(pg17, call({
            ...JOB_FIELDS, workplaceMode: 'onsite', locations: ['Berlin'], remoteRegions: ['Europe'],
        }, true)), 'f');
        assert.equal(scalar(pg17, call({
            ...JOB_FIELDS, bonuses: [{ type: 'other', details: 'Annual review' }],
        })), 't');
        assert.equal(scalar(pg17, call({ ...JOB_FIELDS, employmentType: null }, true)), 'f');
        assert.equal(scalar(pg17, call({ ...JOB_FIELDS, rogueKey: 1 })), 'f');
        assert.equal(scalar(pg17, call({
            ...JOB_FIELDS,
            descriptionDocument: {
                type: 'doc',
                content: [{
                    type: 'paragraph',
                    content: [{
                        type: 'text', text: 'x',
                        marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
                    }],
                }],
            },
        })), 'f');
        assert.equal(scalar(pg17, call({
            ...JOB_FIELDS,
            descriptionDocument: {
                type: 'doc',
                content: [{
                    type: 'paragraph',
                    content: [{
                        type: 'text', text: 'x',
                        marks: [{ type: 'link', attrs: { href: 'https://a.example', onclick: 'x' } }],
                    }],
                }],
            },
        })), 'f');
        let deep = { type: 'text', text: 'leaf' };
        for (let i = 0; i < 14; i += 1) {
            deep = { type: 'blockquote', content: [deep] };
        }
        assert.equal(scalar(pg17, call({
            ...JOB_FIELDS, descriptionDocument: { type: 'doc', content: [deep] },
        })), 'f');
        staffBad(pg17, CJ_ID.USER_B_REC, ORG_B,
            'select app.job_fields_valid_v1(null, false)', '42501');
    });

    await t.test('public preview, stealth projection and publish flow', async () => {
        const stealthId = await createClient(STEALTH_FIELDS);
        const job = await createDraft(stealthId);

        const preview = await recruiter(previewJobPublic, { revisionId: job.revisionId });
        const projection = preview.projection;
        assert.equal(projection.title, 'Synthetic Staff Engineer');
        assert.equal(projection.employmentType, 'full_time');
        assert.equal(projection.workplaceMode, 'remote');
        assert.deepEqual(projection.remoteRegions, ['Worldwide']);
        assert.equal(projection.compensation.min, '120000.00');
        assert.equal(projection.compensation.currency, 'USD');
        assert.equal(projection.company.name, 'Stealth company');
        assert.equal(projection.company.description, 'A synthetic confidential robotics company.');
        const serialized = JSON.stringify(projection).toLowerCase();
        for (const leak of [
            'quantum stealth', 'erika', 'quantum-stealth.example',
            'x.com/quantumstealth', 'erika@quantum-stealth.example',
            stealthId.toLowerCase(), job.jobId.toLowerCase(),
        ]) {
            assert.ok(!serialized.includes(leak), `projection must not contain ${leak}`);
        }
        assert.match(preview.reviewHash, /^[0-9a-f]{64}$/);
        assert.equal(preview.clientVersion, '1');

        await rejectCode(recruiter(publishJobRevision, {
            revisionId: job.revisionId,
            expectedVersion: '1',
            expectedClientVersion: '1',
            reviewHash: '00'.repeat(32),
            operationId: randomUUID(),
        }), '40001', 'a mismatched review hash cannot publish');

        const published = await recruiter(publishJobRevision, {
            revisionId: job.revisionId,
            expectedVersion: '1',
            expectedClientVersion: '1',
            reviewHash: preview.reviewHash,
            operationId: randomUUID(),
        });
        assert.equal(published.status, 'published');
        assert.equal(published.jobVersion, '2');
        assert.equal(published.revisionVersion, '2');
        assert.equal(scalar(pg17, `
            select publication_state || ':' || published_revision_id::text || ':'
                || employment_type || ':' || location_display
            from app.jobs where id = '${job.jobId}'`),
            `published:${job.revisionId}:full_time:Remote (Worldwide)`);
        assert.equal(scalar(pg17, `
            select salary_display from app.jobs where id = '${job.jobId}'`),
            '120000.00–180000.50 USD/year');

        const publication = await recruiter(getJobPublication, { jobId: job.jobId });
        assert.deepEqual(publication, projection,
            'the stored publication equals the reviewed projection');

        const draft2 = await recruiter(beginJobRevision, {
            jobId: job.jobId,
            revisionId: randomUUID(),
            expectedJobVersion: '2',
            operationId: randomUUID(),
        });
        assert.equal(draft2.status, 'draft');
        await recruiter(saveJobDraft, {
            revisionId: draft2.revisionId,
            expectedVersion: '1',
            fields: { ...JOB_FIELDS, title: 'Renamed after publish' },
            operationId: randomUUID(),
        });
        assert.deepEqual(
            await recruiter(getJobPublication, { jobId: job.jobId }),
            projection,
            'draft edits after publish never change the stored publication',
        );
        const staleOld = psqlExpectError(pg17, `
            update app.job_revisions set title = 'tampered'
            where id = '${job.revisionId}'`);
        assert.match(staleOld, /23514/, 'reviewed revisions reject content edits');
        assert.equal(scalar(pg17, `
            select status || ':' || title from app.job_revisions
            where id = '${job.revisionId}'`), 'published:Synthetic Staff Engineer');
        assert.equal(scalar(pg17, `
            select count(*) from app.job_revisions where job_id = '${job.jobId}'`), '2');

        await rejectCode(recruiter(beginJobRevision, {
            jobId: job.jobId,
            revisionId: randomUUID(),
            expectedJobVersion: '2',
            operationId: randomUUID(),
        }), '23505', 'a second parallel draft cannot be started');

        const namedId = await createClient({ ...CLIENT_FIELDS, name: 'Named Client Ltd' });
        const namedJob = await createDraft(namedId);
        const namedPreview = await recruiter(previewJobPublic, {
            revisionId: namedJob.revisionId,
        });
        assert.equal(namedPreview.projection.company.name, 'Named Client Ltd');
        assert.equal(namedPreview.projection.company.description, null);
    });

    await t.test('stealth identity leak guardrails', async () => {
        const stealthId = await createClient(STEALTH_FIELDS);
        const leaky = await createDraft(stealthId, {
            ...JOB_FIELDS,
            descriptionDocument: {
                type: 'doc',
                content: [{
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'Join Quantum Stealth GmbH today.' }],
                }],
            },
        });
        await rejectCode(recruiter(previewJobPublic, { revisionId: leaky.revisionId }),
            '23514', 'a stored client name inside the description blocks the projection');
        const leakyLink = await createDraft(stealthId, {
            ...JOB_FIELDS,
            descriptionDocument: {
                type: 'doc',
                content: [{
                    type: 'paragraph',
                    content: [{
                        type: 'text',
                        text: 'See details',
                        marks: [{
                            type: 'link',
                            attrs: { href: 'https://x.com/quantumstealth' },
                        }],
                    }],
                }],
            },
        });
        await rejectCode(recruiter(previewJobPublic, { revisionId: leakyLink.revisionId }),
            '23514', 'a stored social URL inside the document blocks the projection');

        const telegramClient = await createClient({
            ...STEALTH_FIELDS,
            telegramUsername: 'quantum_ops',
        });
        const leakyTelegram = await createDraft(telegramClient, {
            ...JOB_FIELDS,
            descriptionDocument: {
                type: 'doc',
                content: [{
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'Message @quantum_ops for details.' }],
                }],
            },
        });
        await rejectCode(recruiter(previewJobPublic, {
            revisionId: leakyTelegram.revisionId,
        }), '23514', 'a stored Telegram handle inside the description blocks the projection');
    });

    await t.test('client public edits invalidate publications until re-review', async () => {
        const clientId = await createClient();
        const job = await createDraft(clientId);
        const preview = await recruiter(previewJobPublic, { revisionId: job.revisionId });
        await recruiter(publishJobRevision, {
            revisionId: job.revisionId,
            expectedVersion: '1',
            expectedClientVersion: '1',
            reviewHash: preview.reviewHash,
            operationId: randomUUID(),
        });
        assert.ok(await recruiter(getJobPublication, { jobId: job.jobId }));

        await recruiter(saveClient, {
            clientId,
            expectedVersion: '1',
            fields: { ...CLIENT_FIELDS, contactEmail: 'new-email@agency-one.example' },
            operationId: randomUUID(),
        });
        assert.ok(await recruiter(getJobPublication, { jobId: job.jobId }),
            'private contact edits keep the publication');

        await admin(saveClient, {
            clientId,
            expectedVersion: '2',
            fields: { ...CLIENT_FIELDS, name: 'Renamed Client', contactEmail: 'new-email@agency-one.example' },
            operationId: randomUUID(),
        });
        assert.equal(await recruiter(getJobPublication, { jobId: job.jobId }), null,
            'public profile changes fail closed until re-review');
        const workspace = await recruiter(getJobWorkspace, { jobId: job.jobId });
        assert.equal(workspace.publicationNeedsReview, true);
    });

    await t.test('duplication copies content into a fresh draft only', async () => {
        const clientId = await createClient();
        const job = await createDraft(clientId);
        const preview = await recruiter(previewJobPublic, { revisionId: job.revisionId });
        await admin(publishJobRevision, {
            revisionId: job.revisionId,
            expectedVersion: '1',
            expectedClientVersion: '1',
            reviewHash: preview.reviewHash,
            operationId: randomUUID(),
        });

        const dup = await recruiter(duplicateJob, {
            sourceRevisionId: job.revisionId,
            expectedSourceVersion: '2',
            clientId,
            jobId: randomUUID(),
            revisionId: randomUUID(),
            operationId: randomUUID(),
        });
        assert.equal(dup.status, 'draft');
        assert.equal(dup.jobVersion, '1');
        const dupWorkspace = await recruiter(getJobWorkspace, { jobId: dup.jobId });
        assert.equal(dupWorkspace.job.slug, `job-${dup.jobId}`);
        assert.equal(dupWorkspace.draft.publishedAt, null);
        assert.equal(dupWorkspace.draft.publishedByMembershipId, null);
        assert.equal(dupWorkspace.draft.title, 'Synthetic Staff Engineer');
        assert.equal(scalar(pg17, `
            select count(*) from app.applications where job_id = '${dup.jobId}'`), '0');

        const otherClient = await createClient({ ...CLIENT_FIELDS, name: 'Second Client' });
        const dup2 = await recruiter(duplicateJob, {
            sourceRevisionId: dup.revisionId,
            expectedSourceVersion: '1',
            clientId: otherClient,
            jobId: randomUUID(),
            revisionId: randomUUID(),
            operationId: randomUUID(),
        });
        const dup2Workspace = await recruiter(getJobWorkspace, { jobId: dup2.jobId });
        assert.equal(dup2Workspace.job.clientId, otherClient,
            'duplication may target a different client');
    });

    await t.test('operation receipts make uncertain retries safe', async () => {
        const clientId = await createClient();
        const opId = randomUUID();
        const input = {
            jobId: randomUUID(),
            revisionId: randomUUID(),
            clientId,
            fields: JOB_FIELDS,
            operationId: opId,
        };
        const first = await recruiter(createJobDraft, input);
        const audits = auditCount(pg17, opId);
        const replay = await recruiter(createJobDraft, input);
        const { replayed, ...replayResult } = replay;
        assert.equal(replayed, true);
        assert.deepEqual(replayResult, first);
        assert.equal(auditCount(pg17, opId), audits,
            'replays do not write a second audit row');
        assert.equal(receiptCount(pg17, opId), 1);

        await rejectCode(recruiter(createJobDraft, {
            ...input,
            fields: { ...JOB_FIELDS, title: 'Different payload' },
        }), '23505', 'a reused operation id with a different payload conflicts');
        await rejectCode(admin(createJobDraft, input), '23505',
            'a reused operation id by another actor conflicts');
        const inert = scalar(pg17, `
            select count(*) from app.jobs where id = '${input.jobId}'`);
        assert.equal(inert, '1', 'conflicting retries never write duplicate rows');

        const saveOp = randomUUID();
        const saveInput = {
            revisionId: input.revisionId,
            expectedVersion: '1',
            fields: { ...JOB_FIELDS, title: 'Saved once' },
            operationId: saveOp,
        };
        const savedFirst = await recruiter(saveJobDraft, saveInput);
        const savedReplay = await recruiter(saveJobDraft, saveInput);
        assert.equal(savedReplay.replayed, true);
        assert.deepEqual(
            { jobId: savedReplay.jobId, revisionVersion: savedReplay.revisionVersion },
            { jobId: savedFirst.jobId, revisionVersion: savedFirst.revisionVersion });

        const preview = await recruiter(previewJobPublic, { revisionId: input.revisionId });
        const pubOp = randomUUID();
        const pubInput = {
            revisionId: input.revisionId,
            expectedVersion: '2',
            expectedClientVersion: '1',
            reviewHash: preview.reviewHash,
            operationId: pubOp,
        };
        const pubFirst = await recruiter(publishJobRevision, pubInput);
        const pubReplay = await recruiter(publishJobRevision, pubInput);
        assert.equal(pubReplay.replayed, true);
        assert.equal(pubReplay.jobId, pubFirst.jobId);
        assert.equal(auditCount(pg17, pubOp), 1);

        const raceOp = randomUUID();
        const raceInput = {
            jobId: randomUUID(),
            revisionId: randomUUID(),
            clientId,
            fields: { ...JOB_FIELDS, title: 'Concurrent create' },
            operationId: raceOp,
        };
        const results = await Promise.allSettled([
            recruiter(createJobDraft, raceInput),
            recruiter(createJobDraft, raceInput),
        ]);
        const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
        assert.ok(ok.length >= 1, 'at least one concurrent create succeeds');
        for (const value of ok) {
            assert.equal(value.jobId, raceInput.jobId);
        }
        assert.equal(receiptCount(pg17, raceOp), 1);
        assert.equal(auditCount(pg17, raceOp), 1);
        assert.equal(scalar(pg17, `
            select count(*) from app.jobs where id = '${raceInput.jobId}'`), '1');
    });

    await t.test('version conflicts and permission rechecks fail closed', async () => {
        const clientId = await createClient();
        const job = await createDraft(clientId);

        const race = await Promise.allSettled([
            recruiter(saveJobDraft, {
                revisionId: job.revisionId,
                expectedVersion: '1',
                fields: { ...JOB_FIELDS, title: 'Winner' },
                operationId: randomUUID(),
            }),
            recruiter(saveJobDraft, {
                revisionId: job.revisionId,
                expectedVersion: '1',
                fields: { ...JOB_FIELDS, title: 'Loser' },
                operationId: randomUUID(),
            }),
        ]);
        const fulfilled = race.filter((r) => r.status === 'fulfilled');
        const conflicted = race.filter((r) => r.status === 'rejected' && r.reason.code === '40001');
        assert.equal(fulfilled.length, 1, 'exactly one same-version save wins');
        assert.equal(conflicted.length, 1, 'the loser receives 40001');

        await rejectCode(recruiter(saveJobDraft, {
            revisionId: job.revisionId,
            expectedVersion: '1',
            fields: JOB_FIELDS,
            operationId: randomUUID(),
        }), '40001');

        const preview = await recruiter(previewJobPublic, { revisionId: job.revisionId });
        await rejectCode(recruiter(publishJobRevision, {
            revisionId: job.revisionId,
            expectedVersion: '2',
            expectedClientVersion: '99',
            reviewHash: preview.reviewHash,
            operationId: randomUUID(),
        }), '40001', 'a stale client version cannot publish');

        psql(pg17, `
            delete from app.role_permissions
            where organization_id = '${ORG_B}'
                and role_id = '${CJ_ID.ROLE_B_RECRUITER}'
                and permission_key = 'jobs.write'`);
        await rejectCode(recruiter(saveJobDraft, {
            revisionId: job.revisionId,
            expectedVersion: '2',
            fields: JOB_FIELDS,
            operationId: randomUUID(),
        }), 'FORBIDDEN', 'revoked jobs.write blocks new writes');
        const replayedOpId = randomUUID();
        const replayInput = {
            jobId: randomUUID(),
            revisionId: randomUUID(),
            clientId,
            fields: JOB_FIELDS,
            operationId: replayedOpId,
        };
        psql(pg17, `
            insert into app.role_permissions (organization_id, role_id, permission_key)
            values ('${ORG_B}', '${CJ_ID.ROLE_B_RECRUITER}', 'jobs.write')`);
        await recruiter(createJobDraft, replayInput);
        psql(pg17, `
            delete from app.role_permissions
            where organization_id = '${ORG_B}'
                and role_id = '${CJ_ID.ROLE_B_RECRUITER}'
                and permission_key = 'jobs.write'`);
        await rejectCode(recruiter(createJobDraft, replayInput), 'FORBIDDEN',
            'a revoked permission denies even a cached receipt replay');
        psql(pg17, `
            insert into app.role_permissions (organization_id, role_id, permission_key)
            values ('${ORG_B}', '${CJ_ID.ROLE_B_RECRUITER}', 'jobs.write')`);
    });

    await t.test('read permission conjunctions and context isolation hold', async () => {
        const clientId = await createClient();
        const job = await createDraft(clientId);

        psql(pg17, `
            delete from app.role_permissions
            where organization_id = '${ORG_B}'
                and role_id = '${CJ_ID.ROLE_B_RECRUITER}'
                and permission_key in ('clients.read', 'jobs.read')`);
        psql(pg17, `
            insert into app.role_permissions (organization_id, role_id, permission_key)
            values ('${ORG_B}', '${CJ_ID.ROLE_B_RECRUITER}', 'clients.read')`);
        await rejectCode(recruiter(getJobWorkspace, { jobId: job.jobId }), 'FORBIDDEN',
            'clients.read alone cannot read jobs');
        psql(pg17, `
            delete from app.role_permissions
            where organization_id = '${ORG_B}'
                and role_id = '${CJ_ID.ROLE_B_RECRUITER}'
                and permission_key = 'clients.read'`);
        psql(pg17, `
            insert into app.role_permissions (organization_id, role_id, permission_key)
            values ('${ORG_B}', '${CJ_ID.ROLE_B_RECRUITER}', 'jobs.read')`);
        await rejectCode(recruiter(getJobWorkspace, { jobId: job.jobId }), 'FORBIDDEN',
            'jobs.read without clients.read cannot read jobs');
        psql(pg17, `
            insert into app.role_permissions (organization_id, role_id, permission_key)
            values ('${ORG_B}', '${CJ_ID.ROLE_B_RECRUITER}', 'clients.read')`);

        await rejectCode(
            saveClient(pool, identity(CJ_SUBJECTS.RECRUITER), ORG_A, {
                clientId: randomUUID(),
                expectedVersion: null,
                fields: CLIENT_FIELDS,
                operationId: randomUUID(),
            }),
            'UNAUTHORIZED',
            'a recruiter of org B is not a member of org A',
        );

        staffBad(pg17, CJ_ID.USER_B_REC, ORG_B, `
            select app.get_client_v1('${randomUUID()}'::uuid)`, 'P0002');
        staffBad(pg17, CJ_ID.USER_B_VIEW, ORG_B, `
            select app.get_client_v1('${clientId}'::uuid)`, '42501');
        staffBad(pg17, '', ORG_B, `
            select app.get_client_v1('${clientId}'::uuid)`, '42501');
        staffBad(pg17, CJ_ID.USER_B_REC, '', `
            select app.get_client_v1('${clientId}'::uuid)`, '42501');
        assertSqlstate(pg17, `
            set role app_staff;
            select pg_catalog.set_config('app.actor_id', '${CJ_ID.USER_B_REC}', false),
                   pg_catalog.set_config('app.organization_id', '${ORG_B}', false);
            begin isolation level repeatable read;
            select app.save_client_v1('${randomUUID()}'::uuid, null,
                '${JSON.stringify(CLIENT_FIELDS)}'::jsonb,
                '${randomUUID()}'::uuid, '${randomUUID()}'::uuid);`, '25001');
        assertSqlstate(pg17, `
            set role app_staff;
            select app.save_client_v1('${randomUUID()}'::uuid, null,
                '${JSON.stringify(CLIENT_FIELDS)}'::jsonb,
                '${randomUUID()}'::uuid, '${randomUUID()}'::uuid);`, '42501');
    });

    await t.test('raw table access stays denied and helpers are executor-only', async () => {
        for (const role of ['app_staff', 'app_intake', 'app_worker']) {
            for (const sql of [
                'select count(*) from app.job_revisions',
                'select count(*) from app.recruitment_operation_receipts',
                'select count(*) from app.clients',
            ]) {
                assertSqlstate(pg17, `set role ${role}; ${sql};`, '42501');
            }
        }
        for (const helper of [
            `app.job_fields_valid_v1('{}'::jsonb, false)`,
            `app.client_fields_valid_v1('{}'::jsonb)`,
            `app.job_public_projection_v1('${randomUUID()}'::uuid)`,
            `app.recruitment_actor_v1(array['jobs.read'], null, null, false)`,
        ]) {
            assertSqlstate(pg17, `set role app_staff; select ${helper};`, '42501');
        }
        for (const fn of [
            `app.save_client_v1('${randomUUID()}'::uuid, null, '${JSON.stringify(CLIENT_FIELDS)}'::jsonb,
                '${randomUUID()}'::uuid, '${randomUUID()}'::uuid)`,
            `app.get_client_v1('${randomUUID()}'::uuid)`,
            `app.preview_job_public_v1('${randomUUID()}'::uuid)`,
        ]) {
            assertSqlstate(pg17, `set role app_worker; select ${fn};`, '42501');
            assertSqlstate(pg17, `set role app_intake; select ${fn};`, '42501');
        }
        assertSqlstate(pg17, `
            set role app_staff;
            select pg_catalog.set_config('app.actor_id', '${CJ_ID.USER_B_REC}', false),
                   pg_catalog.set_config('app.organization_id', '${ORG_B}', false);
            update app.job_revisions set title = 'raw' where false;`, '42501');
        assertSqlstate(pg17, `
            set role app_staff;
            delete from app.recruitment_operation_receipts where true;`, '42501');
    });

    await t.test('audit events carry no content values and context clears', async () => {
        const clientId = await createClient();
        const job = await createDraft(clientId);
        const preview = await recruiter(previewJobPublic, { revisionId: job.revisionId });
        const pubOp = randomUUID();
        await recruiter(publishJobRevision, {
            revisionId: job.revisionId,
            expectedVersion: '1',
            expectedClientVersion: '1',
            reviewHash: preview.reviewHash,
            operationId: pubOp,
        });
        const audit = JSON.parse(scalar(pg17, `
            select row_to_json(e)::text from app.audit_events e where id = '${pubOp}'`));
        assert.equal(audit.action, 'job.published');
        assert.equal(audit.actor_kind, 'staff');
        assert.equal(audit.target_type, 'job');
        const details = JSON.stringify(audit.details);
        for (const secret of ['Synthetic Staff Engineer', '120000', 'Mission', 'USD']) {
            assert.ok(!details.includes(secret), `audit details must not contain ${secret}`);
        }
        const keys = Object.keys(audit.details).sort();
        for (const key of keys) {
            assert.ok([
                'previous_version', 'new_version', 'revision_id', 'client_id',
                'public_profile_changed', 'source_job_id', 'source_revision_id',
                'field_names',
            ].includes(key), `unexpected audit detail key ${key}`);
        }

        const probe = await pool1.connect();
        try {
            const check = await probe.query(
                `select pg_catalog.current_setting('app.actor_id', true) as actor,
                        pg_catalog.current_setting('app.organization_id', true) as org`,
            );
            assert.equal(check.rows[0].actor, null);
            assert.equal(check.rows[0].org, null);
        } finally {
            probe.release();
        }
    });

    await t.test('listing procedures enforce context and permission conjunctions', async () => {
        const clientId = await createClient();
        const job = await createDraft(clientId);

        const clients = await recruiter(listClients, {});
        const listedClient = clients.find((entry) => entry.id === clientId);
        assert.equal(listedClient.name, CLIENT_FIELDS.name);
        assert.equal(typeof listedClient.jobCount, 'number');
        assert.ok(listedClient.jobCount >= 1);

        const jobs = await recruiter(listJobs, {});
        const listedJob = jobs.find((entry) => entry.id === job.jobId);
        assert.equal(listedJob.clientId, clientId);
        assert.equal(listedJob.clientName, CLIENT_FIELDS.name);
        assert.equal(listedJob.publicationState, 'draft');
        assert.ok(listedJob.draftRevisionId);

        const publishedOnly = await recruiter(listJobs, { publicationState: 'published' });
        assert.equal(publishedOnly.some((entry) => entry.id === job.jobId), false);
        const owned = await recruiter(listJobs, { ownerMembershipId: CJ_ID.MEMBER_B_REC });
        assert.ok(owned.every((entry) => entry.ownerMembershipId === CJ_ID.MEMBER_B_REC));

        // Input validation and permission conjunction.
        await rejectCode(recruiter(listJobs, { publicationState: 'bogus' }), 'INVALID_INPUT');
        await rejectCode(recruiter(listClients, { limit: 501 }), 'INVALID_INPUT');
        await rejectCode(viewer(listClients, {}), 'FORBIDDEN');
        await rejectCode(viewer(listJobs, {}), 'FORBIDDEN');
        staffBad(pg17, CJ_ID.USER_B_REC, '', `
            select app.list_clients_v1(10)`, '42501');
        staffBad(pg17, '', ORG_B, `
            select app.list_jobs_v1(10, null, null)`, '42501');
        for (const role of ['app_intake', 'app_worker']) {
            assertSqlstate(pg17, `set role ${role}; select app.list_clients_v1(10)`, '42501');
        }
    });

    await t.test('application pipeline: list, transition and notes', async () => {
        const {
            listApplications, listCandidates, getCandidateWorkspace,
            transitionApplicationStage, addCandidateNote,
        } = await import('../../src/lib/pipeline-operations.js');

        // Directory reads.
        const list = await admin(listApplications, {});
        const listed = list.applications.find(
            (entry) => entry.applicationId === CJ_ID.APPLICATION_B);
        assert.equal(listed.candidateId, CJ_ID.CANDIDATE_B);
        assert.equal(listed.jobTitle, 'Legacy Synthetic Job');
        assert.equal(listed.clientName, 'Synthetic Legacy Client');
        assert.equal(listed.stageKey, 'review');
        assert.equal(listed.stageLabel, 'Review');

        const candidates = await admin(listCandidates, {});
        const listedCandidate = candidates.candidates.find(
            (entry) => entry.candidateId === CJ_ID.CANDIDATE_B);
        assert.equal(listedCandidate.fullName, 'Synthetic Candidate B');
        assert.equal(listedCandidate.applicationCount, 1);

        const workspace = await admin(getCandidateWorkspace, {
            candidateId: CJ_ID.CANDIDATE_B,
        });
        assert.equal(workspace.candidate.fullName, 'Synthetic Candidate B');
        assert.equal(workspace.applications.length, 1);
        assert.equal(workspace.applications[0].applicationId, CJ_ID.APPLICATION_B);
        assert.equal(workspace.stages.length, 2);
        assert.equal(workspace.capabilities.changeStage, true);
        assert.equal(workspace.capabilities.writeNotes, true);

        // Stage transition: version-checked move with history + audit.
        const moveAudit = randomUUID();
        const moved = await admin(transitionApplicationStage, {
            applicationId: CJ_ID.APPLICATION_B,
            toStageId: CJ_ID.STAGE_B_2,
            expectedVersion: '1',
            reason: 'Strong CV',
            operationId: moveAudit,
        });
        assert.equal(moved.stageId, CJ_ID.STAGE_B_2);
        assert.equal(moved.version, '2');
        assert.equal(scalar(pg17, `
            select count(*) from app.application_stage_history
            where application_id = '${CJ_ID.APPLICATION_B}'
                and to_stage_id = '${CJ_ID.STAGE_B_2}'`), '1');
        assert.equal(auditCount(pg17, moveAudit), 1);
        assert.equal(scalar(pg17, `
            select action from app.audit_events where id = '${moveAudit}'`),
            'application.stage.changed');

        // Stale version and unknown stage reject.
        await rejectCode(admin(transitionApplicationStage, {
            applicationId: CJ_ID.APPLICATION_B,
            toStageId: CJ_ID.STAGE_B_1,
            expectedVersion: '1',
            reason: null,
            operationId: randomUUID(),
        }), '40001', 'a stale version is rejected');
        await rejectCode(admin(transitionApplicationStage, {
            applicationId: CJ_ID.APPLICATION_B,
            toStageId: randomUUID(),
            expectedVersion: '2',
            reason: null,
            operationId: randomUUID(),
        }), 'P0002', 'a stage outside the pipeline is rejected');

        // Notes land in the workspace and audit.
        const noteAudit = randomUUID();
        const note = await admin(addCandidateNote, {
            candidateId: CJ_ID.CANDIDATE_B,
            body: 'Followed up after screen.',
            operationId: noteAudit,
        });
        assert.ok(note.noteId);
        assert.equal(auditCount(pg17, noteAudit), 1);
        const workspaceAfter = await admin(getCandidateWorkspace, {
            candidateId: CJ_ID.CANDIDATE_B,
        });
        assert.equal(workspaceAfter.notes.length, 1);
        assert.equal(workspaceAfter.notes[0].body, 'Followed up after screen.');
        assert.equal(
            workspaceAfter.applications[0].stageLabel, 'Interview');
        // The fixture application had no recorded history, so the transition
        // backfills a placement row before the actual move.
        assert.equal(workspaceAfter.applications[0].history.length, 2);
        assert.equal(
            workspaceAfter.applications[0].history.at(-1).toStageLabel,
            'Interview');
    });

    await t.test('application pipeline: permission boundaries hold', async () => {
        const {
            listApplications, listCandidates, getCandidateWorkspace,
            transitionApplicationStage, addCandidateNote, getDocumentDownload,
        } = await import('../../src/lib/pipeline-operations.js');

        // The viewer role carries no catalog permissions in this fixture.
        await rejectCode(viewer(listApplications, {}), 'FORBIDDEN');
        await rejectCode(viewer(listCandidates, {}), 'FORBIDDEN');
        await rejectCode(viewer(getCandidateWorkspace, {
            candidateId: CJ_ID.CANDIDATE_B,
        }), 'FORBIDDEN');
        await rejectCode(viewer(transitionApplicationStage, {
            applicationId: CJ_ID.APPLICATION_B,
            toStageId: CJ_ID.STAGE_B_1,
            expectedVersion: '2',
            reason: null,
            operationId: randomUUID(),
        }), 'FORBIDDEN');
        await rejectCode(viewer(addCandidateNote, {
            candidateId: CJ_ID.CANDIDATE_B,
            body: 'nope',
            operationId: randomUUID(),
        }), 'FORBIDDEN');
        await rejectCode(viewer(getDocumentDownload, {
            documentId: randomUUID(),
        }), 'FORBIDDEN');

        // The recruiter has applications.read + candidates.read but neither
        // applications.stage nor collaboration.write.
        const workspace = await recruiter(getCandidateWorkspace, {
            candidateId: CJ_ID.CANDIDATE_B,
        });
        assert.equal(workspace.capabilities.changeStage, false);
        assert.equal(workspace.capabilities.writeNotes, false);
        assert.equal(workspace.notes.length, 0,
            'notes stay hidden without collaboration.read');
        await rejectCode(recruiter(transitionApplicationStage, {
            applicationId: CJ_ID.APPLICATION_B,
            toStageId: CJ_ID.STAGE_B_1,
            expectedVersion: '2',
            reason: null,
            operationId: randomUUID(),
        }), 'FORBIDDEN');
        await rejectCode(recruiter(addCandidateNote, {
            candidateId: CJ_ID.CANDIDATE_B,
            body: 'nope',
            operationId: randomUUID(),
        }), 'FORBIDDEN');

        // Cross-organization isolation: org A admin sees nothing of org B.
        const other = await listApplications(
            pool, identity(CJ_SUBJECTS.ADMIN), ORG_A, {});
        assert.equal(
            other.applications.some(
                (entry) => entry.applicationId === CJ_ID.APPLICATION_B),
            false);
    });

    await t.test('public intake: board lists published jobs and submissions land in the pipeline', async () => {
        const { listPublicJobs, submitPublicApplication } =
            await import('../../src/lib/intake-operations.js');
        const { setJobPublicListing } =
            await import('../../src/lib/client-job-operations.js');
        const intake = (fn, input) => fn(pool, ORG_B, input);

        // Publish a fresh job through the normal staff flow.
        const clientId = await createClient();
        const job = await createDraft(clientId);
        const slug = scalar(pg17,
            `select slug from app.jobs where id = '${job.jobId}'`);
        const preview = await recruiter(previewJobPublic, {
            revisionId: job.revisionId,
        });
        await recruiter(publishJobRevision, {
            revisionId: job.revisionId,
            expectedVersion: '1',
            expectedClientVersion: '1',
            reviewHash: preview.reviewHash,
            operationId: randomUUID(),
        });

        const listing = await intake(listPublicJobs, {});
        const listed = listing.jobs.find((entry) => entry.slug === slug);
        assert.ok(listed, 'published job appears on the public board');
        assert.equal(listed.title, JOB_FIELDS.title);
        assert.equal(listed.applicationOpen, true);
        assert.equal(listed.company.name, CLIENT_FIELDS.name);
        assert.equal(
            listing.jobs.some((entry) => entry.slug === 'job-' + CJ_ID.JOB_LEGACY_B),
            false, 'draft jobs stay off the board');
        assert.equal(
            listed.jobId, undefined, 'internal ids are not exposed publicly');

        // A submission lands as candidate + application + verified document.
        const cvHash = 'ab'.repeat(32);
        const submitted = await intake(submitPublicApplication, {
            jobSlug: slug,
            reference: 'AG-BBBB00000001',
            fullName: 'Public Applicant',
            email: 'public.applicant@example.com',
            professionalUrl: 'https://linkedin.com/in/public-applicant',
            achievement: 'Shipped public intake.',
            document: {
                sha256: cvHash,
                sizeBytes: 2048,
                mimeType: 'application/pdf',
                extension: 'pdf',
                bucket: 'cv-submissions',
                objectKey: `cvs/${slug}/AG-BBBB00000001.pdf`,
                filename: 'cv.pdf',
            },
        });
        assert.equal(submitted.accepted, true);
        assert.equal(submitted.duplicate, false);
        assert.equal(submitted.reusedCandidate, false);
        assert.equal(submitted.publicReference, 'AG-BBBB00000001');

        const { getCandidateWorkspace } =
            await import('../../src/lib/pipeline-operations.js');
        const workspace = await admin(getCandidateWorkspace, {
            candidateId: submitted.candidateId,
        });
        assert.equal(workspace.candidate.fullName, 'Public Applicant');
        assert.equal(workspace.applications.length, 1);
        assert.equal(
            workspace.applications[0].publicReference, 'AG-BBBB00000001');
        assert.equal(workspace.applications[0].stageLabel, 'Review',
            'the application enters the pipeline initial stage');
        assert.equal(workspace.applications[0].history.length, 1);
        assert.equal(
            workspace.applications[0].history[0].fromStageLabel, null,
            'the placement row has no origin stage');
        assert.equal(
            workspace.applications[0].history[0].toStageLabel, 'Review');
        assert.equal(
            workspace.applications[0].history[0].actorName, null,
            'intake rows carry no staff actor');
        assert.equal(workspace.documents.length, 1);
        assert.equal(workspace.documents[0].filename, 'cv.pdf');
        assert.equal(workspace.documents[0].scanState, 'unscanned');
        assert.equal(scalar(pg17, `
            select bl.state from app.blob_locations bl
            join app.documents d on d.blob_id = bl.blob_id
            where d.id = '${submitted.documentId ?? workspace.documents[0].id}'`),
            'available');
        assert.equal(scalar(pg17, `
            select count(*) from app.audit_events
            where organization_id = '${ORG_B}'
                and action = 'application.received'
                and actor_kind = 'intake'`), '1',
            'the submission writes an intake audit row');

        // Same reference replays idempotently.
        const replay = await intake(submitPublicApplication, {
            jobSlug: slug,
            reference: 'AG-BBBB00000001',
            fullName: 'Public Applicant',
            email: 'public.applicant@example.com',
            professionalUrl: null,
            achievement: null,
            document: null,
        });
        assert.equal(replay.duplicate, true);
        assert.equal(replay.applicationId, submitted.applicationId);

        // Same email on a different job dedupes the candidate, not the apply.
        const client2 = await createClient();
        const job2 = await createDraft(client2);
        const slug2 = scalar(pg17,
            `select slug from app.jobs where id = '${job2.jobId}'`);
        const preview2 = await recruiter(previewJobPublic, {
            revisionId: job2.revisionId,
        });
        await recruiter(publishJobRevision, {
            revisionId: job2.revisionId,
            expectedVersion: '1',
            expectedClientVersion: '1',
            reviewHash: preview2.reviewHash,
            operationId: randomUUID(),
        });
        const second = await intake(submitPublicApplication, {
            jobSlug: slug2,
            reference: 'AG-BBBB00000002',
            fullName: 'Same Person Again',
            email: 'PUBLIC.APPLICANT@example.com',
            professionalUrl: null,
            achievement: null,
            document: null,
        });
        assert.equal(second.duplicate, false);
        assert.equal(second.reusedCandidate, true);
        assert.equal(second.candidateId, submitted.candidateId);

        // A repeat application to the same job returns the original.
        const repeatApply = await intake(submitPublicApplication, {
            jobSlug: slug,
            reference: 'AG-BBBB00000003',
            fullName: 'Public Applicant',
            email: 'public.applicant@example.com',
            professionalUrl: null,
            achievement: null,
            document: null,
        });
        assert.equal(repeatApply.duplicate, true);
        assert.equal(repeatApply.applicationId, submitted.applicationId);

        // Hiding the job removes it from the board and blocks submissions.
        await recruiter(setJobPublicListing, {
            jobId: job.jobId,
            listed: false,
            expectedVersion: '2',
            operationId: randomUUID(),
        });
        const hidden = await intake(listPublicJobs, {});
        assert.equal(
            hidden.jobs.some((entry) => entry.slug === slug), false,
            'unlisted jobs disappear from the board');
        await rejectCode(intake(submitPublicApplication, {
            jobSlug: slug,
            reference: 'AG-BBBB00000004',
            fullName: 'Blocked Applicant',
            email: 'blocked@example.com',
            professionalUrl: null,
            achievement: null,
            document: null,
        }), 'P0002', 'submissions to unlisted jobs are rejected');

        // Unknown slugs and cross-org jobs fail the same way.
        await rejectCode(intake(submitPublicApplication, {
            jobSlug: 'no-such-job',
            reference: 'AG-BBBB00000005',
            fullName: 'Blocked Applicant',
            email: 'blocked@example.com',
            professionalUrl: null,
            achievement: null,
            document: null,
        }), 'P0002');
        const otherListing = await listPublicJobs(pool, ORG_A, {});
        assert.equal(
            otherListing.jobs.some((entry) => entry.slug === slug), false,
            'org A cannot see org B jobs');
    });

    await t.test('public intake: roles and context stay in their lane', async () => {
        const { setJobPublicListing } =
            await import('../../src/lib/client-job-operations.js');

        // app_intake cannot reach staff procedures; app_staff cannot reach
        // intake procedures.
        assertSqlstate(pg17, `
            set role app_intake;
            select app.list_applications_v1()
        `, '42501');
        assertSqlstate(pg17, `
            set role app_staff;
            select app.list_public_jobs_v1()
        `, '42501');

        // An intake call carrying a staff actor context is refused.
        assertSqlstate(pg17, `
            set role app_intake;
            select pg_catalog.set_config('app.actor_id', '${CJ_ID.USER_B_REC}', false),
                   pg_catalog.set_config('app.organization_id', '${ORG_B}', false);
            select app.list_public_jobs_v1()
        `, '42501');

        // Viewer has no jobs.write, so the listing toggle is denied at the
        // app layer before the procedure runs.
        await rejectCode(viewer(setJobPublicListing, {
            jobId: CJ_ID.JOB_LEGACY_B,
            listed: true,
            expectedVersion: '1',
            operationId: randomUUID(),
        }), 'FORBIDDEN');

        // The toggle is version-checked at the row level.
        const published = scalar(pg17, `
            select id::text from app.jobs
            where organization_id = '${ORG_B}'
                and publication_state = 'published' limit 1`);
        if (published) {
            const current = scalar(pg17, `
                select version::text from app.jobs where id = '${published}'`);
            await rejectCode(recruiter(setJobPublicListing, {
                jobId: published,
                listed: false,
                expectedVersion: String(Number(current) + 5),
                operationId: randomUUID(),
            }), '40001', 'a stale expected version fails closed');
        }
    });

    const lockClient = new pg.Client({
        host: '127.0.0.1',
        port: publishedPort(pg17, 5432),
        user: 'postgres',
        password: adminPassword,
        database: 'postgres',
        connectionTimeoutMillis: 5000,
    });
    await lockClient.connect();
    try {
        await lockClient.query('begin');
        await lockClient.query('lock table app.organizations in access exclusive mode');
        await t.test('organization lock waits are bounded', async () => {
            await rejectCode(recruiter(saveClient, {
                clientId: randomUUID(),
                expectedVersion: null,
                fields: CLIENT_FIELDS,
                operationId: randomUUID(),
            }), '55P03', 'a contended organization lock fails within lock_timeout');
        });
    } finally {
        await lockClient.query('rollback').catch(() => {});
        await lockClient.end();
    }

    await t.test('PostgreSQL 16 rejects the migration', () => {
        const stderr = psqlExpectError(pg16, readMigration(WORKFLOW_MIGRATION));
        assert.match(stderr, /PostgreSQL 17/);
    });

    await t.test('non-superuser operator applies the migration', () => {
        psql(pgOperator, `
            create role staff_operator nologin nosuperuser createrole bypassrls;
            grant create on database postgres to staff_operator with grant option;
        `);
        for (const fileName of PREFIX_MIGRATIONS) {
            psql(pgOperator, `set session authorization staff_operator;\n${readMigration(fileName)}`);
        }
        psql(pgOperator, `set session authorization staff_operator;\n${readMigration(WORKFLOW_MIGRATION)}`);
        psql(pgOperator, `set session authorization staff_operator;\n${readMigration(PIPELINE_MIGRATION)}`);
        psql(pgOperator, `set session authorization staff_operator;\n${readMigration(INTAKE_MIGRATION)}`);
        assert.equal(scalar(pgOperator, `
            select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            join pg_roles r on r.oid = p.proowner
            where n.nspname = 'app'
                and p.proname in ('${WORKFLOW_FUNCTIONS.join("','")}')
                and p.prosecdef and r.rolname = 'app_executor'`),
            String(WORKFLOW_FUNCTIONS.length));
        assert.equal(scalar(pgOperator, `
            select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            join pg_roles r on r.oid = p.proowner
            where n.nspname = 'app'
                and p.proname in ('${PIPELINE_FUNCTIONS.join("','")}')
                and p.prosecdef and r.rolname = 'app_executor'`),
            String(PIPELINE_FUNCTIONS.length));
        assert.equal(scalar(pgOperator, `
            select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            join pg_roles r on r.oid = p.proowner
            where n.nspname = 'app'
                and p.proname in ('${INTAKE_FUNCTIONS.join("','")}')
                and p.prosecdef and r.rolname = 'app_executor'`),
            String(INTAKE_FUNCTIONS.length));
        assert.equal(scalar(pgOperator, `
            select count(*) from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
            join pg_roles r on r.oid = c.relowner
            where n.nspname = 'app' and c.relkind = 'r'
                and c.relname in ('job_revisions', 'recruitment_operation_receipts')
                and r.rolname = 'app_owner'
                and c.relrowsecurity and c.relforcerowsecurity`), '2');
        assert.equal(scalar(pgOperator, `
            select pg_catalog.has_schema_privilege('app_executor', 'app', 'create')`), 'f');
    });
});
