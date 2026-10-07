import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import {
    POSTGRES_17_IMAGE,
    assertLocalTestEnvironment,
    findFreePort,
    psql,
    publishedPort,
    startPostgresContainer,
    stopAndRemoveContainer,
} from '../support/foundation-docker.js';
import {
    AUTHZ_ID,
    GOOGLE_MIGRATION,
    INVITES_MIGRATION,
    INVITE_DOMAINS_MIGRATION,
    installStaffFixture,
} from '../support/staff-authorization.js';
import { PRIVACY_MIGRATIONS } from '../support/privacy-foundation.js';
import { PRIVACY_OPS_MIGRATION } from '../support/privacy-operations.js';
import {
    CJ_ID,
    WORKFLOW_MIGRATION,
    clientJobFixtureSql,
} from '../support/client-job-workflows.js';
import {
    STAFF_MFA_COOKIE,
    createStaffMfaProof,
} from '../../src/lib/staff-mfa-cookie.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const nextBin = join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
const preload = join(root, 'tests', 'staff-workspace', 'google-token-preload.cjs');
const orgId = AUTHZ_ID.ORG_B;
const secret = 'synthetic-duplicate-review-secret';
const totpId = 'a5b1a111-0000-4000-8000-00000000d001';
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

async function waitForServer(url) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
        const response = await fetch(url, {
            signal: AbortSignal.timeout(5_000),
        }).catch(() => null);
        if (response?.ok) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('Temporary staff server did not start');
}

