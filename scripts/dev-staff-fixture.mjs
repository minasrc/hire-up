import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { encode } from 'next-auth/jwt';

import {
    POSTGRES_17_IMAGE, assertLocalTestEnvironment, findFreePort, psql,
    publishedPort, startPostgresContainer, stopAndRemoveContainer,
} from '../tests/support/foundation-docker.js';
import {
    AUTHZ_ID, GOOGLE_MIGRATION, INVITES_MIGRATION, INVITE_DOMAINS_MIGRATION,
    installStaffFixture,
} from '../tests/support/staff-authorization.js';
import { PRIVACY_MIGRATIONS } from '../tests/support/privacy-foundation.js';
import { PRIVACY_OPS_MIGRATION } from '../tests/support/privacy-operations.js';
import {
    CJ_ID, WORKFLOW_MIGRATION, clientJobFixtureSql,
} from '../tests/support/client-job-workflows.js';
import { createSyntheticDocx, createSyntheticPdf } from '../tests/support/cv-fixtures.js';
import { STAFF_MFA_COOKIE, createStaffMfaProof } from '../src/lib/staff-mfa-cookie.js';

import { verifyProxyModel, providerBaseUrl, providerTokenFile } from './telegram-proxy.mjs';
import { seedTelegramDemo } from './telegram-demo-fixture.mjs';

const telegramAI = process.env.STAFF_TELEGRAM_AI === '1';
const telegramDemo = process.env.STAFF_TELEGRAM_FIXTURE === '1';
const root = fileURLToPath(new URL('../', import.meta.url));
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
    '20261002100000_candidate_upload.sql',
    '20261002110000_staff_shell_capabilities.sql',
    '20261002120000_staff_list_pagination.sql',
];

const listen = (server, port = 0) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve(server.address().port);
    });
});

async function waitForServer(url) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
        const response = await fetch(url).catch(() => null);
        if (response?.ok) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('Local staff server did not start');
}

