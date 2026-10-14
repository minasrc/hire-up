import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { POSTGRES_17_IMAGE, assertLocalTestEnvironment, psql, startPostgresContainer, stopAndRemoveContainer } from '../support/foundation-docker.js';
import { AUTHZ_ID, installStaffFixture, staffPoolOptions } from '../support/staff-authorization.js';
import { clientJobFixtureSql } from '../support/client-job-workflows.js';
import { telegramExtractionStatus } from '../../src/lib/telegram-extraction-operations.js';
import { createTelegramDraft } from '../../src/lib/telegram-intake-operations.js';
import { withStaffTransaction } from '../../src/lib/staff-authorization.js';
import { telegramHistoryRecentStatus, telegramHistoryAction, telegramHistoryStatus } from '../../src/lib/telegram-history-operations.js';
const org = AUTHZ_ID.ORG_B, user = AUTHZ_ID.USER_ADMIN2;
const identity = { provider: 'google', issuer: 'https://accounts.google.com', subject: '1002' };
test('recent history pages retain global tuple order and owner scope', { timeout:120000 }, async t => {
  assertLocalTestEnvironment();
  const db = await startPostgresContainer('pgtelegramchatremoval', POSTGRES_17_IMAGE, { publish: true });
  let pool;
  t.after(async () => { await pool?.end(); stopAndRemoveContainer(db); });
  const directory = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
  for (const name of readdirSync(directory).filter(n => n.endsWith('.sql') && n >= '20260922090000' && n <= '20261014170000_telegram_chat_exclusions.sql').sort()) psql(db, readFileSync(join(directory, name), 'utf8'));
  const password = installStaffFixture(db); psql(db, clientJobFixtureSql);
  pool = new pg.Pool(staffPoolOptions(db, password, 3));

  const connection=randomUUID(),account=randomUUID(),worker=randomUUID();
  const publicKey = generateKeyPairSync('rsa', { modulusLength:2048 }).publicKey.export({type:'spki',format:'der'}).toString('base64');
  psql(db, `insert into app.telegram_workers(id,organization_id,owner_user_id,name,token_sha256) values('${worker}','${org}','${user}','Synthetic ordering worker',sha256(convert_to('synthetic','UTF8')));
  insert into app.telegram_connector_workers(id,organization_id,owner_user_id,public_key_spki) values('${worker}','${org}','${user}','${publicKey}');
  insert into app.telegram_connections(id,organization_id,owner_user_id,worker_id,status,auth_expires_at,profile) values('${connection}','${org}','${user}','${worker}','disconnected',now()+interval '10 minutes','{"telegramUserId":"123456"}');
  insert into app.telegram_history_accounts(id,organization_id,owner_user_id,connection_id,account_user_id) values('${account}','${org}','${user}','${connection}','123456');
  insert into app.telegram_history_chats(id,organization_id,owner_user_id,account_id,peer_kind,peer_id,title,selected,last_message_at)
  select ('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'${org}','${user}','${account}','user',n::text,'Synthetic '||n,n%2=0,case when n>90 then null else '2026-01-01'::timestamptz+((n/3)::text||' days')::interval end from generate_series(1,127) n;
  insert into app.telegram_history_jobs(organization_id,owner_user_id,account_id,chat_id,kind,connection_generation,status,cursor) select '${org}','${user}','${account}',id,'history',1,case when peer_id::integer%2=0 then 'queued' else 'paused' end,'{}' from app.telegram_history_chats where account_id='${account}';`);
  const fetch = filters => telegramHistoryRecentStatus(pool,identity,org,filters);
  let first=await fetch({}), all=[...first.chats], cursor=first.nextCursor;
  assert.equal(first.chats.length,50); assert.equal(first.chats[0].id,'10000000-0000-4000-8000-000000000090');
  assert.ok('removalState' in first.chats[0]); assert.ok('progress' in first.chats[0]); assert.ok('sync' in first.chats[0]);
  while(cursor) { const page=await fetch({after:cursor}); all.push(...page.chats);cursor=page.nextCursor; }
  assert.equal(all.length,127);assert.equal(new Set(all.map(c=>c.id)).size,127);
  for(let i=1;i<all.length;i++) { const a=all[i-1],b=all[i];assert.ok(a.lastMessageAt===null ? b.lastMessageAt===null && a.id<b.id : b.lastMessageAt===null || a.lastMessageAt>b.lastMessageAt || a.lastMessageAt===b.lastMessageAt && a.id<b.id); }
  await assert.rejects(fetch({view:'selected',after:first.nextCursor}), /cursor/i);
  await assert.rejects(fetch({q:'Synthetic',after:first.nextCursor}), /cursor/i);
  await assert.rejects(telegramHistoryRecentStatus(pool,{...identity,subject:'1007'},org,{after:first.nextCursor}), /cursor/i);
  const tuple=JSON.parse(Buffer.from(first.nextCursor,'base64url')); tuple.accountId=randomUUID();
  await assert.rejects(fetch({after:Buffer.from(JSON.stringify(tuple)).toString('base64url')}), /cursor/i);
  const search=[];cursor=null;do {const p=await fetch({q:'Synthetic',after:cursor});search.push(...p.chats);cursor=p.nextCursor;}while(cursor);assert.deepEqual(search.map(c=>c.id),all.map(c=>c.id));
  assert.deepEqual((await telegramHistoryRecentStatus(pool,{...identity,subject:'1007'},org,{after:first.chats[0].id})).chats,[]);
  const selected=[];cursor=null;do { const p=await fetch({view:'selected',after:cursor});selected.push(...p.chats);cursor=p.nextCursor; }while(cursor);assert.equal(selected.length,63);assert.ok(selected.every(c=>c.selected));
  for(const [view,expected] of [['active',63],['paused',64]]) {let count=0,cursor=null;do {const p=await fetch({view,after:cursor});count+=p.chats.length;cursor=p.nextCursor;}while(cursor);assert.equal(count,expected);}
  const q=await fetch({q:'Synthetic 12'});assert.equal(q.chats.length,9);
  tuple.accountId=account;
  psql(db, `update app.telegram_history_chats set last_message_at='2030-01-01' where id='${tuple.id}'`);
  assert.equal((await fetch({after:first.nextCursor})).chats[0].id,all[50].id);
  psql(db, `delete from app.telegram_history_jobs where chat_id='${tuple.id}'; delete from app.telegram_history_chats where id='${tuple.id}'`);
  const continued=await fetch({after:first.nextCursor});assert.equal(continued.chats[0].id,all[50].id);
  const reset=await fetch({after:randomUUID()});assert.equal(reset.chats[0].id,first.chats[0].id);
  await assert.rejects(withStaffTransaction(pool,identity,org,['candidates.read','candidates.write'],async({client})=>client.query('select * from app.telegram_history_chats')), /permission denied/);
  psql(db, 'revoke execute on function app.telegram_history_status_v2(text,text,jsonb) from app_staff;');
  await assert.rejects(fetch({}), { code: '42501' });
  psql(db, 'grant execute on function app.telegram_history_status_v2(text,text,jsonb) to app_staff;alter function app.telegram_history_status_v2(text,text,jsonb) rename to telegram_history_status_pending_v2;');
  try {
    const fallback = await fetch({});
    assert.equal(fallback.chats.length, 50, 'A rolling migration keeps the existing scoped reader available');
    assert.equal(fallback.totals.chats, 126);
    assert.deepEqual((await telegramHistoryRecentStatus(pool,{...identity,subject:'1007'},org,{})).chats,[]);
  } finally { psql(db, 'alter function app.telegram_history_status_pending_v2(text,text,jsonb) rename to telegram_history_status_v2;'); }

  await t.test('exclusions persist, filter before pagination, reject stale/foreign actions and restore without processing', async () => {
    const current=await fetch({});
    const extraction=randomUUID(),cv=randomUUID(),analysis=randomUUID();
    const draft=await createTelegramDraft(pool,identity,org,{fields:{firstName:'Private',lastName:'Source'}});
    psql(db, `insert into app.telegram_extraction_jobs(id,organization_id,owner_user_id,chat_id,source,source_digest,message_count,status,lease_token,lease_worker_id,lease_expires_at)
      values('${extraction}','${org}','${user}','${current.chats[0].id}','{}',sha256(convert_to('{}','UTF8')),0,'leased','${randomUUID()}','${worker}',now()+interval '2 minutes');
      insert into app.telegram_cv_jobs(id,organization_id,owner_user_id,draft_id,account_id,extraction_job_id,connection_id,connection_generation,document_revision,source,source_digest)
      values('${cv}','${org}','${user}','${draft.id}','${account}','${extraction}','${connection}',1,0,'{}',sha256(convert_to('{}','UTF8')));
      insert into app.cv_analyses(id,organization_id,owner_user_id,draft_id,document_revision,document_sha256,size_bytes,filename,extension,object_key,extraction_job_id)
      values('${analysis}','${org}','${user}','${draft.id}',0,'${'a'.repeat(64)}',100,'private.pdf','pdf','synthetic/private.pdf','${extraction}');`);
    const hidden=current.chats.map(ch=>({chatId:ch.id,expectedVersion:ch.version}));
    await telegramHistoryAction(pool,identity,org,{action:'excludeMany',chats:hidden});
    psql(db, `do $$ begin
      if not exists(select 1 from app.telegram_extraction_jobs where id='${extraction}' and status='queued' and lease_token is null) then raise exception 'Extraction must be fenced'; end if;
      if not exists(select 1 from app.telegram_cv_jobs where id='${cv}' and status='cancelled') then raise exception 'Retrieval must stop'; end if;
      if not exists(select 1 from app.cv_analyses where id='${analysis}' and status='cancelled') then raise exception 'CV analysis must stop'; end if;
    end $$;`);
    const extractionStatus=await telegramExtractionStatus(pool,identity,org,{});
    assert.equal(extractionStatus.counts.queued,0,'excluded backlog does not appear as pending work');
    assert.ok(extractionStatus.jobs.every(job=>job.id!==extraction));
    const visible=await fetch({});
    assert.equal(visible.chats.length,50,'hidden rows do not consume the next page');
    assert.equal(visible.totals.chats,76);
    assert.equal(visible.totals.excluded,50);
    assert.ok(visible.chats.every(ch=>!hidden.some(row=>row.chatId===ch.id)));
    const excluded=await fetch({view:'excluded'});
    assert.equal(excluded.chats.length,50);
    assert.ok(excluded.chats.every(ch=>ch.excluded && !ch.selected && !ch.extractionEnabled));
    assert.ok(excluded.chats.every(ch=>ch.import.status==='cancelled'));
    assert.equal((await fetch({q:excluded.chats[0].title})).chats.some(ch=>ch.id===excluded.chats[0].id),false);
    assert.ok((await telegramHistoryStatus(pool,identity,org,{})).chats.every(ch=>!hidden.some(row=>row.chatId===ch.id)),'legacy reader also hides exclusions');
    await assert.rejects(telegramHistoryAction(pool,identity,org,{action:'restore',chatId:hidden[0].chatId,expectedVersion:hidden[0].expectedVersion}), {code:'40001'});
    const row=excluded.chats[0];
    await assert.rejects(telegramHistoryAction(pool,{...identity,subject:'1007'},org,{action:'restore',chatId:row.id,expectedVersion:row.version}), /unavailable/i);
    // A dialog refresh updates metadata without resetting the persisted choice.
    psql(db, `update app.telegram_history_chats set title='Rediscovered personal chat' where id='${row.id}';`);
    assert.equal((await fetch({q:'Rediscovered personal chat'})).chats.length,0);
    await telegramHistoryAction(pool,identity,org,{action:'restore',chatId:row.id,expectedVersion:row.version});
    const restored=(await fetch({q:'Rediscovered personal chat'})).chats[0];
    assert.equal(restored.excluded,false);
    assert.equal(restored.selected,false);
    assert.equal(restored.extractionEnabled,false);
    assert.equal(restored.import.status,'cancelled');
    const personal=randomUUID();
    psql(db, `insert into app.telegram_history_chats(id,organization_id,owner_user_id,account_id,peer_kind,peer_id,title) values('${personal}','${org}','${user}','${account}','user','999999','Never imported personal chat');
    update app.telegram_connections set status='connected' where id='${connection}';`);
    await telegramHistoryAction(pool,identity,org,{action:'exclude',chatId:personal,expectedVersion:1});
    await assert.rejects(telegramHistoryAction(pool,identity,org,{action:'start',selected:true,chats:[{chatId:personal,expectedVersion:2}]}), {code:'23514'});
    assert.equal((await fetch({view:'excluded',q:'Never imported personal chat'})).chats.length,1);
  });
});
