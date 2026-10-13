import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,randomBytes,createHash,generateKeyPairSync } from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {POSTGRES_17_IMAGE,assertLocalTestEnvironment,startPostgresContainer,stopAndRemoveContainer,psql} from '../support/foundation-docker.js';
import {AUTHZ_ID,SUBJECTS,installStaffFixture,staffPoolOptions} from '../support/staff-authorization.js';
import {telegramHostedPrepare,telegramHostedStatus,telegramHostedControl,telegramHostedRetire} from '../../src/lib/telegram-hosted-operations.js';
import {registerTelegramWorker} from '../../src/lib/telegram-intake-operations.js';
import {telegramConnectionAction,telegramConnectorOperation} from '../../src/lib/telegram-connection-operations.js';
const migrations=fileURLToPath(new URL('../../supabase/migrations/',import.meta.url));
test('owner retires proven logout or explicitly revoked enrollment, freeing active capacity without losing history',async t=>{
 assertLocalTestEnvironment();const db=await startPostgresContainer('pgenrollment',POSTGRES_17_IMAGE,{publish:true});let staff,control,connector;
 t.after(async()=>{await Promise.all([staff?.end(),control?.end(),connector?.end()]);await stopAndRemoveContainer(db);});
 for(const f of readdirSync(migrations).filter(f=>f.endsWith('.sql')&&f>='20260922090000_foundation_roles.sql'&&f<='20261013150000_telegram_enrollment_lifecycle.sql').sort())psql(db,readFileSync(join(migrations,f),'utf8'));
 const password=installStaffFixture(db);staff=new pg.Pool(staffPoolOptions(db,password,4));const runtimePassword=randomUUID();
 psql(db,`create role enrollment_control login noinherit password '${runtimePassword}';grant app_telegram_hosted_service to enrollment_control;create role enrollment_worker login noinherit password '${runtimePassword}';grant app_telegram_worker to enrollment_worker;`);
 control=new pg.Pool({...staffPoolOptions(db,runtimePassword,3),user:'enrollment_control'});connector=new pg.Pool({...staffPoolOptions(db,runtimePassword,3),user:'enrollment_worker'});
 const owner={provider:'google',issuer:'https://accounts.google.com',subject:SUBJECTS.ADMIN1},other={...owner,subject:SUBJECTS.ADMIN2},service=randomUUID(),instanceId=randomUUID(),org=AUTHZ_ID.ORG_A;
 const prepare=()=>telegramHostedPrepare(staff,owner,org,service,{action:'prepare'}),status=()=>telegramHostedStatus(staff,owner,org,service);
 const leaseToken=(await telegramHostedControl(control,service,{action:'heartbeat',instanceId})).leaseToken;
 const controlCall=(action,body={})=>telegramHostedControl(control,service,{action,instanceId,leaseToken,...body});
 const retire=(input,identity=owner)=>telegramHostedRetire(staff,identity,org,service,input);
 const key=generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'der'}).toString('base64');
 async function register(){const s=await prepare(),requestId=s.enrollment.requestId,workerId=randomUUID(),token=randomBytes(48).toString('base64url');await controlCall('register',{requestId,workerId,tokenSha256:createHash('sha256').update(token).digest('hex')});await telegramConnectorOperation(connector,token,'heartbeat',{publicKeySpki:key});return{requestId,workerId,token};}
 const retirement=(e,telegramRevoked=false)=>({action:'retire',operationId:randomUUID(),requestId:e.requestId,expectedWorkerId:e.workerId,telegramRevoked});
 await t.test('unregistered enrollment retires safely and stale retries cannot retire replacement',async()=>{
  const s=await prepare(),input={action:'retire',operationId:randomUUID(),requestId:s.enrollment.requestId,expectedWorkerId:null,telegramRevoked:false};assert.equal(s.enrollment.retirementMode,'safe');
  const receipt=await retire(input);assert.equal(receipt.retirementReason,'never_registered');
  const replacement=await prepare();assert.notEqual(replacement.enrollment.requestId,input.requestId);assert.deepEqual(await retire(input),receipt);assert.equal((await status()).enrollment.requestId,replacement.enrollment.requestId);
  await assert.rejects(retire({...input,telegramRevoked:true}),{code:'40001'});
  await retire({action:'retire',operationId:randomUUID(),requestId:replacement.enrollment.requestId,expectedWorkerId:null,telegramRevoked:false});
 });
 let old,newer,connection,historyChat;
 await t.test('uncertain live enrollment requires attestation; nonowner and stale worker identity are denied',async()=>{
  old=await register();await telegramConnectionAction(staff,owner,org,{action:'connect',workerId:old.workerId});
  connection=(await telegramConnectorOperation(connector,old.token,'claim',{}));
  await telegramConnectorOperation(connector,old.token,'update',{connectionId:connection.id,generation:connection.generation,leaseToken:connection.leaseToken,status:'connected',profile:{telegramUserId:'123456789',displayName:'Synthetic Owner'}});
  assert.equal((await status()).enrollment.retirementMode,'external_revocation_required');
  await assert.rejects(retire(retirement(old)),{code:'55000'});await assert.rejects(retire(retirement(old,true),other),{code:'P0002'});
  await assert.rejects(retire({...retirement(old,true),expectedWorkerId:randomUUID()}),{code:'40001'});
  assert.equal((await status()).workerId,old.workerId);
 });
 await t.test('external attestation revokes old token and fences late generation, preserving imported records',async()=>{
  const account=randomUUID();historyChat=randomUUID();
  psql(db,`insert into app.telegram_history_accounts(id,organization_id,owner_user_id,connection_id,account_user_id) values('${account}','${org}','${AUTHZ_ID.USER_ADMIN1}','${connection.id}','123456789');
   insert into app.telegram_history_chats(id,organization_id,owner_user_id,account_id,peer_kind,peer_id,title) values('${historyChat}','${org}','${AUTHZ_ID.USER_ADMIN1}','${account}','user','123','Synthetic');
   insert into app.telegram_history_messages(organization_id,owner_user_id,chat_id,message_id,body,stored_bytes) values('${org}','${AUTHZ_ID.USER_ADMIN1}','${historyChat}',1,'{"text":"retained synthetic history"}',64);`);
  const input=retirement(old,true),receipt=await retire(input);assert.equal(receipt.retirementReason,'external_revocation_attested');assert.deepEqual(await retire(input),receipt);
  await assert.rejects(telegramConnectorOperation(connector,old.token,'claim',{}),{code:'42501'});
  await assert.rejects(telegramConnectorOperation(connector,old.token,'update',{connectionId:connection.id,generation:connection.generation,leaseToken:connection.leaseToken,status:'connected',profile:{telegramUserId:'123456789',displayName:'Late'}}),{code:'42501'});
  assert.equal(psql(db,`select count(*) from app.telegram_history_messages where chat_id='${historyChat}'`).trim(),'1');
  assert.equal((await controlCall('list')).requests.some(r=>r.requestId===old.requestId),false);
  await assert.rejects(controlCall('register',{requestId:old.requestId,workerId:old.workerId,tokenSha256:createHash('sha256').update(old.token).digest('hex')}),{code:'P0002'});
  newer=await register();assert.notEqual(newer.workerId,old.workerId);assert.notEqual(newer.requestId,old.requestId);
  await assert.rejects(telegramConnectorOperation(connector,old.token,'heartbeat',{publicKeySpki:key}),{code:'42501'});
  psql(db,`update app.telegram_workers set revoked_at=null where id='${old.workerId}'`);
  await assert.rejects(telegramConnectorOperation(connector,old.token,'claim',{}),{code:'42501'});
  psql(db,`update app.telegram_workers w set revoked_at=r.retired_at from app.telegram_hosted_requests r where r.worker_id=w.id and w.id='${old.workerId}'`);
  await telegramConnectionAction(staff,owner,org,{action:'connect',workerId:newer.workerId});
  const fresh=(await telegramConnectorOperation(connector,newer.token,'claim',{}));assert.ok(fresh.generation>connection.generation);
  const conn=await telegramConnectionAction(staff,owner,org,{action:'disconnect',connectionId:fresh.id,generation:fresh.generation});assert.equal(conn.connection.retirementReason,null);
 });
 await t.test('acknowledged remote logout retires without external attestation and old rows retain evidence',async()=>{
  const task=(await telegramConnectorOperation(connector,newer.token,'claim',{}));
  await telegramConnectorOperation(connector,newer.token,'update',{connectionId:task.id,generation:task.generation,leaseToken:task.leaseToken,status:'disconnected'});
  const physical=await registerTelegramWorker(staff,owner,org,'Synthetic alternate local connector');
  await telegramConnectorOperation(connector,physical.token,'heartbeat',{publicKeySpki:key});
  const physicalStart=await telegramConnectionAction(staff,owner,org,{action:'connect',workerId:physical.id});
  assert.equal((await status()).enrollment.retirementMode,'safe');const result=await retire(retirement(newer));assert.equal(result.retirementReason,'remote_logout');
  assert.equal(psql(db,`select worker_id from app.telegram_connections where id='${physicalStart.connection.id}'`).trim(),physical.id);
  await telegramConnectionAction(staff,owner,org,{action:'disconnect',connectionId:physicalStart.connection.id,generation:physicalStart.connection.generation});
  assert.equal(psql(db,`select retired_by::text||':'||retired_reason from app.telegram_hosted_requests where id='${newer.requestId}'`).trim(),`${AUTHZ_ID.USER_ADMIN1}:remote_logout`);
 });
 await t.test('cancel before first claim is safe and preserves cancellation wording',async()=>{
  const fresh=await register();const started=await telegramConnectionAction(staff,owner,org,{action:'connect',workerId:fresh.workerId});
  const cancelled=await telegramConnectionAction(staff,owner,org,{action:'disconnect',connectionId:started.connection.id,generation:started.connection.generation});assert.equal(cancelled.connection.cancelledBeforeStart,true);
  assert.equal((await status()).enrollment.retirementMode,'safe');const receipt=await retire(retirement(fresh));assert.equal(receipt.retirementReason,'cancelled_before_start');
  assert.equal(psql(db,`select cancelled_before_start from app.telegram_connections where worker_id='${fresh.workerId}'`).trim(),'t');
 });
 await t.test('ten active owners cap excludes retired rows and retirement frees one slot',async()=>{
  const current=await prepare();
  for(let n=0;n<9;n++){const user=randomUUID(),member=randomUUID();psql(db,`insert into app.users(id,display_name,status) values('${user}','Capacity Fixture','active');insert into app.organization_memberships(id,organization_id,user_id,role_id,status,activated_at) values('${member}','${org}','${user}','${AUTHZ_ID.ROLE_A_ADMIN}','active',now());insert into app.telegram_hosted_requests(service_id,organization_id,owner_user_id) values('${service}','${org}','${user}');`);}
  assert.equal((await controlCall('list')).requests.length,10);await assert.rejects(telegramHostedPrepare(staff,other,org,service,{action:'prepare'}),{code:'53300'});
  await retire({action:'retire',operationId:randomUUID(),requestId:current.enrollment.requestId,expectedWorkerId:null,telegramRevoked:false});
  await telegramHostedPrepare(staff,other,org,service,{action:'prepare'});assert.equal((await controlCall('sync')).requests.length,10);
  assert.ok(Number(psql(db,`select count(*) from app.telegram_hosted_requests where service_id='${service}'`).trim())>10);
  assert.equal(psql(db,`select count(*) from app.telegram_history_messages where chat_id='${historyChat}'`).trim(),'1');
 });
});
