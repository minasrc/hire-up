import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { POSTGRES_17_IMAGE, assertLocalTestEnvironment, psql, startPostgresContainer, stopAndRemoveContainer } from '../support/foundation-docker.js';
import { AUTHZ_ID, installStaffFixture, staffPoolOptions } from '../support/staff-authorization.js';
import { CJ_ID, clientJobFixtureSql } from '../support/client-job-workflows.js';
import { withStaffTransaction } from '../../src/lib/staff-authorization.js';
import { telegramHistoryRecentStatus } from '../../src/lib/telegram-history-operations.js';
const org = AUTHZ_ID.ORG_B, user = AUTHZ_ID.USER_ADMIN2;
const identity = { provider: 'google', issuer: 'https://accounts.google.com', subject: '1002' };
test('recent history pages retain global tuple order and owner scope', { timeout:120000 }, async t => {
  assertLocalTestEnvironment();
  const db = await startPostgresContainer('pgtelegramchatremoval', POSTGRES_17_IMAGE, { publish: true });
  let pool;
  t.after(async () => { await pool?.end(); stopAndRemoveContainer(db); });
  const directory = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
  for (const name of readdirSync(directory).filter(n => n.endsWith('.sql') && n >= '20260922090000' && n <= '20261013200000_telegram_chat_order.sql').sort()) psql(db, readFileSync(join(directory, name), 'utf8'));
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
});
