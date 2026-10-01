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
    createStaffTask,
    getStaffWorkspace,
    getStaffCapabilities,
    listStaffTasks,
    setStaffTaskCompleted,
} from '../../src/lib/workspace-operations.js';
import {
    createJobDraft,
    listJobs,
    previewJobPublic,
    publishJobRevision,
    saveClient,
    setJobPublicListing,
} from '../../src/lib/client-job-operations.js';
import { listApplications } from '../../src/lib/pipeline-operations.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const migrationsDir = join(repoRoot, 'supabase', 'migrations');
const WORKSPACE_MIGRATION = '20260928100000_staff_workspace.sql';
const WORKSPACE_FUNCTIONS = [
    'get_staff_workspace_v1',
    'get_staff_capabilities_v1',
    'list_staff_tasks_v1',
    'create_staff_task_v1',
    'set_staff_task_completed_v1',
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
    WORKSPACE_MIGRATION,
    '20260928220000_job_visibility.sql',
    '20261002110000_staff_shell_capabilities.sql',
];

const readMigration = (name) => readFileSync(join(migrationsDir, name), 'utf8');
const identity = (subject) => ({
    provider: 'google',
    issuer: 'https://accounts.google.com',
    subject,
});
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

const workspaceFixtureSql = `
insert into app.role_permissions (organization_id, role_id, permission_key) values
    ('${ORG_B}', '${CJ_ID.ROLE_B_RECRUITER}', 'collaboration.read'),
    ('${ORG_B}', '${CJ_ID.ROLE_B_RECRUITER}', 'collaboration.write'),
    ('${ORG_A}', '${AUTHZ_ID.ROLE_A_ADMIN}', 'collaboration.read'),
    ('${ORG_A}', '${AUTHZ_ID.ROLE_A_ADMIN}', 'collaboration.write')
on conflict do nothing;
`;

const seedCandidates = (count) => {
    const rows = [];
    for (let index = 0; index < count; index += 1) {
        const candidateId = randomUUID();
        const applicationId = randomUUID();
        rows.push(`
insert into app.candidates (id, organization_id, full_name, identity_state, lifecycle)
    values ('${candidateId}', '${ORG_B}', 'Synthetic Scale ${index}',
        'established', 'active');
insert into app.applications (id, organization_id, candidate_id, job_id, pipeline_id,
        stage_id, public_reference, reference_version, received_at)
    values ('${applicationId}', '${ORG_B}', '${candidateId}',
        '${CJ_ID.JOB_LEGACY_B}', '${CJ_ID.PIPELINE_B}', '${CJ_ID.STAGE_B_1}',
        'AG-${index.toString(16).toUpperCase().padStart(12, '0')}', 1, now());
`);
    }
    return rows.join('\n');
};

