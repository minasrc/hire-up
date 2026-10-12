import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { createConnector } from '../../services/telegram-connector/connector.mjs';
import { createSupervisionGuard } from '../../services/telegram-connector/supervision.mjs';
import { createSupervisor } from '../../services/telegram-hosted/supervisor.mjs';
import { validatePoll, validGrant } from '../../services/telegram-connector/scheduling.mjs';
import { validateCleanup, cleanupScratch } from '../../services/telegram-connector/cleanup.mjs';
const id='11111111-1111-4111-8111-111111111111', worker='22222222-2222-4222-8222-222222222222';
const plan={history:false,cv:false,source:false,nativeAccount:false,nativeChannels:false};
function fixture() {
 let now=1700000000000, status='connected', calls=[], closed=0, work=0;
 const vault={publicKeySpki:'synthetic',load:()=>({generation:1,state:'connected',session:'synthetic'}),save(){}};
 const poll=()=>({protocolVersion:1,connection:{id,generation:1,status,leaseToken:id,challengeId:id,leaseExpiresAt:new Date(now+120000).toISOString()},plan:{...plan},nextPollAfterSeconds:status==='connected'?60:5});
 const host=async action=>{calls.push(action);if(action==='poll')return poll();if(action==='update')return {ok:true};throw Error('unexpected action');};
 const connector=createConnector({vault,host,efficientPolling:true,now:()=>now,createTelegram:async()=>({close:async()=>{closed++;},profile:async()=>({telegramUserId:'123'}),history:{},session:()=>'',}),onConnectedTick:async c=>{work++;assert.equal(c.plan.history,false);}});
 return {connector,calls,poll,advance:ms=>{now+=ms;},status:s=>{status=s;},get closed(){return closed;},get work(){return work;}};
}
test('one connected idle control request per minute, parent wake bypasses idle delay',async()=>{
 const f=fixture();await f.connector.tick();
 for(let n=0;n<59;n++){f.advance(1000);await f.connector.tick();}
 assert.equal(f.calls.filter(a=>a==='poll').length,1);
 f.advance(1000);await f.connector.tick();assert.equal(f.calls.filter(a=>a==='poll').length,2);
 f.advance(1000);f.connector.wake();await f.connector.tick();assert.equal(f.calls.filter(a=>a==='poll').length,3);
 assert.equal(f.calls.includes('heartbeat'),false);assert.equal(f.calls.includes('claim'),false);await f.connector.stop();
});
test('malformed plan cannot replace an acknowledged connection lease',async()=>{
 for(const response of [{...fixture().poll(),plan:{...plan,history:'yes'}},{...fixture().poll(),protocolVersion:2},{...fixture().poll(),nextPollAfterSeconds:120},{...fixture().poll(),extra:true}])assert.throws(()=>validatePoll(response));
 const f=fixture();await f.connector.tick();f.advance(121000);await f.connector.checkLease();assert.ok(f.closed>0);await f.connector.stop();
});
test('exact IPC hints wake on version change and repeated runnable fallback',async t=>{
 let now=1700000000000,wakes=0,lost=0;const channel=new EventEmitter();channel.connected=true;
 const guard=createSupervisionGuard({channel,wall:()=>now,monotonic:()=>now,onWake:()=>wakes++,onLost:()=>lost++,interval:()=>1,clear:()=>{}});t.after(()=>guard.close());
 const grant={type:'telegram-hosted-lease',leaseToken:id,deadline:now+74000,wakeEpoch:'0',runnable:{history:false,cv:false,source:false}};
 channel.emit('message',grant);await guard.ready();assert.equal(wakes,1);
 channel.emit('message',grant);assert.equal(wakes,1);
 channel.emit('message',{...grant,runnable:{...grant.runnable,history:true}});assert.equal(wakes,2);
 assert.equal(validGrant({...grant,unexpected:'data'}),false);
 channel.emit('message',{...grant,wakeEpoch:'18446744073709551615'});assert.equal(lost,1);
});
test('combined snapshot is validated before renewing ownership or launching children',async()=>{
 let now=1700000000000,valid=true,calls=[],launches=0;
 const request={requestId:id,organizationId:id,ownerUserId:id,workerId:null,tokenSha256:null,state:'pending',canRun:true,wakeEpoch:'0',demand:'run',runnable:{history:false,cv:false,source:false}};
 const control=async action=>{calls.push(action);if(action==='sync')return{leaseToken:id,leaseSeconds:89,capacity:10,protocolVersion:1,requests:[valid?request:{...request,runnable:{history:true}}],nextAfter:null};return{workerId:worker,state:'registered'};};
 const child=new EventEmitter();child.connected=true;child.exitCode=null;child.signalCode=null;child.send=()=>{};
 const supervisor=createSupervisor({control,efficientPolling:true,wall:()=>now,monotonic:()=>now,store:{prepare:()=>({workerId:worker,tokenSha256:'a'.repeat(64)})},spawn:async()=>{launches++;return child;},terminate:async()=>{}});
 await supervisor.refresh();await supervisor.reconcile();assert.deepEqual(calls,['sync','register']);assert.equal(launches,1);
 valid=false;now+=10000;await supervisor.refresh();assert.equal(supervisor.stopped,true);assert.equal(launches,1);
});
test('target cleanup retains other chat scratch and rejects oversized/unscoped DTO',()=>{
 const cleanup={removalId:id,chatId:id,connectionId:id,accountUserId:'123',peer:{kind:'channel',id:'99'},historyJobId:id,cvJobIds:[id],cleanupToken:id};
 assert.equal(validateCleanup({cleanup}),cleanup);
 assert.throws(()=>validateCleanup({cleanup:{...cleanup,cvJobIds:Array(51).fill(id)}}));
 const data=new Map([['pending-page',{payload:{jobId:worker}}],['pending-cv',{jobId:id}],['pending-source-update',{payload:{jobId:worker}}],['pending-native-update',{payload:{changes:[]}}],['peer:channel:99',{}],['peer:channel:100',{}]]),chunks=[];
 cleanupScratch({loadHistory:(c,a,k)=>data.get(k),removeHistoryRecord:(c,a,k)=>data.delete(k),removeCvChunks:(c,a,j)=>chunks.push(j)},cleanup);
 assert.equal(data.has('pending-page'),true);assert.equal(data.has('pending-source-update'),true);assert.equal(data.has('peer:channel:100'),true);assert.equal(data.has('pending-native-update'),false);assert.deepEqual(chunks,[id]);
});
test('pinned SDK transport dispatch does not deliver raw events after native manager stop',async()=>{
 const require=createRequire(new URL('../../services/telegram-connector/package.json',import.meta.url));
 const {UpdateManager}=require('teleproto/client/updates/manager.js');
 const {_handleUpdate,addEventHandler}=require('teleproto/client/updates/dispatch.js');
 const {Api}=require('teleproto');let events=0,invocations=0;
 const client={_eventBuilders:[],_log:{error(){},debug(){}},_entityCache:{add(){}},session:{},updates:{_pause(){},_resume(){}},invoke:async()=>{invocations++;throw Error('automatic provider RPC prohibited');}};
 client.updateManager=new UpdateManager(client);client.updateManager.stop();addEventHandler(client,()=>events++);
 _handleUpdate(client,new Api.UpdateDeleteMessages({messages:[1],pts:1,ptsCount:1}));
 await new Promise(resolve=>setImmediate(resolve));assert.equal(events,0);assert.equal(invocations,0);assert.equal(client.updateManager.running,false);
});

