import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium, expect as baseExpect } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { POSTGRES_17_IMAGE, assertLocalTestEnvironment, findFreePort, psql, publishedPort, startPostgresContainer, stopAndRemoveContainer } from '../support/foundation-docker.js';
import { AUTHZ_ID, installStaffFixture } from '../support/staff-authorization.js';
import { CJ_ID, clientJobFixtureSql } from '../support/client-job-workflows.js';
import { STAFF_MFA_COOKIE, createStaffMfaProof } from '../../src/lib/staff-mfa-cookie.js';

const expect = baseExpect.configure({ timeout: 15000 });
const root = resolve(process.env.TELEGRAM_CONTEXT_TEST_ROOT || fileURLToPath(new URL('../../', import.meta.url)));

async function waitForServer(url) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) }).catch(() => null);
        if (response?.ok) return;
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Temporary Telegram connection server did not start');
}

test('private conversation search and context work offline, paginate, and clear revoked access', { timeout: 240_000 }, async t => {
    assertLocalTestEnvironment();
    const db = await startPostgresContainer('pgtelegramhistoryui', POSTGRES_17_IMAGE, { publish: true });
    t.after(() => stopAndRemoveContainer(db));
    const migrationsDir = join(root, 'supabase/migrations');
    const migrations = readdirSync(migrationsDir).filter(name => name >= '20260922090000_foundation_roles.sql' && name.endsWith('.sql')).sort();
    assert.ok(migrations.some(name => name.includes('telegram_context_search')), 'Context search migration is required');
    for (const name of migrations) psql(db, readFileSync(join(migrationsDir, name), 'utf8'));
    const runtimePassword = installStaffFixture(db);
    const workerPassword = randomUUID();
    psql(db, clientJobFixtureSql);
    psql(db, `create role telegram_connector_ui_test login noinherit nosuperuser nocreatedb nocreaterole nobypassrls password '${workerPassword}';
        grant app_telegram_worker to telegram_connector_ui_test;`);
    const secret = 'synthetic-telegram-connection-test-secret';
    const totpId = randomUUID();
    psql(db, `insert into app.totp_credentials (id, organization_id, user_id, secret, status, verified_at)
        values ('${totpId}', '${AUTHZ_ID.ORG_B}', '${AUTHZ_ID.USER_ADMIN2}', 'JBSWY3DPEHPK3PXP', 'active', now());`);
    const port = await findFreePort();
    const baseURL = `http://127.0.0.1:${port}`;
    const output = [];
    const server = spawn(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '-p', String(port), '-H', '127.0.0.1'], {
        cwd: root,
        env: {
            PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development',
            NEXT_TELEMETRY_DISABLED: '1', NODE_OPTIONS: `--require ${join(root, 'tests/staff-workspace/google-token-preload.cjs')}`,
            STAFF_DATABASE_URL: `postgresql://agora_authz_test:${runtimePassword}@127.0.0.1:${publishedPort(db, 5432)}/postgres`,
            TELEGRAM_WORKER_DATABASE_URL: `postgresql://telegram_connector_ui_test:${workerPassword}@127.0.0.1:${publishedPort(db, 5432)}/postgres`,
            STAFF_ORGANIZATION_ID: AUTHZ_ID.ORG_B, NEXTAUTH_URL: baseURL, NEXTAUTH_SECRET: secret,
            GOOGLE_CLIENT_ID: 'synthetic-workspace-client', GOOGLE_CLIENT_SECRET: 'synthetic-workspace-client-secret',
            TELEGRAM_INTAKE_ENABLED: '1', GITHUB_ID: '', GITHUB_SECRET: '',
        }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', chunk => output.push(String(chunk)));
    server.stderr.on('data', chunk => output.push(String(chunk)));
    t.after(async () => {
        if (server.exitCode !== null) return;
        server.kill('SIGTERM');
        await new Promise(resolve => {
            const timer = setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 10_000);
            server.once('exit', () => { clearTimeout(timer); resolve(); });
        });
    });
    await waitForServer(`${baseURL}/staff/sign-in`);
    const token = await encode({ token: {
        name: 'Admin Two', email: 'admin-two@synthetic.test', sub: '1002', provider: 'google',
        providerAccountId: '1002', googleRefreshToken: 'SYNTHETIC-WORKSPACE-TEST', emailVerified: true,
        iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
    }, secret });
    const proof = createStaffMfaProof(secret, { subject: '1002', userId: AUTHZ_ID.USER_ADMIN2, credentialId: totpId });
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const context = await browser.newContext();
    await context.addCookies([
        { name: 'next-auth.session-token', value: token, url: baseURL },
        { name: STAFF_MFA_COOKIE, value: proof, url: baseURL },
    ]);
    const registration = await context.request.post(`${baseURL}/api/staff/telegram-intake/workers`, { data: { name: 'Offline synthetic Mac' } });
    assert.equal(registration.status(), 201, await registration.text());
    const registered = (await registration.json()).result;
    const publicKeySpki = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const heartbeat = await context.request.post(`${baseURL}/api/telegram-connection/worker/heartbeat`, { headers: { authorization: `Bearer ${registered.token}` }, data: { publicKeySpki } });
    assert.equal(heartbeat.status(), 200, await heartbeat.text());
    const connected = await context.request.post(`${baseURL}/api/staff/telegram-connection`, { data: { action: 'connect', workerId: registered.id } });
    assert.equal(connected.status(), 200, await connected.text());
    const connectionId = JSON.parse(psql(db, `select json_build_object('id',id) from app.telegram_connections where owner_user_id='${AUTHZ_ID.USER_ADMIN2}' and organization_id='${AUTHZ_ID.ORG_B}';`)).id;
    const accountId = randomUUID(), previousAccountId = randomUUID(), chatId = randomUUID(), previousChatId = randomUUID();
    const sqlText = value => `'${String(value).replaceAll("'", "''")}'`;
    const record = (id, text) => ({ messageId: String(id), kind: 'message', sentAt: `2026-10-10T12:${String(Math.floor(id / 60)).padStart(2, '0')}:${String(id % 60).padStart(2, '0')}.000Z`, editedAt: null,
        sender: { peer: { kind: 'user', id: '55' }, displayName: 'Ada Developer', username: 'ada_dev' }, text, attachments: id === 30 ? [{ id: null, kind: 'document', filename: 'Candidate.pdf', mimeType: 'application/pdf', sizeBytes: 2048 }] : [], replyToMessageId: id > 1 ? String(id - 1) : null, forwardedFrom: null });
    const messages = Array.from({ length: 31 }, (_, index) => record(index + 1, index === 30 ? `Solidity long source ${'tail information '.repeat(1000)}` : `Solidity client priority ${index + 1} <script>window.__unsafe=true</script>`));
    psql(db, `update app.telegram_connections set status='disconnected',profile='{"telegramUserId":"10001"}' where id='${connectionId}';
        insert into app.telegram_history_accounts(id,organization_id,owner_user_id,connection_id,account_user_id) values
        ('${accountId}','${AUTHZ_ID.ORG_B}','${AUTHZ_ID.USER_ADMIN2}','${connectionId}','10001'),
        ('${previousAccountId}','${AUTHZ_ID.ORG_B}','${AUTHZ_ID.USER_ADMIN2}','${connectionId}','10002');
        insert into app.telegram_history_chats(id,organization_id,owner_user_id,account_id,peer_kind,peer_id,title) values
        ('${chatId}','${AUTHZ_ID.ORG_B}','${AUTHZ_ID.USER_ADMIN2}','${accountId}','user','55','Client priorities'),
        ('${previousChatId}','${AUTHZ_ID.ORG_B}','${AUTHZ_ID.USER_ADMIN2}','${previousAccountId}','chat','66','Previous account hiring');
        ${messages.map(message => `insert into app.telegram_history_messages(organization_id,owner_user_id,chat_id,message_id,body,stored_bytes) values('${AUTHZ_ID.ORG_B}','${AUTHZ_ID.USER_ADMIN2}','${chatId}',${message.messageId},${sqlText(JSON.stringify(message))}::jsonb,octet_length(${sqlText(JSON.stringify(message))}::jsonb::text));`).join('\n')}
        insert into app.telegram_history_messages(organization_id,owner_user_id,chat_id,message_id,body,stored_bytes) values('${AUTHZ_ID.ORG_B}','${AUTHZ_ID.USER_ADMIN2}','${previousChatId}',1,${sqlText(JSON.stringify(record(1, 'Product design client hiring budget')))}::jsonb,100);
        delete from app.role_permissions where role_id='${AUTHZ_ID.ROLE_B_ADMIN}' and permission_key='candidates.write';`);
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
    const endpoint = `${baseURL}/api/staff/telegram-context`;
    async function search(query) {
        await page.getByLabel('Message words or phrase', { exact: true }).fill(query);
        const response = page.waitForResponse(response => response.url() === endpoint && response.request().postDataJSON()?.action === 'search');
        await page.getByRole('button', { name: 'Search messages', exact: true }).click();
        const received = await response;
        assert.equal(received.status(), 200, await received.text());
        await expect(page.getByText('Searching retained messages…', { exact: true })).toHaveCount(0);
        return received.json();
    }
    try {
        await page.goto(`${baseURL}/staff/telegram-intake/context`);
        await expect(page.getByRole('heading', { name: 'Search conversations', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: /Previous account hiring/ })).toBeVisible();
        let result = await search('Solidity');
        assert.equal(result.results.length, 25); assert.ok(result.nextAfter);
        assert.equal(new URL(page.url()).search, '');
        assert.equal(await page.evaluate(() => window.__unsafe), undefined);
        await expect(page.getByRole('button', { name: 'View conversation', exact: true })).toHaveCount(25);
        await page.getByRole('button', { name: 'Next result page', exact: true }).click();
        await expect(page.getByRole('button', { name: 'View conversation', exact: true })).toHaveCount(6);
        await page.getByRole('button', { name: 'Previous result page', exact: true }).click();
        await expect(page.getByRole('button', { name: 'View conversation', exact: true })).toHaveCount(25);
        await page.getByRole('button', { name: 'View conversation', exact: true }).first().click();
        const dialog = page.getByRole('dialog');
        await expect(dialog.getByText('Requested message', { exact: true })).toBeInViewport();
        await expect(dialog.getByText(/Solidity long source/)).toBeVisible();
        await dialog.getByRole('button', { name: 'View replied-to message', exact: true }).last().click();
        await expect(dialog.getByText('Requested message', { exact: true })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await page.getByRole('button', { name: 'All imported chats', exact: true }).click();
        await page.getByLabel('Exact Telegram username', { exact: true }).fill('@ada_dev');
        await page.getByLabel('Messages with attachments only', { exact: true }).check();
        result = await search('Solidity'); assert.equal(result.results.length, 1);
        await expect(page.getByText(/Candidate.pdf/)).toBeVisible();
        await page.getByLabel('Messages with attachments only', { exact: true }).uncheck();
        await page.getByRole('button', { name: /Previous account hiring/ }).click();
        result = await search('"client hiring"'); assert.equal(result.results.length, 1);
        assert.equal(result.results[0].chatId, previousChatId);
        await page.goto(`${baseURL}/staff/telegram-intake/context?chatId=${chatId}&messageId=15`);
        await expect(page.getByRole('dialog').getByText('Requested message', { exact: true })).toBeVisible();
        await page.keyboard.press('Escape');
        psql(db, `delete from app.telegram_history_messages where chat_id='${chatId}' and message_id=15;`);
        await page.goto(`${baseURL}/staff/telegram-intake/context?chatId=${chatId}&messageId=15`);
        await expect(page.getByRole('dialog').getByText(/requested message is not retained/)).toBeVisible();
        await page.keyboard.press('Escape');
        result = await search('Solidity'); assert.equal(result.coverage.retainedMessages, 31);
        // A previously authorized response must not restore private data after session invalidation.
        let releaseRead, markReady;
        const heldRead = new Promise(resolve => { releaseRead = resolve; });
        const readReady = new Promise(resolve => { markReady = resolve; });
        await page.route(endpoint, async route => {
            const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null;
            if (body?.action !== 'search') { await route.continue(); return; }
            const response = await route.fetch();
            markReady();
            await heldRead;
            await route.fulfill({ response }).catch(error => { if (!/closed|aborted|disposed/i.test(error.message)) throw error; });
        });
        await page.getByRole('button', { name: 'Search messages', exact: true }).click();
        await readReady;
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('staff-session-invalidated')));
        releaseRead();
        await expect(page.getByLabel('Message words or phrase', { exact: true })).toHaveValue('');
        await expect(page.getByRole('button', { name: 'View conversation', exact: true })).toHaveCount(0);
        await page.unroute(endpoint);
        await page.goto(`${baseURL}/staff/telegram-intake/context`);
        result = await search('Solidity');
        await page.setViewportSize({ width: 390, height: 844 });
        mkdirSync(join(root, 'test-results'), { recursive: true });
        await page.screenshot({ path: join(root, 'test-results/staff-workspace-telegram-context-mobile.png'), fullPage: true });
        await page.screenshot({ path: join(root, 'test-results/staff-workspace-telegram-context-mobile-viewport.png') });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
        // Seed only private identity anchors; real approval/capture/merge/disposal is covered by the DB suite.
        const sourceId = randomUUID(), draftId = randomUUID(), extractionId = randomUUID();
        const snapshot = { chat: { id: chatId, title: 'Client priorities', peer: { kind: 'user', id: '55' }, accountUserId: '10001' }, messages: [{ ...record(29, ''), kind: 'unavailable', sentAt: null, sender: null, replyToMessageId: null }] };
        psql(db, `insert into app.candidate_sources(id,organization_id,candidate_id,kind,received_at,created_by_membership_id,context_summary) values('${sourceId}','${AUTHZ_ID.ORG_B}','${CJ_ID.CANDIDATE_B}','manual',now(),'${AUTHZ_ID.MEMBER_B_ADMIN}','Added by staff');
            insert into app.telegram_drafts(id,organization_id,owner_user_id,candidate_target_id,status,approved_candidate_id,reviewed_at) values('${draftId}','${AUTHZ_ID.ORG_B}','${AUTHZ_ID.USER_ADMIN2}','${CJ_ID.CANDIDATE_B}','approved','${CJ_ID.CANDIDATE_B}',now());
            insert into app.telegram_extraction_jobs(id,organization_id,owner_user_id,chat_id,source,source_digest,message_count,status,source_invalidated_at) values('${extractionId}','${AUTHZ_ID.ORG_B}','${AUTHZ_ID.USER_ADMIN2}','${chatId}',${sqlText(JSON.stringify(snapshot))}::jsonb,sha256(convert_to('synthetic-only','UTF8')),1,'completed',now());
            insert into app.telegram_candidate_origins values('${AUTHZ_ID.ORG_B}','${AUTHZ_ID.USER_ADMIN2}','${draftId}','${sourceId}');
            insert into app.telegram_candidate_context_refs(organization_id,owner_user_id,draft_id,candidate_source_id,chat_id,message_id,extraction_job_id) values('${AUTHZ_ID.ORG_B}','${AUTHZ_ID.USER_ADMIN2}','${draftId}','${sourceId}','${chatId}',29,'${extractionId}'),('${AUTHZ_ID.ORG_B}','${AUTHZ_ID.USER_ADMIN2}','${draftId}','${sourceId}','${chatId}',15,'${extractionId}');`);
        await page.goto(`${baseURL}/staff/candidates/${CJ_ID.CANDIDATE_B}`, { timeout: 120_000 });
        const provenance = page.getByLabel('Private Telegram provenance', { exact: true });
        await expect(provenance).toBeVisible();
        await expect(provenance.getByText('Source changed after extraction; review approved facts.', { exact: true })).toHaveCount(2);
        await expect(provenance.getByRole('link', { name: 'Source unavailable · Open retained conversation', exact: true })).toBeVisible();
        const provenanceEndpoint = `${baseURL}/api/staff/candidates/${CJ_ID.CANDIDATE_B}/telegram-context`;
        let releaseProvenance, markProvenanceReady;
        const heldProvenance = new Promise(resolve => { releaseProvenance = resolve; });
        const provenanceReady = new Promise(resolve => { markProvenanceReady = resolve; });
        await page.route(provenanceEndpoint, async route => {
            const response = await route.fetch();
            markProvenanceReady();
            await heldProvenance;
            await route.fulfill({ response }).catch(error => { if (!/closed|aborted|disposed/i.test(error.message)) throw error; });
        });
        await page.reload();
        await provenanceReady;
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('staff-session-invalidated')));
        releaseProvenance();
        await expect(provenance).toHaveCount(0);
        await page.unroute(provenanceEndpoint);
        await page.reload();
        await expect(provenance).toBeVisible();
        await provenance.getByRole('link', { name: 'View original message', exact: true }).click();
        await expect(page.getByRole('dialog').getByText('Requested message', { exact: true })).toBeInViewport();
        assert.equal(new URL(page.url()).searchParams.get('messageId'), '29');
        await page.keyboard.press('Escape');
        await search('Solidity');
        psql(db, `delete from app.role_permissions where role_id='${AUTHZ_ID.ROLE_B_ADMIN}' and permission_key='candidates.read';`);
        await page.getByRole('button', { name: 'Search messages', exact: true }).click();
        await expect(page.getByRole('button', { name: 'View conversation', exact: true })).toHaveCount(0);
        await expect(page.getByLabel('Message words or phrase', { exact: true })).toHaveValue('');
        assert.deepEqual(pageErrors, []);
    } catch (error) { console.error(output.join('').slice(-20000)); throw error; }
});