test('staff workspace on PostgreSQL 17', async (t) => {
    assertLocalTestEnvironment();
    const adminPassword = randomUUID();
    const pg17 = await startPostgresContainer('pgworkspace', POSTGRES_17_IMAGE, {
        publish: true,
        password: adminPassword,
    });
    let pool;
    t.after(async () => {
        await pool?.end().catch(() => {});
        await stopAndRemoveContainer(pg17);
    });
    const pgOperator = await startPostgresContainer('pgworkspaceop', POSTGRES_17_IMAGE);
    t.after(() => stopAndRemoveContainer(pgOperator));

    for (const fileName of MIGRATIONS) {
        psql(pg17, readMigration(fileName));
    }
    const runtimePassword = installStaffFixture(pg17);
    psql(pg17, clientJobFixtureSql);
    psql(pg17, workspaceFixtureSql);

    pool = new pg.Pool(staffPoolOptions(pg17, runtimePassword, 4));

    const admin = (fn, input) => fn(pool, identity(CJ_SUBJECTS.ADMIN), ORG_B, input);
    const recruiter = (fn, input) => fn(pool, identity(CJ_SUBJECTS.RECRUITER), ORG_B, input);
    const viewer = (fn, input) => fn(pool, identity(CJ_SUBJECTS.VIEWER), ORG_B, input);
    const orgA = (fn, input) => fn(pool, identity('1001'), ORG_A, input);

    await t.test('lightweight capabilities match authorized summary and reject missing context', async () => {
        for (const run of [admin, viewer]) {
            const summary = await run(getStaffWorkspace);
            assert.deepEqual(await run(getStaffCapabilities), summary.capabilities);
        }
        staffBad(pg17, '', ORG_B, 'select app.get_staff_capabilities_v1()', '42501');
        staffBad(pg17, CJ_ID.USER_B_REC, '', 'select app.get_staff_capabilities_v1()', '42501');
    });

    await t.test('workspace summary reports exact fixture baseline', async () => {
        const summary = await admin(getStaffWorkspace);
        t.diagnostic(`baseline summary: ${JSON.stringify(summary)}`);
        assert.deepEqual(summary.capabilities, {
            candidates: true,
            applications: true,
            clients: true,
            jobs: true,
            members: true,
            tasks: true,
            writeTasks: true,
            writeClients: true,
            writeJobs: true,
        });
        assert.deepEqual(summary.metrics, {
            candidates: 1,
            applications: 1,
            openRoles: 0,
        });
        assert.deepEqual(summary.attention, {
            reviewApplications: 1,
            pendingInvites: 0,
            openTasks: 0,
        });
        assert.deepEqual(summary.clientsHiring, []);
        assert.equal(summary.clientsHiringTotal, 0);
        assert.equal(summary.recentApplications.length, 1);
        const recent = summary.recentApplications[0];
        assert.equal(recent.applicationId, CJ_ID.APPLICATION_B);
        assert.equal(recent.candidateId, CJ_ID.CANDIDATE_B);
        assert.equal(recent.candidateName, 'Synthetic Candidate B');
        assert.equal(recent.jobId, CJ_ID.JOB_LEGACY_B);
        assert.equal(recent.jobTitle, 'Legacy Synthetic Job');
        assert.equal(recent.clientId, CJ_ID.CLIENT_LEGACY_B);
        assert.equal(recent.clientName, 'Synthetic Legacy Client');
    });

    await t.test('open roles and hiring clients follow the agreed recipe', async () => {
        const recipeFields = (title) => ({
            title,
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
                    content: [{ type: 'text', text: `${title} description` }],
                }],
            },
        });
        const publishRecipeJob = async (clientId, title) => {
            const draft = await admin(createJobDraft, {
                jobId: randomUUID(),
                revisionId: randomUUID(),
                clientId,
                fields: recipeFields(title),
                operationId: randomUUID(),
            });
            const preview = await admin(previewJobPublic, {
                revisionId: draft.revisionId,
            });
            const published = await admin(publishJobRevision, {
                revisionId: draft.revisionId,
                expectedVersion: '1',
                expectedClientVersion: preview.clientVersion,
                reviewHash: preview.reviewHash,
                operationId: randomUUID(),
            });
            assert.equal(published.status, 'published');
            return draft.jobId;
        };

        const secondClient = await admin(saveClient, {
            clientId: randomUUID(),
            expectedVersion: null,
            fields: {
                name: 'Synthetic Second Client',
                contactName: 'Riley Example',
                contactEmail: 'riley@second-client.example',
                telegramUsername: null,
                website: null,
                socialLinks: [],
                isStealth: false,
                anonymousDescription: null,
            },
            operationId: randomUUID(),
        });
        await admin(saveClient, {
            clientId: CJ_ID.CLIENT_LEGACY_B,
            expectedVersion: '1',
            fields: {
                name: 'Synthetic Legacy Client',
                contactName: 'Legacy Contact',
                contactEmail: 'contact@legacy-client.example',
                telegramUsername: null,
                website: null,
                socialLinks: [],
                isStealth: false,
                anonymousDescription: null,
            },
            operationId: randomUUID(),
        });
        await publishRecipeJob(CJ_ID.CLIENT_LEGACY_B, 'Recipe Open Role One');
        const hiddenJob = await publishRecipeJob(
            CJ_ID.CLIENT_LEGACY_B, 'Recipe Open Role Two');
        await admin(setJobPublicListing, {
            jobId: hiddenJob,
            listed: false,
            expectedVersion: '2',
            operationId: randomUUID(),
        });
        assert.equal(scalar(pg17, `
            select publicly_listed from app.jobs where id = '${hiddenJob}'`), 'f');
        const closedJob = await publishRecipeJob(secondClient.id, 'Recipe Closed Role');
        psql(pg17, `
            update app.jobs set application_state = 'closed'
            where id = '${closedJob}'`);

        const summary = await admin(getStaffWorkspace);
        t.diagnostic(`recipe summary: ${JSON.stringify(summary)}`);
        assert.deepEqual(summary.metrics, {
            candidates: 1,
            applications: 1,
            openRoles: 2,
        });
        assert.equal(summary.attention.reviewApplications, 1);
        assert.equal(summary.clientsHiringTotal, 1);
        assert.equal(summary.clientsHiring.length, 1);
        const hiring = summary.clientsHiring[0];
        assert.equal(hiring.clientId, CJ_ID.CLIENT_LEGACY_B);
        assert.equal(hiring.name, 'Synthetic Legacy Client');
        assert.equal(hiring.openRoles, 2);
        assert.equal(hiring.applications, 1);
        assert.equal(summary.recentApplications.length, 1);
    });

    await t.test('summary counts aggregate beyond list caps', async () => {
        psql(pg17, seedCandidates(501));
        psql(pg17, `
            vacuum analyze app.candidates;
            vacuum analyze app.applications;
            vacuum analyze app.jobs;
            vacuum analyze app.clients;
            vacuum analyze app.pipeline_stages;`);
        const summary = await admin(getStaffWorkspace);
        t.diagnostic(`scaled summary: ${JSON.stringify(summary)}`);
        assert.equal(summary.metrics.candidates, 502);
        assert.equal(summary.metrics.applications, 502);
        assert.equal(summary.attention.reviewApplications, 502);
        assert.equal(summary.recentApplications.length, 5,
            'recent applications stay capped while counts aggregate');

        psql(pg17, `
            update app.candidates set lifecycle = 'restricted'
            where id = '${CJ_ID.CANDIDATE_B}'`);
        const restricted = await admin(getStaffWorkspace);
        assert.equal(restricted.metrics.candidates, 501);
        assert.equal(restricted.metrics.applications, 501);
        assert.equal(restricted.attention.reviewApplications, 501);
        psql(pg17, `
            update app.candidates set lifecycle = 'active'
            where id = '${CJ_ID.CANDIDATE_B}'`);
    });

    await t.test('permissionless member sees gated nulls, never zeros', async () => {
        const summary = await viewer(getStaffWorkspace);
        t.diagnostic(`viewer summary: ${JSON.stringify(summary)}`);
        assert.deepEqual(summary.capabilities, {
            candidates: false,
            applications: false,
            clients: false,
            jobs: false,
            members: false,
            tasks: false,
            writeTasks: false,
            writeClients: false,
            writeJobs: false,
        });
        assert.deepEqual(summary.metrics, {
            candidates: null,
            applications: null,
            openRoles: null,
        });
        assert.deepEqual(summary.attention, {
            reviewApplications: null,
            pendingInvites: null,
            openTasks: null,
        });
        assert.deepEqual(summary.clientsHiring, []);
        assert.equal(summary.clientsHiringTotal, null);
        assert.deepEqual(summary.recentApplications, []);
    });

    await t.test('tasks create, complete, reopen and conflict', async () => {
        const titles = {
            review: 'Review the synthetic shortlist',
            interviews: 'Schedule the synthetic panel',
            notes: 'Write up synthetic notes',
        };
        const created = {};
        for (const [category, title] of Object.entries(titles)) {
            const taskId = randomUUID();
            const result = await admin(createStaffTask, { taskId, title, category });
            assert.equal(result.id, taskId);
            assert.equal(result.version, '1');
            created[category] = taskId;
        }

        const listed = await admin(listStaffTasks, {});
        assert.equal(listed.total, 3);
        assert.deepEqual(listed.counts, {
            open: 3, completed: 0, all: 3, review: 1, interviews: 1, notes: 1,
        });
        assert.deepEqual(
            [...listed.tasks.map((task) => task.title)].sort(),
            [...Object.values(titles)].sort(),
        );
        assert.ok(listed.tasks.every((task) => task.completedAt === null));

        const replay = await admin(createStaffTask, {
            taskId: created.review,
            title: ` ${titles.review} `,
            category: 'review',
        });
        assert.equal(replay.version, '1', 'same task id replays without a duplicate');
        assert.equal(
            (await admin(listStaffTasks, {})).total, 3,
            'replayed create does not duplicate the task',
        );
        await rejectCode(admin(createStaffTask, {
            taskId: created.review,
            title: 'A different title for the same id',
            category: 'review',
        }), '23505', 'reused task id with different content is rejected');

        const completedResult = await admin(setStaffTaskCompleted, {
            taskId: created.review,
            completed: true,
            expectedVersion: '1',
        });
        assert.equal(completedResult.version, '2');
        const openAfter = await admin(listStaffTasks, {});
        assert.equal(openAfter.counts.open, 2);
        assert.equal(openAfter.counts.completed, 1);
        const completedList = await admin(listStaffTasks, { completed: true });
        assert.equal(completedList.total, 1);
        assert.equal(completedList.tasks[0].id, created.review);
        assert.equal(completedList.tasks[0].version, '2');
        assert.ok(completedList.tasks[0].completedAt);

        await rejectCode(admin(setStaffTaskCompleted, {
            taskId: created.interviews,
            completed: true,
            expectedVersion: '99',
        }), '40001', 'stale expected version is rejected');

        const reopened = await admin(setStaffTaskCompleted, {
            taskId: created.review,
            completed: false,
            expectedVersion: '2',
        });
        assert.equal(reopened.version, '3');
        const openAgain = await admin(listStaffTasks, {});
        assert.equal(openAgain.counts.open, 3);

        const filtered = await admin(listStaffTasks, { category: 'interviews' });
        assert.equal(filtered.total, 1);
        assert.equal(filtered.tasks[0].category, 'interviews');

        const summary = await admin(getStaffWorkspace);
        assert.equal(summary.attention.openTasks, 3);
    });

    await t.test('other members and other organizations cannot touch tasks', async () => {
        const taskId = randomUUID();
        await admin(createStaffTask, {
            taskId,
            title: 'Admin-only synthetic task',
            category: 'notes',
        });

        const recruiterList = await recruiter(listStaffTasks, {});
        assert.equal(
            recruiterList.tasks.some((task) => task.id === taskId),
            false,
            'another member never sees this member\'s task',
        );
        await rejectCode(recruiter(setStaffTaskCompleted, {
            taskId,
            completed: true,
            expectedVersion: '1',
        }), 'P0002', 'another member cannot complete the task');
        await rejectCode(orgA(setStaffTaskCompleted, {
            taskId,
            completed: true,
            expectedVersion: '1',
        }), 'P0002', 'another organization cannot complete the task');
        const orgAList = await orgA(listStaffTasks, {});
        assert.equal(
            orgAList.tasks.some((task) => task.id === taskId),
            false,
            'other organizations never see the task',
        );

        await rejectCode(viewer(listStaffTasks, {}), 'FORBIDDEN',
            'a member without collaboration.read cannot list tasks');
        await rejectCode(viewer(createStaffTask, {
            taskId: randomUUID(),
            title: 'Viewer task',
            category: 'notes',
        }), 'FORBIDDEN');

        staffBad(pg17, CJ_ID.USER_B_REC, ORG_B, `
            select app.set_staff_task_completed_v1('${taskId}'::uuid, true, 1,
                '${randomUUID()}'::uuid, '${randomUUID()}'::uuid)`, 'P0002',
        );
    });

    await t.test('runtime roles and raw table access stay locked down', async () => {
        for (const role of ['app_intake', 'app_worker']) {
            for (const fn of [
                'app.get_staff_workspace_v1()',
                'app.get_staff_capabilities_v1()',
                'app.list_staff_tasks_v1(false, null, 20, 0)',
                `app.create_staff_task_v1('${randomUUID()}'::uuid, 'x', 'review',
                    '${randomUUID()}'::uuid, '${randomUUID()}'::uuid)`,
                `app.set_staff_task_completed_v1('${randomUUID()}'::uuid, true, 1,
                    '${randomUUID()}'::uuid, '${randomUUID()}'::uuid)`,
            ]) {
                assertSqlstate(pg17, `set role ${role}; select ${fn};`, '42501');
            }
        }
        assertSqlstate(pg17,
            'set role app_staff; select count(*) from app.staff_tasks;', '42501');
        assertSqlstate(pg17,
            `set role app_staff; insert into app.staff_tasks
                (id, organization_id, owner_membership_id, title, category)
                values ('${randomUUID()}', '${ORG_B}', '${AUTHZ_ID.MEMBER_B_ADMIN}',
                    'raw', 'review');`, '42501');
        staffBad(pg17, '', ORG_B,
            'select app.list_staff_tasks_v1(false, null, 20, 0)', '42501');
        staffBad(pg17, CJ_ID.USER_B_REC, '',
            'select app.list_staff_tasks_v1(false, null, 20, 0)', '42501');
    });

    await t.test('task audit events carry versions only, never titles', async () => {
        const taskId = randomUUID();
        await admin(createStaffTask, {
            taskId,
            title: 'Synthetic audit probe title',
            category: 'review',
        });
        await admin(setStaffTaskCompleted, {
            taskId, completed: true, expectedVersion: '1',
        });
        await admin(setStaffTaskCompleted, {
            taskId, completed: false, expectedVersion: '2',
        });
        const rows = JSON.parse(scalar(pg17, `
            select jsonb_agg(row_to_json(e) order by e.occurred_at)::text
            from app.audit_events e
            where e.target_type = 'staff_task' and e.target_id = '${taskId}'`));
        assert.equal(rows.length, 3);
        assert.deepEqual(
            rows.map((row) => row.action),
            ['staff.task.created', 'staff.task.completed', 'staff.task.reopened'],
        );
        for (const row of rows) {
            assert.equal(row.actor_kind, 'staff');
            const keys = Object.keys(row.details).sort();
            assert.ok(
                keys.every((key) => ['new_version', 'previous_version'].includes(key)),
                `unexpected audit detail keys: ${keys.join(',')}`,
            );
            assert.ok(
                !JSON.stringify(row).includes('Synthetic audit probe title'),
                'audit rows must never contain task titles',
            );
        }
    });

    await t.test('application DTO reports stageIsInitial per stage', async () => {
        const byReference = { query: 'AG-AAAA00000001' };
        const before = await admin(listApplications, byReference);
        const initialRow = before.applications.find(
            (row) => row.applicationId === CJ_ID.APPLICATION_B);
        assert.equal(initialRow?.stageIsInitial, true,
            'initial pipeline stage reports stageIsInitial');

        psql(pg17, `
            update app.applications set stage_id = '${CJ_ID.STAGE_B_2}'
            where id = '${CJ_ID.APPLICATION_B}'`);
        const after = await admin(listApplications, byReference);
        const movedRow = after.applications.find(
            (row) => row.applicationId === CJ_ID.APPLICATION_B);
        assert.equal(movedRow?.stageIsInitial, false,
            'non-initial pipeline stage clears stageIsInitial');

        psql(pg17, `
            update app.applications set stage_id = '${CJ_ID.STAGE_B_1}'
            where id = '${CJ_ID.APPLICATION_B}'`);
    });

    await t.test('migration shape: ownership, forced RLS and grants', () => {
        assert.equal(scalar(pg17, `
            select count(*) from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
            join pg_roles r on r.oid = c.relowner
            where n.nspname = 'app' and c.relname = 'staff_tasks' and c.relkind = 'r'
                and r.rolname = 'app_owner'
                and c.relrowsecurity and c.relforcerowsecurity`), '1');
        assert.equal(scalar(pg17, `
            select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            join pg_roles r on r.oid = p.proowner
            where n.nspname = 'app'
                and p.proname in ('${WORKSPACE_FUNCTIONS.join("','")}')
                and p.prosecdef and r.rolname = 'app_executor'
                and coalesce(p.proconfig::text, '')
                    like '%search_path=pg_catalog, app, pg_temp%'`),
            String(WORKSPACE_FUNCTIONS.length));
        assert.equal(scalar(pg17, `
            select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            cross join lateral aclexplode(p.proacl) acl
            where n.nspname = 'app'
                and p.proname in ('${WORKSPACE_FUNCTIONS.join("','")}')
                and acl.grantee <> p.proowner
                and acl.grantee <> 'app_staff'::regrole`), '0');
        assert.equal(scalar(pg17, `
            select count(*) from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
            cross join lateral aclexplode(c.relacl) acl
            where n.nspname = 'app' and c.relname = 'staff_tasks'
                and acl.grantee <> c.relowner
                and acl.grantee <> 'app_executor'::regrole`), '0');
        assert.equal(scalar(pg17, `
            select pg_catalog.has_schema_privilege('app_executor', 'app', 'create')`), 'f');
        assert.equal(scalar(pg17, `
            select count(*) from pg_constraint con
            join pg_class c on c.oid = con.conrelid
            join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'app' and c.relname = 'audit_events'
                and con.conname = 'audit_events_action_check'
                and pg_get_constraintdef(con.oid) like '%staff.task.created%'
                and pg_get_constraintdef(con.oid) like '%staff.task.completed%'
                and pg_get_constraintdef(con.oid) like '%staff.task.reopened%'`), '1');
    });

    await t.test('non-superuser operator applies the migration', () => {
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
                and p.proname in ('${WORKSPACE_FUNCTIONS.join("','")}')
                and p.prosecdef and r.rolname = 'app_executor'`),
            String(WORKSPACE_FUNCTIONS.length));
        assert.equal(scalar(pgOperator, `
            select count(*) from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
            join pg_roles r on r.oid = c.relowner
            where n.nspname = 'app' and c.relname = 'staff_tasks' and c.relkind = 'r'
                and r.rolname = 'app_owner'
                and c.relrowsecurity and c.relforcerowsecurity`), '1');
        assert.equal(scalar(pgOperator, `
            select pg_catalog.has_schema_privilege('app_executor', 'app', 'create')`), 'f');
    });

    await t.test('create_job_draft_v2 stores listing choice and replays safely', async () => {
        const readyFields = (title) => ({
            title,
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
                    content: [{ type: 'text', text: `${title} description` }],
                }],
            },
        });
        const publicTitles = () => JSON.parse(
            psql(pg17, `
                set role app_intake;
                select pg_catalog.set_config('app.organization_id', '${ORG_B}', false);
                select app.list_public_jobs_v1()::text`).trim().split('\n').pop(),
        ).jobs.map((job) => job.title);
        const publish = async (revisionId) => {
            const preview = await admin(previewJobPublic, { revisionId });
            const result = await admin(publishJobRevision, {
                revisionId,
                expectedVersion: '1',
                expectedClientVersion: preview.clientVersion,
                reviewHash: preview.reviewHash,
                operationId: randomUUID(),
            });
            assert.equal(result.status, 'published');
        };

        const unlisted = await admin(createJobDraft, {
            jobId: randomUUID(),
            revisionId: randomUUID(),
            clientId: CJ_ID.CLIENT_LEGACY_B,
            fields: readyFields('V2 Unlisted Draft'),
            publiclyListed: false,
            operationId: randomUUID(),
        });
        const listed = await admin(createJobDraft, {
            jobId: randomUUID(),
            revisionId: randomUUID(),
            clientId: CJ_ID.CLIENT_LEGACY_B,
            fields: readyFields('V2 Listed Draft'),
            publiclyListed: true,
            operationId: randomUUID(),
        });
        assert.equal(scalar(pg17, `
            select publicly_listed from app.jobs where id = '${unlisted.jobId}'`), 'f');
        assert.equal(scalar(pg17, `
            select publicly_listed from app.jobs where id = '${listed.jobId}'`), 't');
        assert.deepEqual(
            publicTitles().filter(
                (title) => title === 'V2 Unlisted Draft' || title === 'V2 Listed Draft'),
            [],
            'drafts never appear on the public board regardless of the flag',
        );

        await publish(unlisted.revisionId);
        assert.equal(scalar(pg17, `
            select publicly_listed from app.jobs where id = '${unlisted.jobId}'`), 'f',
            'publishing must not flip the stored listing flag');
        assert.equal(scalar(pg17, `
            select version from app.jobs where id = '${unlisted.jobId}'`), '2',
            'publishing bumps the version as usual');
        assert.ok(!publicTitles().includes('V2 Unlisted Draft'),
            'a published unlisted job stays off the public board');

        await publish(listed.revisionId);
        assert.ok(publicTitles().includes('V2 Listed Draft'),
            'a published listed job appears on the public board');
        const boardRows = JSON.parse(
            psql(pg17, `
                set role app_intake;
                select pg_catalog.set_config('app.organization_id', '${ORG_B}', false);
                select app.list_public_jobs_v1()::text`).trim().split('\n').pop(),
        ).jobs;
        const boardRow = boardRows.find((job) => job.title === 'V2 Listed Draft');
        assert.ok(boardRow?.publishedAt, 'the public DTO carries the real publish time');

        const workspaceRows = await admin(listJobs, {});
        const boardFlag = (jobId) => workspaceRows.find(
            (job) => job.id === jobId)?.publiclyListed;
        assert.equal(boardFlag(unlisted.jobId), false);
        assert.equal(boardFlag(listed.jobId), true);

        await admin(setJobPublicListing, {
            jobId: unlisted.jobId,
            listed: true,
            expectedVersion: '2',
            operationId: randomUUID(),
        });
        assert.ok(publicTitles().includes('V2 Unlisted Draft'),
            'an unlisted published job can be listed through the existing procedure');

        const replayInput = {
            jobId: randomUUID(),
            revisionId: randomUUID(),
            clientId: CJ_ID.CLIENT_LEGACY_B,
            fields: readyFields('V2 Replay Draft'),
            publiclyListed: true,
            operationId: randomUUID(),
        };
        const first = await admin(createJobDraft, replayInput);
        const replay = await admin(createJobDraft, replayInput);
        assert.equal(replay.replayed, true);
        assert.equal(replay.jobId, first.jobId,
            'replaying the same operation with the same flag returns the same job');
        await rejectCode(admin(createJobDraft, {
            ...replayInput,
            publiclyListed: false,
        }), '23505', 'the same operation id with a changed flag is rejected');

        await assert.rejects(
            admin(createJobDraft, {
                jobId: randomUUID(),
                revisionId: randomUUID(),
                clientId: CJ_ID.CLIENT_LEGACY_B,
                fields: readyFields('V2 Malformed Draft'),
                publiclyListed: 'yes',
                operationId: randomUUID(),
            }),
            (error) => error.code === 'INVALID_INPUT',
            'a non-boolean flag is rejected by the wrapper before any query',
        );
        staffBad(pg17, AUTHZ_ID.USER_ADMIN2, ORG_B, `
            select app.create_job_draft_v2('${randomUUID()}'::uuid,
                '${randomUUID()}'::uuid, '${CJ_ID.CLIENT_LEGACY_B}'::uuid,
                '${JSON.stringify(readyFields('V2 Null Draft'))}'::jsonb,
                null, '${randomUUID()}'::uuid, '${randomUUID()}'::uuid)`,
            '22023');

        await rejectCode(orgA(createJobDraft, {
            jobId: randomUUID(),
            revisionId: randomUUID(),
            clientId: CJ_ID.CLIENT_LEGACY_B,
            fields: readyFields('V2 Cross Org Draft'),
            publiclyListed: true,
            operationId: randomUUID(),
        }), 'P0002', 'an org A actor cannot draft against an org B client');
        for (const role of ['app_intake', 'app_worker']) {
            assertSqlstate(pg17, `
                set role ${role};
                select app.create_job_draft_v2('${randomUUID()}'::uuid,
                    '${randomUUID()}'::uuid, '${CJ_ID.CLIENT_LEGACY_B}'::uuid,
                    '{}'::jsonb, true, '${randomUUID()}'::uuid,
                    '${randomUUID()}'::uuid)`, '42501',
            );
        }
        assert.equal(scalar(pg17, `
            select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            join pg_roles r on r.oid = p.proowner
            where n.nspname = 'app' and p.proname = 'create_job_draft_v2'
                and p.prosecdef and r.rolname = 'app_executor'
                and coalesce(p.proconfig::text, '')
                    like '%search_path=pg_catalog, app, pg_temp%'`), '1');
        assert.equal(scalar(pg17, `
            select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            cross join lateral aclexplode(p.proacl) acl
            where n.nspname = 'app' and p.proname = 'create_job_draft_v2'
                and acl.grantee <> p.proowner
                and acl.grantee <> 'app_staff'::regrole`), '0');
        assert.equal(scalar(pgOperator, `
            select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            join pg_roles r on r.oid = p.proowner
            where n.nspname = 'app' and p.proname = 'create_job_draft_v2'
                and p.prosecdef and r.rolname = 'app_executor'`), '1',
            'the operator-applied migration owns the function correctly');
        assert.equal(scalar(pgOperator, `
            select pg_catalog.has_schema_privilege('app_executor', 'app', 'create')`), 'f');
    });
});
