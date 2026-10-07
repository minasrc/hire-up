import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { POSTGRES_17_IMAGE, assertLocalTestEnvironment, psql, publishedPort, startPostgresContainer, stopAndRemoveContainer } from './foundation-docker.js';
import { AUTHZ_ID, installStaffFixture, staffPoolOptions } from './staff-authorization.js';
import { CJ_ID, CJ_SUBJECTS, clientJobFixtureSql } from './client-job-workflows.js';
import { registerTelegramWorker } from '../../src/lib/telegram-intake-operations.js';
import { profileSearchStatus, profileSearchAction, profileSearchWorkerOperation } from '../../src/lib/profile-search-operations.js';
import { createPendingStore } from '../../services/semantic-worker/store.mjs';

export const org = AUTHZ_ID.ORG_B;
export const identity = subject => ({ provider: 'google', issuer: 'https://accounts.google.com', subject });
export const owner = identity(CJ_SUBJECTS.ADMIN);
export const other = identity(CJ_SUBJECTS.RECRUITER);
export const indexVersion = 'intfloat/multilingual-e5-small@614241f622f53c4eeff9890bdc4f31cfecc418b3:e5-prefix:l2:384:v1';
export const chunkerVersion = 'e5-utf8-448-v1';
export const hash = text => createHash('sha256').update(text).digest('hex');
export const vector = axis => Array.from({ length: 384 }, (_, i) => i === axis ? 1 : 0);

export async function cvSearchFixture(t) {
  assertLocalTestEnvironment();
  const adminPassword = randomUUID();
  const db = await startPostgresContainer('cvsearchruntime', POSTGRES_17_IMAGE, { publish: true, password: adminPassword });
  const root = mkdtempSync(join(tmpdir(), 'agora-cv-search-runtime-'));
  let pool; let workerPool; let admin;
  t.after(async () => { await Promise.all([pool?.end(), workerPool?.end(), admin?.end()]); stopAndRemoveContainer(db); rmSync(root, { recursive: true, force: true }); });
  const dir = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
  const files = readdirSync(dir).filter(name => name >= '20260922090000_foundation_roles.sql' && name.slice(0, 14) <= '20261002210000' && name.endsWith('.sql')).sort();
  assert.ok(files.some(name => name.startsWith('20261002210000_')), 'Install CV search migration');
  for (const name of files) psql(db, readFileSync(join(dir, name), 'utf8'));
  const password = installStaffFixture(db); psql(db, clientJobFixtureSql);
  psql(db, `insert into app.role_permissions(organization_id,role_id,permission_key) values('${org}','${CJ_ID.ROLE_B_RECRUITER}','candidates.write') on conflict do nothing;`);
  pool = new pg.Pool(staffPoolOptions(db, password, 8));
  admin = new pg.Pool({ host: '127.0.0.1', port: publishedPort(db, 5432), database: 'postgres', user: 'postgres', password: adminPassword, max: 4 });
  const workerPassword = randomUUID();
  psql(db, `create role cv_search_runtime_test login noinherit nosuperuser nocreatedb nocreaterole nobypassrls password '${workerPassword}'; grant app_telegram_worker to cv_search_runtime_test;`);
  workerPool = new pg.Pool({ ...staffPoolOptions(db, workerPassword, 5), user: 'cv_search_runtime_test' });
  const registered = await registerTelegramWorker(pool, owner, org, 'Synthetic CV search worker');
  const mapError = error => { error.status ??= { '40001': 409, '22023': 400, '42501': 403, P0002: 404 }[error.code]; throw error; };
  const makeHost = token => (action, body) => profileSearchWorkerOperation(workerPool, token, action, body).catch(mapError);
  const status = (input, actor = owner) => profileSearchStatus(pool, actor, org, input);
  const action = (input, actor = owner) => profileSearchAction(pool, actor, org, input);
  const store = (name = 'pending', token = registered.token) => createPendingStore({ root: join(root, name), server: 'https://synthetic.invalid', workerToken: token });
  const candidate = async (fields = {}) => {
    const id = randomUUID();
    await admin.query(`insert into app.candidates(id,organization_id,full_name,first_name,last_name,contact_email,headline,location,professional_summary,identity_state,lifecycle)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,'established','active')`, [id, org, `${fields.firstName ?? 'Synthetic'} ${fields.lastName ?? 'Candidate'}`, fields.firstName ?? 'Synthetic', fields.lastName ?? 'Candidate', fields.primaryEmail ?? `${id}@example.invalid`, fields.headline ?? null, fields.location ?? null, fields.professionalSummary ?? null]);
    return id;
  };
  // Canonical synthetic reviewed artifacts for search tests. Separate parser /
  // approval runtime tests exercise how these rows are created by real workflows.
  const reviewedCv = async (candidateId, text, options = {}) => {
    const blobId = randomUUID(), documentId = randomUUID(), artifactId = randomUUID();
    const documentSha = options.documentSha ?? hash(`Synthetic document ${documentId}`);
    const blocks = options.blocks ?? [{ ordinal: 0, text }];
    await admin.query(`insert into app.file_blobs(id,organization_id,candidate_id,sha256,size_bytes,mime_type,extension,lifecycle,scan_state)
      values($1,$2,$3,decode($4,'hex'),512,'application/pdf','pdf','live','unscanned')`, [blobId, org, candidateId, documentSha]);
    await admin.query(`insert into app.blob_locations(id,organization_id,blob_id,backend_key,bucket,object_key,state,is_primary,verified_sha256,verified_size_bytes,verified_at)
      values($1,$2,$3,'supabase_storage','synthetic-cv-search',$4,'available',true,decode($5,'hex'),512,now())`, [randomUUID(), org, blobId, `${blobId}.pdf`, documentSha]);
    await admin.query(`insert into app.documents(id,organization_id,candidate_id,blob_id,purpose,original_filename,received_at,lifecycle)
      values($1,$2,$3,$4,'cv','Synthetic CV.pdf',now(),'active')`, [documentId, org, candidateId, blobId]);
    await admin.query('update app.candidates set current_document_id=$1 where id=$2', [documentId, candidateId]);
    await admin.query(`insert into app.candidate_reviewed_cv_text(id,organization_id,candidate_id,document_id,document_sha256,parser_version,text_sha256,blocks,text_content,reviewed_by)
      values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`, [artifactId, org, candidateId, documentId, documentSha, options.parserVersion ?? 'synthetic-parser-v1', hash(text), JSON.stringify(blocks), text, AUTHZ_ID.USER_ADMIN2]);
    return { blobId, documentId, artifactId };
  };
  return { db, root, pool, workerPool, admin, registered, makeHost, host: makeHost(registered.token), status, action, store, candidate, reviewedCv };
}

export async function drain(runtime, limit = 3000) {
  for (let i = 0; i < limit; i++) if ((await runtime.tick()).status === 'idle') return i;
  assert.fail('Worker did not drain its synthetic queue');
}
export async function search(f, runtime, query, options = {}, actor = owner) {
  const request = await f.action({ action: 'search', operationId: randomUUID(), query, scope: 'approved', readyOnly: false, includeCv: true, ...options }, actor);
  for (let i = 0; i < 100; i++) {
    const detail = await f.status({ queryId: request.queryId }, actor);
    if (detail.status === 'completed') return detail;
    assert.ok(['queued', 'running'].includes(detail.status), `Search unexpectedly ${detail.status}: ${detail.errorCode}`);
    await runtime.tick();
  }
  assert.fail('Query did not finish');
}
