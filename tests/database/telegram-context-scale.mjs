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
 console.log(psql(db,`analyze app.telegram_history_messages;set role app_executor;select set_config('app.organization_id','${I.ORG_A}',false),set_config('app.actor_id','${I.USER_CUSTOM}',false);
 explain(analyze,buffers) select m.message_id from app.telegram_history_messages m join app.telegram_history_chats c on c.id=m.chat_id where m.context_document @@ websearch_to_tsquery('simple','raretoken') and m.context_sent_at is not null order by m.context_sent_at desc,m.chat_id desc,m.message_id desc limit26;`.replace('limit26','limit 26')));
 console.log(psql(db,`set role app_executor;select set_config('app.organization_id','${I.ORG_A}',false),set_config('app.actor_id','${I.USER_CUSTOM}',false);explain(analyze,buffers) select count(*) from app.telegram_history_messages;`));
}catch(e){console.log('SCALE_FAILURE',e.message);process.exitCode=1;}finally{stopAndRemoveContainer(db);}