test('staff can reject a match or merge candidates through the review page', async (t) => {
    assertLocalTestEnvironment();
    const db = await startPostgresContainer('pgduplicates', POSTGRES_17_IMAGE, {
        publish: true,
    });
    t.after(() => stopAndRemoveContainer(db));
    for (const name of migrations) {
        psql(db, readFileSync(join(root, 'supabase', 'migrations', name), 'utf8'));
    }
    const runtimePassword = installStaffFixture(db);
    psql(db, clientJobFixtureSql);
    const candidateA = randomUUID();
    const candidateB = randomUUID();
    const candidateC = randomUUID();
    const candidateD = randomUUID();
    psql(db, `
        insert into app.role_permissions (organization_id, role_id, permission_key)
        values ('${orgId}', '${CJ_ID.ROLE_B_ADMIN}', 'duplicates.review'),
            ('${orgId}', '${CJ_ID.ROLE_B_ADMIN}', 'candidates.merge');
        insert into app.totp_credentials
            (id, organization_id, user_id, secret, status, verified_at)
        values ('${totpId}', '${orgId}', '${AUTHZ_ID.USER_ADMIN2}',
            'JBSWY3DPEHPK3PXP', 'active', now());
        insert into app.candidates
            (id, organization_id, full_name, identity_state, lifecycle)
        values
            ('${candidateA}', '${orgId}', 'Review Candidate One', 'provisional', 'active'),
            ('${candidateB}', '${orgId}', 'Review Candidate Two', 'provisional', 'active');
        insert into app.candidate_identifiers
            (id, organization_id, candidate_id, kind, raw_value,
                normalized_value, normalization_version, verification, received_at)
        values
            ('${randomUUID()}', '${orgId}', '${candidateA}', 'email',
                'review-match@example.test', 'review-match@example.test',
                1, 'unverified', now()),
            ('${randomUUID()}', '${orgId}', '${candidateB}', 'email',
                'review-match@example.test', 'review-match@example.test',
                1, 'unverified', now());
    `);

    const port = await findFreePort();
    const baseURL = `http://127.0.0.1:${port}`;
    const databaseUrl = `postgresql://agora_authz_test:${runtimePassword}@127.0.0.1:${publishedPort(db, 5432)}/postgres`;
    const output = [];
    const server = spawn(process.execPath,
        [nextBin, 'dev', '--webpack', '-p', String(port), '-H', '127.0.0.1'], {
            cwd: root,
            env: {
                PATH: process.env.PATH,
                HOME: process.env.HOME,
                NODE_ENV: 'development',
                NEXT_TELEMETRY_DISABLED: '1',
                NODE_OPTIONS: `--require ${preload}`,
                STAFF_DATABASE_URL: databaseUrl,
                STAFF_ORGANIZATION_ID: orgId,
                NEXTAUTH_URL: baseURL,
                NEXTAUTH_SECRET: secret,
                GOOGLE_CLIENT_ID: 'synthetic-workspace-client',
                GOOGLE_CLIENT_SECRET: 'synthetic-workspace-client-secret',
                NEXT_PUBLIC_SUPABASE_URL: '',
                SUPABASE_SERVICE_ROLE_KEY: '',
                GITHUB_ID: '',
                GITHUB_SECRET: '',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    server.stdout.on('data', (chunk) => output.push(String(chunk)));
    server.stderr.on('data', (chunk) => output.push(String(chunk)));
    t.after(async () => {
        server.kill('SIGTERM');
        await new Promise((resolve) => {
            const timer = setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 10_000);
            server.once('exit', () => { clearTimeout(timer); resolve(); });
        });
    });
    await waitForServer(`${baseURL}/dev/duplicate-review`);

    const token = await encode({
        token: {
            name: 'Admin Two', email: 'admin-two@synthetic.test',
            sub: '1002', provider: 'google', providerAccountId: '1002',
            googleRefreshToken: 'SYNTHETIC-WORKSPACE-TEST',
            emailVerified: true,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 3600,
        },
        secret,
    });
    const proof = createStaffMfaProof(secret, {
        subject: '1002', userId: AUTHZ_ID.USER_ADMIN2, credentialId: totpId,
    });
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const context = await browser.newContext();
    await context.addCookies([
        { name: 'next-auth.session-token', value: token, url: baseURL },
        { name: STAFF_MFA_COOKIE, value: proof, url: baseURL },
    ]);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    try {
        await page.goto(`${baseURL}/dev/duplicate-review`);
        await expect(page.getByRole('region', { name: 'Potential duplicates' }))
            .toContainText('Sam Lee / Samuel Lee');
        await expect(page.getByRole('region', { name: 'Candidate A profile' })).toHaveCount(0);
        await page.getByRole('button', { name: 'Alex Morgan / Alex Morgan' }).click();
        await page.getByRole('button', { name: 'Merge', exact: true }).click();
        await expect(page.getByRole('dialog', { name: 'Merge candidates' })
            .getByRole('combobox', { name: 'Primary email' })).toHaveCount(0);
        await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
        await page.getByRole('button', { name: 'Sam Lee / Samuel Lee' }).click();
        await page.getByRole('button', { name: 'Merge', exact: true }).click();
        await expect(page.getByRole('dialog', { name: 'Merge candidates' })
            .getByRole('combobox', { name: 'Primary email' })).toBeVisible();
        await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
        await expect(page.getByRole('region', { name: 'Match evidence' }))
            .toContainText('Identical CV file contents');
        await expect(page.getByRole('region', { name: 'Match evidence' }))
            .toContainText('Sam-Lee-Resume.pdf');
        await expect(page.getByRole('region', { name: 'Match evidence' }))
            .toContainText('Samuel-Profile.pdf');
        await expect(page.getByRole('region', { name: 'Candidate A profile' })
            .getByText('Identical CV content')).toBeVisible();
        await expect(page.getByRole('region', { name: 'Candidate B profile' })
            .getByText('Identical CV content')).toBeVisible();
        await page.getByText('Preview sample CV').click();
        await expect(page.getByText(/synthetic demo text/)).toBeVisible();
        await page.goto(`${baseURL}/staff/candidates`);
        await page.getByRole('link', { name: 'Review matches' }).click();
        await page.getByRole('heading', { name: 'Duplicate review' }).waitFor();
        await expect(page.getByRole('region', { name: 'Candidate A profile' })).toHaveCount(0);
        await page.getByRole('region', { name: 'Potential duplicates' })
            .getByRole('button').first().click();
        await page.getByRole('region', { name: 'Candidate A profile' }).waitFor();
        await page.getByRole('region', { name: 'Candidate B profile' }).waitFor();
        const profiles = await page.getByRole('region', { name: /Candidate [AB] profile/ })
            .allTextContents();
        assert.ok(profiles.join(' ').includes('Review Candidate One'));
        assert.ok(profiles.join(' ').includes('Review Candidate Two'));
        await expect(page.getByRole('region', { name: 'Match evidence' }))
            .toContainText('review-match@example.test');
        await expect(page.getByRole('region', { name: 'Match evidence' })
            .getByRole('button', { name: 'Not duplicate' })).toBeVisible();
        await expect(page.getByRole('region', { name: 'Candidate A profile' })
            .getByText('Shared email')).toBeVisible();
        await expect(page.getByRole('region', { name: 'Candidate B profile' })
            .getByText('Shared email')).toBeVisible();
        assert.ok([
            `/staff/candidates/${candidateA}`,
            `/staff/candidates/${candidateB}`,
        ].includes(await page.getByRole('region', { name: 'Candidate A profile' })
            .getByRole('link', { name: 'Full profile' }).getAttribute('href')));
        const [response] = await Promise.all([
            page.waitForResponse((entry) =>
                entry.url().includes('/api/staff/candidates/duplicates')
                && entry.request().method() === 'POST', { timeout: 15_000 }),
            page.getByRole('button', { name: 'Not duplicate' }).click(),
        ]);
        assert.equal(response.status(), 200);
        await expect(page.getByRole('region', { name: 'Candidate A profile' })).toHaveCount(0);
        await page.getByRole('link', { name: 'Different people' }).click();
        await page.getByRole('region', { name: 'Potential duplicates' })
            .getByRole('button').first().click();
        await page.getByRole('region', { name: 'Candidate A profile' }).waitFor();
        assert.equal(psql(db, `
            select count(*) from app.candidate_duplicate_review_events
            where organization_id = '${orgId}' and decision = 'different_people'`).trim(), '1');
        assert.equal(psql(db, `
            select count(*) from app.candidates
            where organization_id = '${orgId}'
                and id in ('${candidateA}', '${candidateB}')
                and lifecycle = 'active'`).trim(), '2');

        psql(db, `
            insert into app.candidates (id, organization_id, full_name,
                identity_state, lifecycle) values
                ('${candidateC}', '${orgId}', 'Merge Profile One', 'provisional', 'active'),
                ('${candidateD}', '${orgId}', 'Merge Profile Two', 'provisional', 'active');
            insert into app.candidate_identifiers (id, organization_id,
                candidate_id, kind, raw_value, normalized_value,
                normalization_version, verification, received_at) values
                ('${randomUUID()}', '${orgId}', '${candidateC}', 'email',
                    'merge@example.test', 'merge@example.test', 1, 'unverified', now()),
                ('${randomUUID()}', '${orgId}', '${candidateD}', 'email',
                    'merge@example.test', 'merge@example.test', 1, 'unverified', now());
            insert into app.applications (id, organization_id, candidate_id,
                job_id, pipeline_id, stage_id, public_reference,
                reference_version, received_at) values
                ('${randomUUID()}', '${orgId}', '${candidateC}',
                    '${CJ_ID.JOB_LEGACY_B}', '${CJ_ID.PIPELINE_B}',
                    '${CJ_ID.STAGE_B_1}', 'AG-CCCC00000001', 1, now()),
                ('${randomUUID()}', '${orgId}', '${candidateD}',
                    '${CJ_ID.JOB_LEGACY_B}', '${CJ_ID.PIPELINE_B}',
                    '${CJ_ID.STAGE_B_1}', 'AG-DDDD00000001', 1, now());
        `);
        await page.goto(`${baseURL}/staff/candidates/duplicates`);
        await page.getByRole('region', { name: 'Potential duplicates' })
            .getByRole('button').filter({ hasText: 'Merge Profile One' })
            .filter({ hasText: 'Merge Profile Two' }).click();
        await expect(page.getByRole('region', { name: 'Candidate A profile' })).toBeVisible();
        await page.getByRole('button', { name: 'Merge', exact: true }).click();
        await expect(page.getByRole('dialog', { name: 'Merge candidates' })).toBeVisible();
        await expect(page.getByRole('dialog').getByRole('combobox', { name: 'Primary email' }))
            .toHaveCount(0);
        await page.getByRole('radio', { name: /Merge Profile One/ }).check();
        const [mergeResponse] = await Promise.all([
            page.waitForResponse((entry) =>
                entry.url().endsWith('/api/staff/candidates/duplicates/merge')
                && entry.request().method() === 'POST', { timeout: 15_000 }),
            page.getByRole('dialog').getByRole('button', { name: 'Merge candidates' }).click(),
        ]);
        assert.equal(mergeResponse.status(), 200);
        assert.equal(JSON.parse(mergeResponse.request().postData()).primaryEmail,
            'merge@example.test');
        await expect(page.getByRole('status')).toContainText('Candidates merged');
        assert.equal(psql(db, `select count(*) from app.applications
            where candidate_id = '${candidateC}'`).trim(), '2');
        assert.equal(psql(db, `select merged_into_id from app.candidates
            where id = '${candidateD}'`).trim(), candidateC);
        await page.goto(`${baseURL}/staff/candidates/${candidateD}`);
        await page.waitForURL(`${baseURL}/staff/candidates/${candidateC}`);
        await expect(page.getByRole('heading', { name: 'Merge Profile One' })).toBeVisible();
    } catch (error) {
        throw new Error(`${error.message}\nServer output:\n${output.slice(-30).join('')}`);
    }
});
