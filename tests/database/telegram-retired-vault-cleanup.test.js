import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync,readFileSync,readdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {POSTGRES_17_IMAGE,assertLocalTestEnvironment,startPostgresContainer,stopAndRemoveContainer,psql} from '../support/foundation-docker.js';
import {AUTHZ_ID,SUBJECTS,installStaffFixture,staffPoolOptions} from '../support/staff-authorization.js';
import {withStaffTransaction} from '../../src/lib/staff-authorization.js';
import {telegramHostedPrepare,telegramHostedControl,telegramHostedRetire} from '../../src/lib/telegram-hosted-operations.js';
import {telegramConnectionAction,telegramConnectorOperation} from '../../src/lib/telegram-connection-operations.js';
import {createServiceStore} from '../../services/telegram-hosted/store.mjs';
import {createVault} from '../../services/telegram-connector/vault.mjs';
const migrationDir=fileURLToPath(new URL('../../supabase/migrations/',import.meta.url));
test('retired-vault proof completes only its real old scope, gates future removals, and preserves current vault/history',async t=>{
 assertLocalTestEnvironment();const db=await startPostgresContainer('pgretiredvault',POSTGRES_17_IMAGE,{publish:true});let staff,control,connector;
 const root=mkdtempSync(join(realpathSync(tmpdir()),'retired-proof-'));t.after(async()=>{await Promise.all([staff?.end(),control?.end(),connector?.end()]);await stopAndRemoveContainer(db);rmSync(root,{recursive:true,force:true});});
 for(const file of readdirSync(migrationDir).filter(f=>f.endsWith('.sql')&&f>='20260922090000'&&f<'20261013170000_telegram_retired_vault_cleanup.sql').sort())psql(db,readFileSync(join(migrationDir,file),'utf8'));
 const password=installStaffFixture(db),runtimePassword=randomUUID();staff=new pg.Pool(staffPoolOptions(db,password,4));
 psql(db,`create role retired_control login noinherit password '${runtimePassword}';grant app_telegram_hosted_service to retired_control;create role retired_worker login noinherit password '${runtimePassword}';grant app_telegram_worker to retired_worker;`);
 control=new pg.Pool({...staffPoolOptions(db,runtimePassword,3),user:'retired_control'});connector=new pg.Pool({...staffPoolOptions(db,runtimePassword,3),user:'retired_worker'});
 const org=AUTHZ_ID.ORG_A,user=AUTHZ_ID.USER_ADMIN1,owner={provider:'google',issuer:'https://accounts.google.com',subject:SUBJECTS.ADMIN1},service=randomUUID(),instanceId=randomUUID();
 const store=createServiceStore({stateDirectory:root,serviceId:service,server:'https://synthetic.test'});
 const leaseToken=(await telegramHostedControl(control,service,{action:'heartbeat',instanceId})).leaseToken;
 const command=(action,extra={})=>telegramHostedControl(control,service,{action,instanceId,leaseToken,...extra});
 const privateQuery=(sql,args)=>withStaffTransaction(staff,owner,org,['candidates.read','candidates.write'],async({client})=>(await client.query(sql,args)).rows[0].result);
 const key=generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'der'}).toString('base64');
 async function enrollment(){const status=await telegramHostedPrepare(staff,owner,org,service,{action:'prepare'}),row={requestId:status.enrollment.requestId,organizationId:org,ownerUserId:user,workerId:null,tokenSha256:null,state:'pending',canRun:true};const prepared=store.prepare(row,{apiId:1,apiHash:'a'.repeat(32)}),record={...prepared,token:JSON.parse(readFileSync(prepared.configPath,'utf8')).token};await command('register',{requestId:row.requestId,workerId:record.workerId,tokenSha256:record.tokenSha256});await telegramConnectorOperation(connector,record.token,'heartbeat',{publicKeySpki:key});return{record,row:{...row,workerId:record.workerId}};}
 async function connect(e){await telegramConnectionAction(staff,owner,org,{action:'connect',workerId:e.record.workerId});const task=await telegramConnectorOperation(connector,e.record.token,'claim',{});await telegramConnectorOperation(connector,e.record.token,'update',{connectionId:task.id,generation:task.generation,leaseToken:task.leaseToken,status:'connected',profile:{telegramUserId:'123456',displayName:'Synthetic'}});return task;}
 const retire=e=>telegramHostedRetire(staff,owner,org,service,{action:'retire',operationId:randomUUID(),requestId:e.row.requestId,expectedWorkerId:e.record.workerId,telegramRevoked:true});
 const old=await enrollment(),task=await connect(old),account=randomUUID(),target=randomUUID(),unrelated=randomUUID();
 psql(db,`set app.organization_id='${org}';set app.actor_id='${user}';insert into app.telegram_history_limits(organization_id,owner_user_id,stored_messages,stored_bytes) values('${org}','${user}',2,128);
  insert into app.telegram_history_accounts(id,organization_id,owner_user_id,connection_id,account_user_id) values('${account}','${org}','${user}','${task.id}','123456');
  insert into app.telegram_history_chats(id,organization_id,owner_user_id,account_id,peer_kind,peer_id,title,history_completed) values('${target}','${org}','${user}','${account}','user','11','Remove',true),('${unrelated}','${org}','${user}','${account}','user','22','Keep',true);
  insert into app.telegram_history_messages(organization_id,owner_user_id,chat_id,message_id,body,stored_bytes) values('${org}','${user}','${target}',1,'{"text":"remove"}',64),('${org}','${user}','${unrelated}',1,'{"text":"preserve"}',64);`);
 const requestRemoval=async chat=>{const version=Number(psql(db,`select version from app.telegram_history_chats where id='${chat}'`).trim());const result=await privateQuery('select app.telegram_chat_removal_request_v1($1,$2,$3,$4) result',[chat,version,randomUUID(),'remove_imported_history']);psql(db,'select app.telegram_chat_removal_maintenance_v1(5)');return result;};
 await requestRemoval(target);await retire(old);
 const backfillChat=randomUUID(),reimportedChat=randomUUID();
 psql(db,`set app.organization_id='${org}';set app.actor_id='${user}';
  insert into app.telegram_history_chats(id,organization_id,owner_user_id,account_id,peer_kind,peer_id,title,removal_state) values('${backfillChat}','${org}','${user}','${account}','user','44','Old completed removal','completed'),('${reimportedChat}','${org}','${user}','${account}','user','55','Fresh reimport','none');
  insert into app.telegram_chat_removals(organization_id,owner_user_id,chat_id,operation_id,expected_version,total_messages,total_bytes,server_purged_at,device_cleanup_at,completed_at,cleanup_worker_id) values('${org}','${user}','${backfillChat}',gen_random_uuid(),1,0,0,now(),now(),now(),'${old.record.workerId}');
  insert into app.telegram_chat_removals(organization_id,owner_user_id,chat_id,operation_id,expected_version,total_messages,total_bytes,server_purged_at,device_cleanup_at,completed_at,cleanup_worker_id,reimport_receipt) values('${org}','${user}','${reimportedChat}',gen_random_uuid(),1,0,0,now(),now(),now(),'${old.record.workerId}','{"state":"reimport_requested"}');`);
 psql(db,readFileSync(join(migrationDir,'20261013170000_telegram_retired_vault_cleanup.sql'),'utf8'));
 await t.test('migration reopens only still-removed chats with unknown retired caches',async()=>{
  assert.equal(psql(db,`select removal_state from app.telegram_history_chats where id='${backfillChat}'`).trim(),'device_pending');
  assert.equal(psql(db,`select primary_device_cleanup_at is not null and device_cleanup_at is null and completed_at is null from app.telegram_chat_removals where chat_id='${backfillChat}'`).trim(),'t');
  assert.equal(psql(db,`select removal_state from app.telegram_history_chats where id='${reimportedChat}'`).trim(),'none');
  assert.equal(psql(db,`select completed_at is not null from app.telegram_chat_removals where chat_id='${reimportedChat}'`).trim(),'t');
 });
 const fresh=await enrollment();await connect(fresh);
 const freshVault=createVault({root:fresh.record.stateDirectory,server:'https://synthetic.test',workerId:fresh.record.workerId});freshVault.save(task.id,{generation:1,state:'connected',session:'preserve-active'});
 const oldVault=createVault({root:old.record.stateDirectory,server:'https://synthetic.test',workerId:old.record.workerId});oldVault.save(task.id,{generation:1,state:'connected',session:'old-private-cache'});
 await t.test('new worker cannot replace old device ACK; only authorized old-vault proof completes it',async()=>{
  assert.equal((await telegramConnectorOperation(connector,fresh.record.token,'cleanupClaim',{})).cleanup,null);
  assert.equal(psql(db,`select device_cleanup_at is null from app.telegram_chat_removals where chat_id='${target}'`).trim(),'t');
  const claim=await command('retiredCleanupClaim');assert.equal(claim.requests.length,1);const row=claim.requests[0];assert.equal(row.workerId,old.record.workerId);
  await assert.rejects(command('retiredCleanupAck',{requestId:row.requestId,workerId:fresh.record.workerId,cleanupToken:row.cleanupToken}),{code:'40001'});
  await store.eraseRetired(row);assert.equal(existsSync(join(root,'workers',row.requestId)),false);
  assert.deepEqual(await command('retiredCleanupAck',{requestId:row.requestId,workerId:row.workerId,cleanupToken:row.cleanupToken}),{ok:true});
  assert.equal(psql(db,`select removal_state from app.telegram_history_chats where id='${target}'`).trim(),'completed');
  assert.equal(freshVault.load(task.id).session,'preserve-active');assert.equal(psql(db,`select count(*) from app.telegram_history_messages where chat_id='${unrelated}'`).trim(),'1');
 });
 await t.test('future removal of a new worker scope remains pending until its own primary ACK',async()=>{
  await requestRemoval(unrelated);const claim=await telegramConnectorOperation(connector,fresh.record.token,'cleanupClaim',{});assert.equal(claim.cleanup.chatId,unrelated);
  const prior=(await command('retiredCleanupClaim')).requests;assert.equal(prior.length,0);
  assert.equal(psql(db,`select device_cleanup_at is null from app.telegram_chat_removals where chat_id='${unrelated}'`).trim(),'t');
  await telegramConnectorOperation(connector,fresh.record.token,'cleanupAck',{removalId:claim.cleanup.removalId,cleanupToken:claim.cleanup.cleanupToken});assert.equal(psql(db,`select removal_state from app.telegram_history_chats where id='${unrelated}'`).trim(),'completed');
 });
 await t.test('primary ACK does not loop or complete while another retired vault still has an obligation',async()=>{
  await retire(fresh);const newest=await enrollment();await connect(newest);const chat=randomUUID();
  psql(db,`set app.organization_id='${org}';set app.actor_id='${user}';insert into app.telegram_history_chats(id,organization_id,owner_user_id,account_id,peer_kind,peer_id,title) values('${chat}','${org}','${user}','${account}','user','33','Pending old scope');`);
  await requestRemoval(chat);const primary=await telegramConnectorOperation(connector,newest.record.token,'cleanupClaim',{});await telegramConnectorOperation(connector,newest.record.token,'cleanupAck',{removalId:primary.cleanup.removalId,cleanupToken:primary.cleanup.cleanupToken});
  assert.equal(psql(db,`select primary_device_cleanup_at is not null and device_cleanup_at is null from app.telegram_chat_removals where chat_id='${chat}'`).trim(),'t');
  assert.equal((await telegramConnectorOperation(connector,newest.record.token,'cleanupClaim',{})).cleanup,null);
  const row=(await command('retiredCleanupClaim')).requests.find(row=>row.workerId===fresh.record.workerId);await store.eraseRetired(row);await command('retiredCleanupAck',{requestId:row.requestId,workerId:row.workerId,cleanupToken:row.cleanupToken});
  assert.equal(psql(db,`select removal_state from app.telegram_history_chats where id='${chat}'`).trim(),'completed');
  assert.equal(existsSync(newest.record.configPath),true);
 });
 await t.test('claim is bounded and fair; cross-service and expired proof cannot ACK',async()=>{
  for(let n=0;n<7;n++){const s=await telegramHostedPrepare(staff,owner,org,service,{action:'prepare'}); // Retire only the active current registration once, then safe empty registrations.
   await telegramHostedRetire(staff,owner,org,service,{action:'retire',operationId:randomUUID(),requestId:s.enrollment.requestId,expectedWorkerId:s.workerId,telegramRevoked:true});}
  const first=await command('retiredCleanupClaim'),second=await command('retiredCleanupClaim');assert.equal(first.requests.length,5);assert.equal(second.requests.length,5);assert.ok(second.requests.some(row=>!first.requests.some(prior=>prior.requestId===row.requestId)));
  const otherService=randomUUID(),otherInstance=randomUUID();await telegramHostedPrepare(staff,owner,org,otherService,{action:'prepare'});const otherLease=(await telegramHostedControl(control,otherService,{action:'heartbeat',instanceId:otherInstance})).leaseToken;
  await assert.rejects(telegramHostedControl(control,otherService,{action:'retiredCleanupAck',instanceId:otherInstance,leaseToken:otherLease,requestId:first.requests[0].requestId,workerId:first.requests[0].workerId,cleanupToken:first.requests[0].cleanupToken}),{code:'40001'});
  psql(db,`update app.telegram_hosted_services set lease_expires_at=now()-interval '1 second' where service_id='${service}'`);
  await assert.rejects(command('retiredCleanupClaim'),{code:'40001'});await assert.rejects(command('retiredCleanupAck',{requestId:first.requests[0].requestId,workerId:first.requests[0].workerId,cleanupToken:first.requests[0].cleanupToken}),{code:'40001'});
 });
});
