import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import { POSTGRES_17_IMAGE, assertLocalTestEnvironment, psql, startPostgresContainer, stopAndRemoveContainer } from '../support/foundation-docker.js';
import { AUTHZ_ID as I, SUBJECTS, installStaffFixture, staffPoolOptions } from '../support/staff-authorization.js';
import { getTelegramDraft, updateTelegramDraft } from '../../src/lib/telegram-intake-operations.js';
import { LITERAL_BOUNDARY_RANGES, literalValueBoundary } from '../../src/lib/telegram-literal-boundaries.js';
import { telegramExtractionWorkerOperation, telegramExtractionStatus } from '../../src/lib/telegram-extraction-operations.js';
const dir=fileURLToPath(new URL('../../supabase/migrations/',import.meta.url));
const sqlJson=value=>JSON.stringify(value).replaceAll("'","''");
const message=(id,text,reply=null)=>({messageId:String(id),kind:'message',sentAt:'2026-10-11T12:00:00Z',editedAt:null,sender:{peer:{kind:'user',id:'1000'},username:'question_author',displayName:'Question author'},replyToMessageId:reply,forwardedFrom:null,text,attachments:[]});
test('opt-in bounded reply snapshots preserve source roles, receipts and disposal', {timeout:180000},async t=>{
 assertLocalTestEnvironment();const db=await startPostgresContainer('pgextractioncontext',POSTGRES_17_IMAGE,{publish:true});let pool;let staffPool;
 const priorFlag=process.env.TELEGRAM_EXTRACTION_CONTEXT_ENABLED;t.after(async()=>{await Promise.all([pool?.end(),staffPool?.end()]);stopAndRemoveContainer(db);if(priorFlag===undefined) delete process.env.TELEGRAM_EXTRACTION_CONTEXT_ENABLED;else process.env.TELEGRAM_EXTRACTION_CONTEXT_ENABLED=priorFlag;});
 for(const f of readdirSync(dir).filter(f=>f>='20260922090000_foundation_roles.sql'&&f<='20261011200000_telegram_literal_boundaries.sql'&&f.endsWith('.sql')).sort())psql(db,readFileSync(join(dir,f),'utf8'));
 const staffPassword=installStaffFixture(db);staffPool=new pg.Pool(staffPoolOptions(db,staffPassword,3));const password=randomUUID();psql(db,`create role context_worker_test login noinherit password '${password}';grant app_telegram_worker to context_worker_test;`);pool=new pg.Pool({...staffPoolOptions(db,password,3),user:'context_worker_test'});
 const token=randomBytes(48).toString('base64url'),worker=randomUUID(),connection=randomUUID(),account=randomUUID();
 const scoped=sql=>psql(db,`begin;select set_config('app.organization_id','${I.ORG_A}',true),set_config('app.actor_id','${I.USER_ADMIN2}',true);${sql}commit;`);
 scoped(`insert into app.telegram_workers(id,organization_id,owner_user_id,name,token_sha256) values('${worker}','${I.ORG_A}','${I.USER_ADMIN2}','Context',sha256(convert_to('${token}','UTF8')));insert into app.telegram_connector_workers(id,organization_id,owner_user_id,public_key_spki) values('${worker}','${I.ORG_A}','${I.USER_ADMIN2}',repeat('A',392));insert into app.telegram_connections(id,organization_id,owner_user_id,worker_id,status,auth_expires_at) values('${connection}','${I.ORG_A}','${I.USER_ADMIN2}','${worker}','disconnected',now());insert into app.telegram_history_accounts(id,organization_id,owner_user_id,connection_id,account_user_id) values('${account}','${I.ORG_A}','${I.USER_ADMIN2}','${connection}','1000');insert into app.telegram_history_limits(organization_id,owner_user_id) values('${I.ORG_A}','${I.USER_ADMIN2}');`);
 let peer=1000;
 function fixture(primaryCount=1,primaryText='I have 5 years of engineering experience.'){
 const chat=randomUUID(),origin=randomUUID(),job=randomUUID(),context=Array.from({length:10},(_,i)=>message(91+i,`Question ${i}: how many years?`)),primary=Array.from({length:primaryCount},(_,i)=>message(101+i,primaryText,'100'));
 const source=messages=>({chat:{id:chat,title:'Private context',peer:{kind:'user',id:String(++peer)},accountUserId:'1000'},messages});const rootSource=source(context),primarySource=source(primary);
 scoped(`insert into app.telegram_history_chats(id,organization_id,owner_user_id,account_id,peer_kind,peer_id,title,extraction_enabled) values('${chat}','${I.ORG_A}','${I.USER_ADMIN2}','${account}','user','${peer}','Context',true);
 insert into app.telegram_extraction_jobs(id,organization_id,owner_user_id,chat_id,source,source_digest,message_count,status,created_at) values('${origin}','${I.ORG_A}','${I.USER_ADMIN2}','${chat}','${sqlJson(rootSource)}',sha256(convert_to(('${sqlJson(rootSource)}'::jsonb)::text,'UTF8')),10,'completed',now()-interval '1 day'),('${job}','${I.ORG_A}','${I.USER_ADMIN2}','${chat}','${sqlJson(primarySource)}',sha256(convert_to(('${sqlJson(primarySource)}'::jsonb)::text,'UTF8')),${primaryCount},'queued',now());
 ${[...context,...primary].map(m=>`insert into app.telegram_history_messages(organization_id,owner_user_id,chat_id,message_id,body,stored_bytes,extraction_job_id) values('${I.ORG_A}','${I.USER_ADMIN2}','${chat}',${m.messageId},'${sqlJson(m)}',octet_length(('${sqlJson(m)}'::jsonb)::text),'${Number(m.messageId)<=100?origin:job}');insert into app.telegram_extraction_sources(organization_id,owner_user_id,chat_id,message_id,job_id) values('${I.ORG_A}','${I.USER_ADMIN2}','${chat}',${m.messageId},'${Number(m.messageId)<=100?origin:job}');`).join('\n')}
 update app.telegram_history_limits set stored_messages=(select count(*) from app.telegram_history_messages),stored_bytes=(select sum(stored_bytes) from app.telegram_history_messages);`);
 return {chat,origin,job,primary};
 }
 const call=(action,input)=>telegramExtractionWorkerOperation(pool,token,action,input);
 const caps={schemaVersions:['candidate-extraction-v1','candidate-extraction-v2']};
 const complete=job=>({jobId:job.id,leaseToken:job.leaseToken,sourceDigest:job.sourceDigest,result:{subjects:[]},metadata:{model:'fixture-model',reportedModel:null,promptVersion:job.promptVersion}});
 await t.test('default-off and old workers preserve exact v1 completion replay',async()=>{
 process.env.TELEGRAM_EXTRACTION_CONTEXT_ENABLED='false';const f=fixture();const {job}=await call('claim',caps);assert.equal(job.id,f.job);assert.equal(job.schemaVersion,'candidate-extraction-v1');assert.equal(job.source.contextOnly,undefined);const body=complete(job),receipt=await call('complete',body);assert.deepEqual(await call('complete',body),receipt);
 process.env.TELEGRAM_EXTRACTION_CONTEXT_ENABLED='true';fixture();const legacy=await call('claim',{});assert.equal(legacy.job.schemaVersion,'candidate-extraction-v1');await call('complete',complete(legacy.job));assert.deepEqual(await call('complete',body),receipt);
 });
 await t.test('forty primary messages stay unchanged; context is bounded and cannot supply subjects',async()=>{
 const f=fixture(40);const {job}=await call('claim',caps);assert.equal(job.schemaVersion,'candidate-extraction-v2');assert.equal(job.source.messages.length,40);assert.deepEqual(job.source.messages,f.primary);assert.equal(job.source.contextOnly.length,8);assert.equal(job.source.contextOnly[0].messageId,'100');assert.ok(Buffer.byteLength(JSON.stringify(job.source.contextOnly))<=8192);
 const bad=complete(job);bad.result={subjects:[{key:'context-author',identity:{kind:'telegram_sender',messageId:'100',quote:'Question 9:'},facts:[{field:'professionalSummary',value:'Question author',evidence:[{messageId:'100',quote:'Question 9:'}]}],attachments:[]}]};await assert.rejects(call('complete',bad));
 assert.throws(()=>scoped(`set local role app_executor;select app.telegram_extraction_complete_v1('${token}','${job.id}','${job.leaseToken}','${job.sourceDigest}','${sqlJson(bad.result)}','${sqlJson(bad.metadata)}');`),/Invalid extraction result/);
 await call('complete',complete(job));
 });
 await t.test('canonical context digest and ledger mismatches fence completion',async()=>{
 const f=fixture();const {job}=await call('claim',caps),body=complete(job);
 scoped(`update app.telegram_extraction_jobs set source=jsonb_set(source,'{contextOnly,0,text}','"Changed snapshot"') where id='${job.id}';`);await assert.rejects(call('complete',body),{code:'40001'});
 scoped(`update app.telegram_extraction_jobs set source='${sqlJson(job.source)}' where id='${job.id}';delete from app.telegram_extraction_context_dependencies where job_id='${job.id}' and message_id=100;`);await assert.rejects(call('complete',body),{code:'40001'});
 scoped(`update app.telegram_history_messages set body=jsonb_set(body,'{text}','"Question edited"') where chat_id='${f.chat}' and message_id=99;`);
 assert.match(scoped(`select source_invalidated_at is not null,source->'contextOnly',error_code from app.telegram_extraction_jobs where id='${job.id}';`),/t\|\[\]\|SOURCE_CHANGED/);
 });
 await t.test('context-only edits/deletes invalidate a different primary snapshot and never churn metadata-only edits',async()=>{
 for(const kind of ['edit','delete','physical-delete']){const f=fixture();const {job}=await call('claim',caps);const body=complete(job);await call('complete',body);
 scoped(`update app.telegram_history_messages set body=jsonb_set(body,'{editedAt}','"2026-10-11T13:00:00Z"') where chat_id='${f.chat}' and message_id=100;`);assert.match(scoped(`select source_invalidated_at is null from app.telegram_extraction_jobs where id='${job.id}';`),/t/);
 if(kind==='physical-delete')scoped(`delete from app.telegram_history_messages where chat_id='${f.chat}' and message_id=100;update app.telegram_history_limits set stored_messages=stored_messages-1;`);else scoped(`update app.telegram_history_messages set body='${sqlJson(kind==='delete'?{...message(100,''),kind:'unavailable',sentAt:null,sender:null,replyToMessageId:null}:message(100,'Changed question'))}' where chat_id='${f.chat}' and message_id=100;`);
 assert.match(scoped(`select source_invalidated_at is not null,source->'contextOnly',message_count from app.telegram_extraction_jobs where id='${job.id}';`),/t\|\[\]\|1/);await assert.rejects(call('complete',body),{code:'40001'});
 scoped(`update app.telegram_history_chats set extraction_enabled=false,extraction_pending=false where id='${f.chat}';`);
 }
 });
 await t.test('origin release removes copied context from pending and completed descendants without resurrection',async()=>{
 for(const finish of [false,true]){const f=fixture();const {job}=await call('claim',caps);if(finish)await call('complete',complete(job));
 const out=scoped(`set local role app_executor;update app.telegram_extraction_jobs set source_release_requested_at=now() where id='${f.origin}';select app.telegram_retention_purge_v1('${f.origin}');select count(*) from app.telegram_history_messages where chat_id='${f.chat}' and message_id<=100;select source->'contextOnly',source_invalidated_at is not null from app.telegram_extraction_jobs where id='${job.id}';`);assert.match(out,/"purged": true/);assert.match(out,/\n0\n/);assert.match(out,/\[\]\|t/);
 scoped(`set local role app_executor;select app.telegram_extraction_enqueue_v1('${f.chat}');`);const refresh=await call('claim',caps);assert.equal(refresh.job,null,'Disconnected refresh is fenced and purged context is not restored');scoped(`update app.telegram_history_chats set extraction_enabled=false,extraction_pending=false where id='${f.chat}';`);
 }
 });
 await t.test('refresh keeps original disposal origin and never restores deleted context',async()=>{
 scoped(`update app.telegram_connections set status='connected',profile=jsonb_build_object('telegramUserId','1000','username',null,'displayName','Context owner') where id='${connection}';`);
 const f=fixture();scoped(`update app.telegram_history_chats set selected=true where id='${f.chat}';`);const first=(await call('claim',caps)).job;await call('complete',complete(first));
 scoped(`update app.telegram_history_messages set body=jsonb_set(body,'{text}','"Edited context"') where chat_id='${f.chat}' and message_id=100;set local role app_executor;select app.telegram_extraction_enqueue_v1('${f.chat}');`);
 const refresh=(await call('claim',caps)).job;assert.equal(refresh.schemaVersion,'candidate-extraction-v2');assert.equal(refresh.source.contextOnly[0].text,'Edited context');await call('complete',complete(refresh));
 const origins=scoped(`select source_origin_jobs @> array['${f.job}'::uuid],source_origin_jobs @> array['${f.origin}'::uuid] from app.telegram_extraction_jobs where id='${refresh.id}';`);assert.match(origins,/t\|t/);
 const gone=scoped(`set local role app_executor;update app.telegram_extraction_jobs set source_release_requested_at=now() where id='${f.origin}';select app.telegram_retention_purge_v1('${f.origin}');select source->'contextOnly' from app.telegram_extraction_jobs where id='${refresh.id}';select app.telegram_extraction_enqueue_v1('${f.chat}');`);assert.match(gone,/"purged": true/);assert.match(gone,/\[\]/);
 const withoutContext=(await call('claim',caps)).job;assert.equal(withoutContext.schemaVersion,'candidate-extraction-v1');assert.equal(withoutContext.source.contextOnly,undefined);await call('complete',complete(withoutContext));
 const final=scoped(`set local role app_executor;update app.telegram_extraction_jobs set source_release_requested_at=now() where id='${f.job}';select app.telegram_retention_purge_v1('${f.job}');select count(*) from app.telegram_history_messages where chat_id='${f.chat}';select app.telegram_extraction_enqueue_v1('${f.chat}');`);assert.match(final,/"purged": true/);assert.match(final,/\n0\n/);
 });
 await t.test('SQL literal support rejects short codes and generic primary acknowledgements',async()=>{
 const r=scoped(`set local role app_executor;select app.telegram_context_literal_v2('Rust','ru'),app.telegram_context_literal_v2('midnight','mid'),app.telegram_context_literal_v2('business','US'),app.telegram_context_literal_v2('東京語','東京'),app.telegram_context_literal_v2('ALICE@example.test','alice@example.test'),app.telegram_context_literal_v2('Madrid.','Madrid');`);assert.match(r,/f\|f\|f\|f\|t\|t/);
 const f=fixture();const {job}=await call('claim',caps),bad=complete(job);bad.result={subjects:[{key:'generic',identity:null,facts:[{field:'professionalSummary',value:'Question 9',evidence:[{messageId:'101',quote:f.primary[0].text}]}],attachments:[]}]};await assert.rejects(call('complete',bad));assert.throws(()=>scoped(`set local role app_executor;select app.telegram_extraction_complete_v1('${token}','${job.id}','${job.leaseToken}','${job.sourceDigest}','${sqlJson(bad.result)}','${sqlJson(bad.metadata)}');`),/Invalid extraction result/);await call('complete',complete(job));
 });
 await t.test('context invalidation preserves human fields on a real generated draft',async()=>{
 const text='I am Alice Smith; email alice@example.test. I have 5 years of engineering experience.';
 const f=fixture(1,text);const {job}=await call('claim',caps),body=complete(job);
 body.result={subjects:[{key:'alice',identity:{kind:'email',email:'alice@example.test'},facts:[['firstName','Alice'],['lastName','Smith'],['primaryEmail','alice@example.test'],['professionalSummary','5 years of engineering experience']].map(([field,value])=>({field,value,evidence:[{messageId:'101',quote:text}]})),attachments:[]}]};
 const receipt=await call('complete',body);const identity={provider:'google',issuer:'https://accounts.google.com',subject:SUBJECTS.ADMIN2};const draftId=receipt.draftIds[0];assert.ok(draftId);
 const draft=await getTelegramDraft(staffPool,identity,I.ORG_A,draftId);await updateTelegramDraft(staffPool,identity,I.ORG_A,draftId,{expectedVersion:draft.version,fields:{headline:'Human reviewed headline'}});
 scoped(`update app.telegram_history_messages set body=jsonb_set(body,'{text}','"Context changed after human review"') where chat_id='${f.chat}' and message_id=100;`);
 const preserved=await getTelegramDraft(staffPool,identity,I.ORG_A,draftId);assert.equal(preserved.fields.headline,'Human reviewed headline');assert.equal(preserved.fields.firstName,undefined,'Invalidated unreviewed fields are cleared');
 scoped(`update app.telegram_history_chats set extraction_enabled=false,extraction_pending=false where id='${f.chat}';`);
 });
 await t.test('context invalidation leaves already approved candidate facts authoritative',async()=>{
 const text='I am Bob Jones; email bob@example.test. I have 5 years of engineering experience.';
 const f=fixture(1,text);const {job}=await call('claim',caps),body=complete(job);
 body.result={subjects:[{key:'bob',identity:{kind:'email',email:'bob@example.test'},facts:[['firstName','Bob'],['lastName','Jones'],['primaryEmail','bob@example.test']].map(([field,value])=>({field,value,evidence:[{messageId:'101',quote:text}]})),attachments:[]}]};
 const receipt=await call('complete',body),candidate=randomUUID(),draft=receipt.draftIds[0];
 // Seed the already-reviewed profile boundary; document approval is covered by
 // the existing extraction/retention approval suites, not simulated here.
 scoped(`insert into app.candidates(id,organization_id,full_name,professional_summary,identity_state,lifecycle) values('${candidate}','${I.ORG_A}','Bob Jones','Human approved profile','established','active');update app.telegram_drafts set status='approved',approved_candidate_id='${candidate}',fields='{}',reviewed_at=now() where id='${draft}';update app.telegram_history_messages set body=jsonb_set(body,'{text}','"Question changed after approval"') where chat_id='${f.chat}' and message_id=100;`);
 const preserved=scoped(`select full_name,professional_summary from app.candidates where id='${candidate}';select status,fields from app.telegram_drafts where id='${draft}';select source_invalidated_at is not null from app.telegram_extraction_jobs where id='${job.id}';`);assert.match(preserved,/Bob Jones\|Human approved profile/);assert.match(preserved,/approved\|\{\}/);assert.match(preserved,/\nt\n/);
 scoped(`update app.telegram_history_chats set extraction_enabled=false,extraction_pending=false where id='${f.chat}';`);
 });
 await t.test('disabled context visibly pauses unfinished v2 work without leaking owner metadata',async()=>{
 const f=fixture();const {job}=await call('claim',caps);assert.equal(job.schemaVersion,'candidate-extraction-v2');await call('fail',{jobId:job.id,leaseToken:job.leaseToken,code:'PROVIDER_UNAVAILABLE',retryAfterSeconds:1});scoped(`update app.telegram_extraction_jobs set available_at=now() where id='${job.id}';`);
 process.env.TELEGRAM_EXTRACTION_CONTEXT_ENABLED='false';assert.equal((await call('claim',caps)).job,null);await assert.rejects(call('claim',{schemaVersions:['candidate-extraction-v2']}));
 const owner={provider:'google',issuer:'https://accounts.google.com',subject:SUBJECTS.ADMIN2};const status=await telegramExtractionStatus(staffPool,owner,I.ORG_A);assert.equal(status.contextEnabled,false);assert.ok(status.jobs.length<=50);assert.equal(status.jobs.find(j=>j.id===job.id).schemaVersion,'candidate-extraction-v2');assert.equal((await telegramExtractionStatus(staffPool,owner,I.ORG_A,{jobId:job.id})).contextEnabled,false);
 const other={...owner,subject:SUBJECTS.ADMIN1};const foreign=await telegramExtractionStatus(staffPool,other,I.ORG_A);assert.ok(foreign.jobs.every(j=>j.id!==job.id));assert.equal(foreign.contextEnabled,false);
 process.env.TELEGRAM_EXTRACTION_CONTEXT_ENABLED='true';assert.equal((await call('claim',caps)).job.id,f.job);
 scoped(`update app.telegram_history_chats set extraction_enabled=false,extraction_pending=false where id='${f.chat}';`);
 });
 await t.test('deterministic SQL boundaries match pinned JS ranges regardless of C collation',async()=>{
 const points=[...new Set(LITERAL_BOUNDARY_RANGES.flatMap(([from,to])=>[from-1,from,to-1,to]).filter(cp=>cp>0&&cp<0x110000&&!(cp>=0xd800&&cp<=0xdfff)))];
 const parity=scoped(`set local role app_executor;select cp,app.telegram_context_literal_boundary_v2(chr(cp) collate "C") from unnest(array[${points.join(',')}])cp order by cp;`).split('\n').filter(v=>/^[0-9]+\|[tf]$/.test(v));assert.equal(parity.length,points.length);
 for(const row of parity){const [cp,allowed]=row.split('|');assert.equal(allowed==='t',literalValueBoundary(String.fromCodePoint(Number(cp))),`SQL/JS parity U+${Number(cp).toString(16)}`);}
 const rejected=[['東京語','東京'],['٣Alice','Alice'],['Alice٣','Alice'],['Alice²','Alice'],['ⅣAlice','Alice'],['Alice𐒠','Alice'],['e\u0301','e'],['Alice\u200d','Alice'],['Alice\u0378','Alice']];
 const accepted=['「東京」','東京、','東京。','،東京؛','東京🙂','\t東京\n','東京\u00a0'].map(q=>[q,'東京']);
 for(const [items,wanted] of [[rejected,'f'],[accepted,'t']]){const result=scoped(`set local role app_executor;select ${items.map(([q,v])=>`app.telegram_context_literal_v2('${q}' collate "C",'${v}' collate "C")`).join(',')};`);assert.ok(result.split('\n').includes(items.map(()=>wanted).join('|')));}
 });
 await t.test('runtime cannot read the dependency ledger or call internal context helpers',async()=>{
 const privileges=psql(db,"select has_table_privilege('app_staff','app.telegram_extraction_context_dependencies','select'),has_table_privilege('app_telegram_worker','app.telegram_extraction_context_dependencies','select'),has_function_privilege('app_telegram_worker','app.telegram_extraction_context_claim_v2(text,boolean)','execute'),has_table_privilege('app_executor','app.telegram_history_messages','trigger');");assert.equal(privileges.trim(),'f|f|f|f');
 const isolation=scoped(`set local role app_executor;select count(*) from app.telegram_extraction_context_dependencies;select set_config('app.actor_id','${I.USER_ADMIN1}',true);select count(*) from app.telegram_extraction_context_dependencies;select set_config('app.actor_id','${I.USER_ADMIN2}',true),set_config('app.organization_id','${I.ORG_B}',true);select count(*) from app.telegram_extraction_context_dependencies;`).split('\n').filter(v=>/^[0-9]+$/.test(v)).map(Number);assert.ok(isolation[0]>0);assert.deepEqual(isolation.slice(1),[0,0]);
 });
});