test('idle native account and channel checks use independent minute backstops',async()=>{
 const {createNativeWorker}=await import('../../services/telegram-connector/native-worker.mjs');
 let now=1700000000000;const calls=[];
 const native=createNativeWorker({now:()=>now,host:async action=>{calls.push(action);return{job:null};},vault:{loadHistory:()=>null}});
 const context={connectionId:id,generation:1,accountUserId:'123',connectionLeaseExpiresAt:new Date(now+600000).toISOString(),isActive:()=>true,plan:{...plan,nativeAccount:true,nativeChannels:true}};
 for(let second=0;second<600;second++){await native.tick(context);now+=1000;}
 assert.equal(calls.filter(a=>a==='claim').length,10);assert.equal(calls.filter(a=>a==='channelClaim').length,10);
});
test('false work plan still replays durable history and source acknowledgements',async()=>{
 const {createHistoryWorker}=await import('../../services/telegram-connector/history-worker.mjs');
 const {createSourceUpdateWorker}=await import('../../services/telegram-connector/source-update-worker.mjs');
 const context={connectionId:id,generation:1,accountUserId:'123',connectionLeaseToken:id,connectionLeaseExpiresAt:new Date(Date.now()+120000).toISOString(),isActive:()=>true,plan};
 for(const [create,key,status] of [[createHistoryWorker,'pending-page','completed'],[createSourceUpdateWorker,'pending-source-update','checked']]){
  const calls=[];let pending={generation:1,pageNumber:0,payload:{jobId:id,pageId:id}};
  const worker=create({vault:{loadHistory:(c,a,k)=>k===key?pending:null,removeHistoryRecord:()=>{pending=null;}},host:async action=>{calls.push(action);return{ok:true,status};}});
  await worker.tick(context);assert.deepEqual(calls,['complete']);assert.equal(pending,null);
 }
});
test('cleanup poll aborts provider epoch, preserves auth, and ACKs only after deletion',async()=>{
 let now=1700000000000,closed=0;const events=[];
 const cleanup={removalId:id,chatId:id,connectionId:id,accountUserId:'123',peer:{kind:'channel',id:'99'},historyJobId:null,cvJobIds:[],cleanupToken:id};
 const vault={publicKeySpki:'synthetic',load:()=>({generation:1,state:'connected',session:'session'}),save(){},loadHistory:()=>null,removeHistoryRecord:(c,a,k)=>events.push(`remove:${k}`),removeCvChunks(){}};
 let first=true;
 const host=async action=>{
  events.push(action);
  if(action==='poll'){const result={protocolVersion:1,connection:{id,generation:1,status:'connected',leaseToken:id,challengeId:id,leaseExpiresAt:new Date(now+120000).toISOString()},plan,nextPollAfterSeconds:60,cleanup:first?null:cleanup};first=false;return result;}
  if(action==='cleanupAck'){assert.ok(events.includes('remove:peer:channel:99'));assert.equal(closed,1);return{ok:true};}
  return{ok:true};
 };
 const connector=createConnector({host,vault,efficientPolling:true,cleanupEnabled:true,now:()=>now,createTelegram:async()=>({close:async()=>{closed++;},profile:async()=>({telegramUserId:'123'}),session:()=>'',history:{}})});
 await connector.tick();now+=1000;connector.wake();await connector.tick();assert.ok(events.includes('cleanupAck'));assert.equal(events.includes('cleanupClaim'),false);await connector.stop();
});

