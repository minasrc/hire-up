import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
// Optional explicit scale check, not part of the default unit/database suite.
// Creates and destroys only a guarded, labeled local disposable PostgreSQL17 database.
const root=fileURLToPath(new URL('../../',import.meta.url));
const {POSTGRES_17_IMAGE,assertLocalTestEnvironment,psql,startPostgresContainer,stopAndRemoveContainer}=await import(`${root}/tests/support/foundation-docker.js`);
const {AUTHZ_ID:I,installStaffFixture}=await import(`${root}/tests/support/staff-authorization.js`);
assertLocalTestEnvironment();const db=await startPostgresContainer('pgcontextscale',POSTGRES_17_IMAGE,{publish:false});
try{
 const dir=join(root,'supabase/migrations');const migration='20261011120000_telegram_context_search.sql';
 for(const f of readdirSync(dir).filter(f=>f>='20260922090000_foundation_roles.sql'&&f<migration&&f.endsWith('.sql')).sort())psql(db,readFileSync(join(dir,f),'utf8'));
 installStaffFixture(db);const worker=randomUUID(),connection=randomUUID(),account=randomUUID(),chat=randomUUID();
 psql(db,`insert into app.telegram_workers(id,organization_id,owner_user_id,name,token_sha256) values('${worker}','${I.ORG_A}','${I.USER_CUSTOM}','Scale',sha256(convert_to('${worker}','UTF8')));
 insert into app.telegram_connector_workers(id,organization_id,owner_user_id,public_key_spki) values('${worker}','${I.ORG_A}','${I.USER_CUSTOM}',repeat('A',392));
 insert into app.telegram_connections(id,organization_id,owner_user_id,worker_id,status,auth_expires_at) values('${connection}','${I.ORG_A}','${I.USER_CUSTOM}','${worker}','disconnected',now());
 insert into app.telegram_history_accounts(id,organization_id,owner_user_id,connection_id,account_user_id) values('${account}','${I.ORG_A}','${I.USER_CUSTOM}','${connection}','1000');
 insert into app.telegram_history_chats(id,organization_id,owner_user_id,account_id,peer_kind,peer_id,title) values('${chat}','${I.ORG_A}','${I.USER_CUSTOM}','${account}','user','1000','Scale');
 insert into app.telegram_history_messages(organization_id,owner_user_id,chat_id,message_id,body,stored_bytes)
 select '${I.ORG_A}','${I.USER_CUSTOM}','${chat}',n,b,octet_length(b::text) from generate_series(1,200000)n cross join lateral(select jsonb_build_object('messageId',n::text,'kind','message','sentAt','2026-10-11T12:00:00.000Z','editedAt',null,'sender',null,'replyToMessageId',null,'forwardedFrom',null,'attachments','[]'::jsonb,'text',repeat('ordinary source ',32)||case when n%1000=0 then ' raretoken' else '' end) b)q;
 select count(*),sum(stored_bytes) from app.telegram_history_messages;`);
 console.log('preexistingCorpus',psql(db,'select count(*),sum(stored_bytes) from app.telegram_history_messages;').trim());
 const start=performance.now();psql(db,readFileSync(join(dir,migration),'utf8'));console.log('migration200kWallMs',Math.round(performance.now()-start));
 console.log('backfilledRows',psql(db,'select count(*) from app.telegram_history_messages where context_sent_at is not null;').trim());
 psql(db,readFileSync(join(dir,'20261011180000_telegram_context_gin.sql'),'utf8'));
 psql(db,`insert into app.telegram_history_limits(organization_id,owner_user_id,stored_messages,stored_bytes) select '${I.ORG_A}','${I.USER_CUSTOM}',count(*),sum(stored_bytes) from app.telegram_history_messages;analyze app.telegram_history_messages;`);
 const ginPlan=psql(db,`begin;set local role app_telegram_context_indexer;select set_config('app.organization_id','${I.ORG_A}',true),set_config('app.actor_id','${I.USER_CUSTOM}',true),set_config('app.telegram_context_tsquery','raretoken',true);explain(analyze,buffers) select message_id from app.telegram_history_messages where context_sent_at is not null order by context_sent_at desc,chat_id desc,message_id desc limit 26;rollback;`);assert.match(ginPlan,/Bitmap Index Scan on telegram_context_document_gin/);console.log('nonBypassGinPlan',ginPlan);
 const searchStart=performance.now();console.log('searchResult',psql(db,`begin;set local role app_executor;select set_config('app.organization_id','${I.ORG_A}',true),set_config('app.actor_id','${I.USER_CUSTOM}',true);select jsonb_array_length(r->'results'),r->'coverage' from(select app.telegram_context_search_v1('{"action":"search","query":"raretoken"}')r)q;rollback;`));console.log('searchWallMs',Math.round(performance.now()-searchStart));
 const coveragePlan=psql(db,`begin;set local role app_executor;select set_config('app.organization_id','${I.ORG_A}',true),set_config('app.actor_id','${I.USER_CUSTOM}',true);explain(analyze,buffers) select coalesce((select stored_messages from app.telegram_history_limits),(select count(*) from app.telegram_history_messages));rollback;`);assert.match(coveragePlan,/Aggregate.*never executed/);console.log('coveragePlan',coveragePlan);
}catch(e){console.log('SCALE_FAILURE',e.message);process.exitCode=1;}finally{stopAndRemoveContainer(db);}