async function main() {
    assertLocalTestEnvironment();
    if (telegramAI) await verifyProxyModel();
    const db = await startPostgresContainer('staffpreview', POSTGRES_17_IMAGE, {
        publish: true,
    });
    let next;
    let storage;
    let entry;
    let extraction;
    let extractionDirectory;
    let sampleImportTimer;
    const cleanup = () => {
        next?.kill('SIGTERM');
        extraction?.kill('SIGTERM');
        clearInterval(sampleImportTimer);
        if (extractionDirectory) rmSync(extractionDirectory, { recursive: true, force: true });
        storage?.closeAllConnections();
        storage?.close();
        entry?.closeAllConnections();
        entry?.close();
        stopAndRemoveContainer(db);
    };
    try {
        const selectedMigrations = telegramDemo ? readdirSync(join(root, 'supabase/migrations')).filter(name => name >= '20260922090000_foundation_roles.sql' && name.endsWith('.sql')).sort() : migrations;
        for (const name of selectedMigrations) {
            psql(db, readFileSync(join(root, 'supabase', 'migrations', name), 'utf8'));
        }
        const password = installStaffFixture(db);
        psql(db, clientJobFixtureSql);
        const demo = telegramDemo ? await seedTelegramDemo(db, password, { liveExtraction: telegramAI }) : null;
        if (telegramAI) {
            psql(db, 'grant app_telegram_worker to agora_authz_test;');
            // In this demo, sample messages are already imported. Complete only
            // their synthetic history jobs; candidate extraction uses the real API.
            sampleImportTimer = setInterval(() => {
                psql(db, `update app.telegram_history_jobs set status='completed' where kind='history' and status='queued';
                    update app.telegram_history_chats set history_completed=true,next_sync_at=now()+interval '1 hour' where selected and not history_completed;`);
            }, 2000);
        }
        const jobDocument = JSON.stringify({ type: 'doc', content: [
            { type: 'heading', attrs: { level: 2 }, content: [
                { type: 'text', text: 'The role' },
            ] },
            { type: 'paragraph', content: [
                { type: 'text', text: 'Build reliable services for a growing recruiting platform.' },
            ] },
            { type: 'paragraph', content: [
                { type: 'text', text: 'Work with product and engineering to improve candidate workflows.' },
            ] },
        ] });
        psql(db, `insert into app.job_revisions
            (id, organization_id, job_id, revision_number, title,
                employment_type, workplace_mode, locations,
                description_document, description_text, status)
            values ('${randomUUID()}', '${AUTHZ_ID.ORG_B}', '${CJ_ID.JOB_LEGACY_B}',
                1, 'Legacy Synthetic Job', 'full_time', 'hybrid', array['Berlin'],
                '${jobDocument}'::jsonb,
                app.job_document_text_v1('${jobDocument}'::jsonb), 'draft');`);
        const secret = randomUUID();
        const credentialId = randomUUID();
        psql(db, `insert into app.totp_credentials
            (id, organization_id, user_id, secret, status, verified_at)
            values ('${credentialId}', '${AUTHZ_ID.ORG_B}', '${AUTHZ_ID.USER_ADMIN2}',
                'JBSWY3DPEHPK3PXP', 'active', now());`);

        const files = new Map();
        for (const [filename, mimeType, extension, bytes] of [
            ['Sample-CV.docx',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'docx', createSyntheticDocx()],
            ['Sample-CV.pdf', 'application/pdf', 'pdf', createSyntheticPdf()],
        ]) {
            const blobId = randomUUID();
            const documentId = randomUUID();
            const key = `preview/${blobId}.${extension}`;
            const hash = createHash('sha256').update(bytes).digest('hex');
            files.set(key, { bytes, mimeType });
            psql(db, `insert into app.file_blobs
                (id, organization_id, candidate_id, sha256, size_bytes,
                    mime_type, extension, lifecycle, scan_state, scan_engine,
                    scan_definitions, scanned_at, scan_valid_until)
                values ('${blobId}', '${AUTHZ_ID.ORG_B}', '${CJ_ID.CANDIDATE_B}',
                    decode('${hash}', 'hex'), ${bytes.length}, '${mimeType}',
                    '${extension}', 'live', 'clean', 'local-fixture', 'synthetic',
                    now(), now() + interval '1 year');
                insert into app.blob_locations
                    (id, organization_id, blob_id, backend_key, bucket, object_key,
                        state, is_primary, verified_sha256, verified_size_bytes, verified_at)
                values ('${randomUUID()}', '${AUTHZ_ID.ORG_B}', '${blobId}',
                    'supabase_storage', 'cv-submissions', '${key}', 'available', true,
                    decode('${hash}', 'hex'), ${bytes.length}, now());
                insert into app.documents
                    (id, organization_id, candidate_id, blob_id, purpose,
                        original_filename, received_at, lifecycle)
                values ('${documentId}', '${AUTHZ_ID.ORG_B}',
                    '${CJ_ID.CANDIDATE_B}', '${blobId}', 'cv', '${filename}',
                    now(), 'active');
                insert into app.application_documents
                    (organization_id, candidate_id, application_id, document_id,
                        submitted_filename, attached_at)
                values ('${AUTHZ_ID.ORG_B}', '${CJ_ID.CANDIDATE_B}',
                    '${CJ_ID.APPLICATION_B}', '${documentId}', '${filename}', now());
                ${extension === 'docx' ? `update app.candidates
                    set current_document_id = '${documentId}'
                    where organization_id = '${AUTHZ_ID.ORG_B}'
                        and id = '${CJ_ID.CANDIDATE_B}';` : ''}`);
        }

        storage = createServer((request, response) => {
            const pathname = new URL(request.url, 'http://localhost').pathname;
            const prefix = '/storage/v1/object/';
            const signed = pathname.startsWith(`${prefix}sign/cv-submissions/`);
            const authenticated = pathname.startsWith(`${prefix}cv-submissions/`);
            const key = decodeURIComponent(pathname.slice(
                (signed ? `${prefix}sign/cv-submissions/`
                    : `${prefix}cv-submissions/`).length));
            const file = files.get(key);
            if (!file || (!signed && !authenticated)) {
                response.writeHead(404).end();
            } else if (signed && request.method === 'POST') {
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify({
                    signedURL: `/object/sign/cv-submissions/${key}?token=synthetic`,
                }));
            } else {
                response.writeHead(200, {
                    'content-type': file.mimeType,
                    'content-disposition': 'inline',
                });
                response.end(file.bytes);
            }
        });
        const storagePort = await listen(storage);
        const port = await findFreePort();
        const baseURL = `http://127.0.0.1:${port}`;
        next = spawn(process.execPath,
            [join(root, 'node_modules', 'next', 'dist', 'bin', 'next'),
                'dev', '--webpack', '-p', String(port), '-H', '127.0.0.1'], {
                cwd: root,
                env: {
                    PATH: process.env.PATH, HOME: process.env.HOME,
                    NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1',
                    NODE_OPTIONS: `--require ${join(root, 'tests', 'staff-workspace', 'google-token-preload.cjs')}`,
                    STAFF_DATABASE_URL: `postgresql://agora_authz_test:${password}@127.0.0.1:${publishedPort(db, 5432)}/postgres`,
                    TELEGRAM_INTAKE_ENABLED: telegramDemo ? '1' : '',
                    TELEGRAM_EXTRACTION_CONTEXT_ENABLED: telegramAI ? 'true' : '',
                    TELEGRAM_WORKER_DATABASE_URL: telegramAI ? `postgresql://agora_authz_test:${password}@127.0.0.1:${publishedPort(db, 5432)}/postgres` : '',
                    STAFF_ORGANIZATION_ID: AUTHZ_ID.ORG_B,
                    NEXTAUTH_URL: baseURL, NEXTAUTH_SECRET: secret,
                    GOOGLE_CLIENT_ID: 'synthetic-workspace-client',
                    GOOGLE_CLIENT_SECRET: 'synthetic-workspace-client-secret',
                    NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${storagePort}`,
                    SUPABASE_SERVICE_ROLE_KEY: 'synthetic-storage-service-key',
                    GITHUB_ID: '', GITHUB_SECRET: '',
                },
                stdio: 'inherit',
            });
        await waitForServer(`${baseURL}/dev/duplicate-review`);
        if (telegramAI) {
            extractionDirectory = mkdtempSync(join(tmpdir(), 'telegram-ai-demo-'));
            const workerTokenFile = join(extractionDirectory, 'worker.token');
            writeFileSync(workerTokenFile, demo.workerToken + '\n', { mode: 0o600 });
            const workerConfig = join(extractionDirectory, 'config.json');
            writeFileSync(workerConfig, JSON.stringify({ serverUrl: baseURL, workerTokenFile, providerBaseUrl, providerModel: await verifyProxyModel(), providerTokenFile, stateDirectory: join(extractionDirectory, 'state') }), { mode: 0o600 });
            extraction = spawn(process.execPath, [join(root, 'services/telegram-extraction-worker/cli.mjs'), '--config', workerConfig], { cwd: root, stdio: 'inherit' });
            extraction.once('exit', code => { if (code) console.error('Extraction worker stopped. Check proxy sign-in and restart the demo.'); });
        }
        const token = await encode({ token: {
            name: 'Admin Two', email: 'admin-two@synthetic.test',
            sub: '1002', provider: 'google', providerAccountId: '1002',
            googleRefreshToken: 'SYNTHETIC-WORKSPACE-TEST', emailVerified: true,
            iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
        }, secret });
        const proof = createStaffMfaProof(secret, {
            subject: '1002', userId: AUTHZ_ID.USER_ADMIN2, credentialId,
        });
        entry = createServer((_request, response) => {
            response.writeHead(302, {
                location: `${baseURL}${telegramDemo ? '/staff/telegram-intake' : '/staff/candidates'}`,
                'cache-control': 'no-store',
                'set-cookie': [
                    `next-auth.session-token=${token}; Path=/; HttpOnly; SameSite=Lax`,
                    `${STAFF_MFA_COOKIE}=${proof}; Path=/; HttpOnly; SameSite=Lax`,
                ],
            });
            response.end();
        });
        const entryPort = await listen(entry, Number(process.env.STAFF_FIXTURE_PORT || 3013));
        console.log(`\nOpen http://127.0.0.1:${entryPort}/ to try the staff preview with synthetic data.`);
        if (telegramDemo) console.log(telegramAI ? 'AI demo: select sample chats and click Start. Candidate proposals are generated through CLIProxyAPI using GPT-6 Luna.' : 'Telegram demo: sample chats and proposals. Live importing and ranked search require configured workers.');
        console.log('Ctrl+C removes the temporary database.');
        await new Promise((resolve) => {
            process.once('SIGINT', resolve);
            process.once('SIGTERM', resolve);
            next.once('exit', resolve);
        });
    } finally {
        cleanup();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