test('quiet native account plus one channel stay within the 90 percent call budget',async()=>{
 const {createNativeWorker}=await import('../../services/telegram-connector/native-worker.mjs');
 let now=1700000000000,accountDue=now,channelDue=now;const calls=[];
 const state={pts:1,qts:0,date:0,seq:0};
 const context={connectionId:id,generation:1,connectionLeaseToken:id,accountUserId:'123',connectionLeaseExpiresAt:new Date(now+600000).toISOString(),isActive:()=>true,plan:{...plan,nativeAccount:true,nativeChannels:true},telegram:{native:{account:async()=>({kind:'empty',nextState:state,candidates:[],changes:()=>[]}),channel:async()=>({kind:'empty',nextState:state,candidates:[],changes:()=>[]})}}};
 let pending=null;
 const native=createNativeWorker({now:()=>now,vault:{loadHistory:()=>pending,saveHistory:(c,a,k,v)=>{pending=v;},removeHistoryRecord:()=>{pending=null;}},host:async action=>{
  calls.push(action);const channel=action.startsWith('channel');
  if(action==='complete'||action==='channelComplete'){if(channel)channelDue=now+60000;else accountDue=now+60000;return{ok:true,status:'native_checked',...(channel?{nextPollAt:new Date(channelDue).toISOString()}:{})};}
  if(now<(channel?channelDue:accountDue))return{job:null};
  return{job:{id,leaseToken:id,kind:channel?'channel':'account',...(channel?{peer:{kind:'channel',id:'99'}}:{}),connectionId:id,generation:1,accountUserId:'123',leaseExpiresAt:new Date(now+120000).toISOString(),scopeDigest:'a'.repeat(64),baseline:false,fromState:state}};
 }});
 for(let second=0;second<600;second++){await native.tick(context);now+=1000;}
 assert.equal(calls.length,40);
 const dailyNative=calls.length*144, dailyTenOwner=8640+10*(1440+dailyNative);
 assert.equal(dailyTenOwner,80640);assert.ok(dailyTenOwner<817920*.1);
});
