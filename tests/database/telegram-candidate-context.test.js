import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes,randomUUID} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import pg from 'pg';
import {POSTGRES_17_IMAGE,assertLocalTestEnvironment,psql,startPostgresContainer,stopAndRemoveContainer} from '../support/foundation-docker.js';
import {AUTHZ_ID,installStaffFixture,staffPoolOptions} from '../support/staff-authorization.js';
import {CJ_SUBJECTS,clientJobFixtureSql} from '../support/client-job-workflows.js';
import {withStaffTransaction} from '../../src/lib/staff-authorization.js';
import {telegramExtractionAction,telegramExtractionWorkerOperation} from '../../src/lib/telegram-extraction-operations.js';
import {getTelegramDraft,decideTelegramDraft} from '../../src/lib/telegram-intake-operations.js';
import {mergeCandidateDuplicates} from '../../src/lib/duplicate-review-operations.js';
import {telegramCandidateContext} from '../../src/lib/telegram-candidate-context-operations.js';
const dir=fileURLToPath(new URL('../../supabase/migrations/',import.meta.url));
const identity=subject=>({provider:'google',issuer:'https://accounts.google.com',subject});
const quote=text=>`'${text.replaceAll("'","''")}'`;
const message=(id,text)=>({messageId:String(id),kind:'message',sentAt:'2026-10-11T12:00:00.000Z',editedAt:null,sender:{peer:{kind:'user',id:'777'},username:'bob',displayName:'Private Sender'},replyToMessageId:null,forwardedFrom:null,text,attachments:[]});
test('candidate Telegram provenance survives approval, late results, merge and retention privately',{timeout:120000},async t=>{
 assertLocalTestEnvironment();const db=await startPostgresContainer('pgtelegramcandidatecontext',POSTGRES_17_IMAGE,{publish:true});let pool,workers,maintenance;
 t.after(async()=>{await Promise.all([pool?.end(),workers?.end(),maintenance?.end()]);stopAndRemoveContainer(db);});
 for(const f of readdirSync(dir).filter(f=>f>='20260922090000_foundation_roles.sql'&&f<'20261011150000_telegram_candidate_context.sql'&&f.endsWith('.sql')).sort())psql(db,readFileSync(join(dir,f),'utf8'));
 const password=installStaffFixture(db);psql(db,clientJobFixtureSql);pool=new pg.Pool(staffPoolOptions(db,password,4));
 const org=AUTHZ_ID.ORG_B,owner=identity(CJ_SUBJECTS.ADMIN),other=identity(CJ_SUBJECTS.RECRUITER);
 const staff=(sql,args=[],who=owner)=>withStaffTransaction(pool,who,org,['candidates.read','candidates.write'],async({client})=>(await client.query(sql,args)).rows[0]?.result);
 const user=await staff("select app.context_uuid_v1('app.actor_id') result");
 const token=randomBytes(48).toString('base64url');const worker=await staff('select app.telegram_register_worker_v1($1,$2) result',['Synthetic',token]);
 const workerPassword=randomUUID();psql(db,`create role provenance_worker login noinherit nobypassrls password '${workerPassword}';grant app_telegram_worker to provenance_worker;`);workers=new pg.Pool({...staffPoolOptions(db,workerPassword,2),user:'provenance_worker'});
 const connection=randomUUID(),account=randomUUID(),chat=randomUUID();const publicKey=generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({format:'der',type:'spki'}).toString('base64');
 psql(db,`insert into app.telegram_connector_workers(id,organization_id,owner_user_id,public_key_spki) values('${worker.id}','${org}','${user}','${publicKey}');
 insert into app.telegram_connections(id,organization_id,owner_user_id,worker_id,status,auth_expires_at) values('${connection}','${org}','${user}','${worker.id}','disconnected',now());
 insert into app.telegram_history_accounts(id,organization_id,owner_user_id,connection_id,account_user_id) values('${account}','${org}','${user}','${connection}','999');
 insert into app.telegram_history_limits(organization_id,owner_user_id) values('${org}','${user}');
 insert into app.telegram_history_chats(id,organization_id,owner_user_id,account_id,peer_kind,peer_id,title) values('${chat}','${org}','${user}','${account}','user','777','Private chat title');`);
 const insert=records=>{psql(db,records.map(m=>`insert into app.telegram_history_messages(organization_id,owner_user_id,chat_id,message_id,body,stored_bytes) values('${org}','${user}','${chat}',${m.messageId},${quote(JSON.stringify(m))},octet_length(${quote(JSON.stringify(m))}::jsonb::text));`).join('\n'));psql(db,`update app.telegram_history_limits set stored_messages=(select count(*) from app.telegram_history_messages),stored_bytes=(select sum(stored_bytes) from app.telegram_history_messages) where owner_user_id='${user}';`);};
 const action=p=>telegramExtractionAction(pool,owner,org,p);
 const call=(action,p={})=>telegramExtractionWorkerOperation(workers,token,action,p);
 const subject=(m,email,fields,key='person')=>({key,identity:{kind:'email',email},facts:Object.entries(fields).map(([field,value])=>({field,value,evidence:[{messageId:m.messageId,quote:m.text}]})),attachments:[]});
 const finish=(job,subjects)=>call('complete',{jobId:job.id,leaseToken:job.leaseToken,sourceDigest:job.sourceDigest,result:{subjects},metadata:{model:'synthetic-demo',promptVersion:'candidate-extraction-prompt-v1',reportedModel:null}});
 const approve=async id=>{let d=await getTelegramDraft(pool,owner,org,id);const target=await staff('select app.telegram_cv_target_v1($1) result',[id]);const doc={filename:'Reviewed CV.pdf',sha256:'a'.repeat(64),sizeBytes:500,extension:'pdf',mimeType:'application/pdf',objectKey:`staff/${org}/${target}/${randomUUID()}.pdf`};await staff('select app.telegram_reserve_upload_v1($1,$2,$3) result',[id,d.version,doc.objectKey]);d=await staff('select app.telegram_attach_cv_v1($1,$2,$3::jsonb) result',[id,d.version,JSON.stringify(doc)]);return decideTelegramDraft(pool,owner,org,id,{expectedVersion:d.version,action:'approve',operationId:randomUUID()});};
 const bob=message(1,'Bob Smith bob@example.test engineering.'),alice=message(2,'Alice Other alice@example.test unrelated.'),irrelevant=message(3,'Unrelated client discussion');insert([bob,alice,irrelevant]);await action({action:'enqueue',chatIds:[chat]});const firstJob=(await call('claim')).job;
 const receipt=await finish(firstJob,[subject(bob,'bob@example.test',{firstName:'Bob',lastName:'Smith',primaryEmail:'bob@example.test'}),subject(alice,'alice@example.test',{firstName:'Alice',lastName:'Other',primaryEmail:'alice@example.test'},'other')]);
 const draft=receipt.draftIds[0],candidate=(await approve(draft)).candidateId;
 const lostDraft=randomUUID();await staff('select app.telegram_create_draft_v1($1,$2::jsonb,$3) result',[lostDraft,JSON.stringify({firstName:'Lost',lastName:'Origin',primaryEmail:'lost@example.test'}),'Prior source no longer retained']);const lostCandidate=(await approve(lostDraft)).candidateId;
 // Install over an already approved candidate: only its exact surviving refs backfill.
 psql(db,readFileSync(join(dir,'20261011150000_telegram_candidate_context.sql'),'utf8'));
 let canonicalTarget=candidate;
 const read=(id=candidate,after=null,who=owner)=>telegramCandidateContext(pool,who,org,id,after);
 await t.test('backfill preserves exact subject identity, never the entire batch',async()=>{const r=await read();assert.equal(r.sources.length,1);assert.equal(r.sources[0].messageId,'1');assert.equal(r.sources[0].available,true);assert.equal(r.provenanceUnavailable,false);assert.equal(r.sources[0].sourceChanged,false);assert.ok(!JSON.stringify(r).includes('Private'));});
 await t.test('a prior approved source with no exact surviving references stays explicitly unavailable',async()=>{
 assert.deepEqual(await read(lostCandidate),{sources:[],nextAfter:null,provenanceUnavailable:true});assert.deepEqual(await read(lostCandidate,null,other),{sources:[],nextAfter:null,provenanceUnavailable:false});
 const deletionRules=psql(db,"select distinct confdeltype from pg_constraint where contype='f' and conrelid in('app.telegram_candidate_origins'::regclass,'app.telegram_candidate_context_refs'::regclass);").trim();assert.equal(deletionRules,'c','No new reference foreign key blocks parent erasure');
 });
 await t.test('approval and late approved results capture identifiers before cleanup',async()=>{
 const approvedOther=(await approve(receipt.draftIds[1])).candidateId;assert.equal((await read(approvedOther)).sources[0].messageId,'2');
 const late=message(4,'Bob Smith bob@example.test remote engineering');insert([late]);const job=(await call('claim')).job;await finish(job,[subject(late,'bob@example.test',{primaryEmail:'bob@example.test',headline:'remote engineering'})]);
 const r=await read();assert.deepEqual(new Set(r.sources.map(s=>s.messageId)),new Set(['1','4']));
 });
 await t.test('candidate readership never grants another owner private metadata or table access',async()=>{
 assert.deepEqual(await read(candidate,null,other),{sources:[],nextAfter:null,provenanceUnavailable:false});
 await withStaffTransaction(pool,owner,org,['candidates.read'],async({client})=>{await assert.rejects(client.query('select * from app.telegram_candidate_context_refs'),{code:'42501'});});
 await assert.rejects(telegramCandidateContext(pool,owner,AUTHZ_ID.ORG_A,candidate),{code:'P0002'});
 const own=await read();await assert.rejects(read(candidate,own.sources[0].id,other),{code:'22023'});
 });
 await t.test('source invalidation warns on the original job without claiming changed approved facts',async()=>{
 psql(db,`alter table app.telegram_extraction_jobs add column if not exists source_invalidated_at timestamptz;update app.telegram_extraction_jobs set source_invalidated_at=now() where id='${firstJob.id}';`);
 const r=await read();assert.equal(r.sources.find(s=>s.messageId==='1').sourceChanged,true);assert.equal(r.sources.find(s=>s.messageId==='1').available,true);assert.deepEqual(await read(),r);
 });
 await t.test('source identity remains stable when candidate sources move during a merge',async()=>{
 const target=randomUUID();canonicalTarget=target;await staff('select app.save_candidate_profile_v1($1,null,$2::jsonb,$3,$4) result',[target,JSON.stringify({fullName:'Canonical Target',email:'canonical@example.test',professionalUrl:null,headline:null,location:null,professionalSummary:null,ownerMembershipId:null}),randomUUID(),randomUUID()]);
 const review=randomUUID(),[a,b]=[candidate,target].sort();
 psql(db,`insert into app.role_permissions(organization_id,role_id,permission_key) values('${org}','${AUTHZ_ID.ROLE_B_ADMIN}','candidates.merge'),('${org}','${AUTHZ_ID.ROLE_B_ADMIN}','duplicates.review') on conflict do nothing;insert into app.candidate_duplicate_reviews(id,organization_id,candidate_a_id,candidate_b_id) values('${review}','${org}','${a}','${b}');`);
 const targetVersion=Number(psql(db,`select version from app.candidates where id='${target}';`).trim()),sourceVersion=Number(psql(db,`select version from app.candidates where id='${candidate}';`).trim());
 await mergeCandidateDuplicates(pool,owner,org,{reviewId:review,expectedVersion:1,targetCandidateId:target,expectedTargetVersion:targetVersion,expectedSourceVersion:sourceVersion,primaryEmail:'canonical@example.test'});
 assert.equal((await read(target)).sources.length,2);assert.deepEqual(await read(candidate),await read(target));assert.equal((await read(target)).sources.find(s=>s.messageId==='1').sourceChanged,true);
 });
 await t.test('provenance pages are bounded and cursors cannot select an unrelated candidate',async()=>{
 const parts=[Array.from({length:30},(_,i)=>message(1000+i,'Synthetic attachment context')),Array.from({length:25},(_,i)=>message(1030+i,'Synthetic attachment context'))];
 for(const records of parts){const job=randomUUID();insert(records);const source=JSON.stringify({chat:{id:chat,title:'Private chat title',peer:{kind:'user',id:'777'},accountUserId:'999'},messages:records});
 psql(db,`insert into app.telegram_extraction_jobs(id,organization_id,owner_user_id,chat_id,source,source_digest,message_count,status) values('${job}','${org}','${user}','${chat}',${quote(source)},sha256('synthetic'),${records.length},'completed');
 select set_config('app.organization_id','${org}',false),set_config('app.actor_id','${user}',false);`+records.map(m=>`insert into app.telegram_extraction_sources(organization_id,owner_user_id,chat_id,message_id,job_id) values('${org}','${user}','${chat}',${m.messageId},'${job}');insert into app.telegram_extraction_attachments(organization_id,owner_user_id,job_id,draft_id,message_id,attachment_index,metadata) values('${org}','${user}','${job}','${draft}','${m.messageId}',0,'{}');`).join('\n'));}
 const first=await read();assert.equal(first.sources.length,50);assert.ok(first.nextAfter);const second=await read(candidate,first.nextAfter);assert.equal(second.sources.length,7);assert.equal(second.nextAfter,null);assert.equal(new Set([...first.sources,...second.sources].map(s=>s.id)).size,57);
 await assert.rejects(read(randomUUID(),first.nextAfter),{code:'P0002'});
 });
 await t.test('retention removes raw source but preserves minimal private anchors',async()=>{
 await action({action:'sourceRetention',jobId:firstJob.id,expectedSourceVersion:1,mode:'release_after_review'});
 const mp=randomUUID();psql(db,`create role provenance_maintenance login noinherit nobypassrls password '${mp}';grant app_telegram_maintenance to provenance_maintenance;`);maintenance=new pg.Pool({...staffPoolOptions(db,mp,1),user:'provenance_maintenance'});
 const c=await maintenance.connect();try{await c.query('begin;set local role app_telegram_maintenance');const result=(await c.query('select app.telegram_maintenance_v1() result')).rows[0].result;await c.query('commit');assert.equal(result.batchesPurged,1);}finally{c.release();}
 const r=await read();const second=r.nextAfter?await read(candidate,r.nextAfter):{sources:[]};const rows=[...r.sources,...second.sources];assert.equal(rows.find(s=>s.messageId==='1').available,false);assert.equal(rows.find(s=>s.messageId==='1').sourceChanged,true);assert.equal(rows.length,57);assert.ok(!JSON.stringify(r).includes('Bob'));
 });
 await t.test('terminal subject erasure deletes private origins and references without blocking lifecycle',async()=>{
 psql(db,`select set_config('app.organization_id','${org}',false),set_config('app.actor_id','${user}',false);update app.candidates set lifecycle='deleting' where id='${canonicalTarget}';`);
 assert.equal(psql(db,`select count(*) from app.telegram_candidate_context_refs where draft_id='${draft}';`).trim(),'0');assert.equal(psql(db,`select count(*) from app.telegram_candidate_origins where draft_id='${draft}';`).trim(),'0');await assert.rejects(read(canonicalTarget),{code:'P0002'});
 });
});
