import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createNativeAdapter} from '../../services/telegram-connector/native-adapter.mjs';
import {createNativeWorker} from '../../services/telegram-connector/native-worker.mjs';
import {createVault} from '../../services/telegram-connector/vault.mjs';
import {createSourceWork} from '../../services/telegram-connector/source-work.mjs';
const state={pts:10,qts:0,date:100,seq:1};
class Request{constructor(v){Object.assign(this,v);}}
const Api={updates:{GetState:Request,GetDifference:Request}};
test('SDK explicit difference normalizes only hosted selected targets; gap and flood wait are explicit',async()=>{
 let calls=0,stops=0,response={...state};
 const adapter=createNativeAdapter({Api,client:{updateManager:{stop(){stops++;}},invoke:async()=>{calls++;if(response instanceof Error)throw response;return response;}}});
 const args={fromState:null,baseline:true,accountUserId:'1'};
 assert.equal((await adapter.account(args)).gapReason,'INITIAL_BASELINE');
 const msg={className:'Message',id:1,peerId:{userId:12},date:100,message:'selected private text'};
 response={className:'updates.DifferenceSlice',intermediateState:{...state,pts:12},otherUpdates:[{className:'UpdateEditMessage',message:msg},{className:'UpdateEditMessage',message:{...msg,id:2,message:'unselected private text'}},{className:'UpdateDeleteMessages',messages:[3]}],users:[],chats:[]};
 const result=await adapter.account({...args,baseline:false,fromState:state});
 assert.equal(result.candidates.length,3);assert.equal(JSON.stringify(result.candidates).includes('private'),false);
 const selected=result.changes([{index:0,chatId:randomUUID(),chatVersion:1,messageId:'1',peer:{kind:'user',id:'12'}}]);
 assert.equal(selected[0].record.text,msg.message);assert.equal(selected.length,1);
 assert.throws(()=>result.changes([{index:0,messageId:'2',peer:{kind:'user',id:'12'}}]),{code:'INVALID_RESULT'});
 response={className:'updates.DifferenceTooLong',pts:99};assert.equal((await adapter.account({...args,baseline:false,fromState:state})).kind,'gap');
 response=Object.assign(new Error(),{seconds:60});await assert.rejects(adapter.account(args),{code:'FLOOD_WAIT',retryAfterSeconds:60});
 assert.equal(stops,calls);
});
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'native-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const c={connectionId:randomUUID(),generation:1,connectionLeaseToken:randomUUID(),connectionLeaseExpiresAt:new Date(Date.now()+120000).toISOString(),accountUserId:'1',isActive:()=>true,telegram:{native:{}}};
 const job={kind:'account',id:randomUUID(),connectionId:c.connectionId,generation:1,accountUserId:'1',leaseToken:randomUUID(),leaseExpiresAt:c.connectionLeaseExpiresAt,scopeDigest:'a'.repeat(64),fromState:state,baseline:false};
 let reads=0;const calls=[];const vault=createVault({root,workerId:randomUUID(),server:'https://synthetic.test'});
 c.telegram.native.account=async()=>{reads++;return{kind:'difference',nextState:{...state,pts:11},gapReason:null,candidates:[],changes:()=>[]};};
 const host=async(a,b)=>{calls.push({a,b});return a==='claim'?{job}:{ok:true,status:'native_checked'};};
 return{c,job,vault,host,calls,reads:()=>reads};
}
test('encrypted native ACK replay survives restart with no second provider RPC',async t=>{
 const f=fixture(t);let lost=true;const host=async(a,b)=>{const r=await f.host(a,b);if(a==='complete'&&lost){lost=false;throw new Error('ACK lost');}return r;};
 await assert.rejects(createNativeWorker({...f,host}).tick(f.c),/ACK lost/);
 await createNativeWorker({...f,host}).tick(f.c);assert.equal(f.reads(),1);
 assert.deepEqual(f.calls.filter(x=>x.a==='complete')[0].b,f.calls.filter(x=>x.a==='complete')[1].b);
 assert.equal(f.vault.loadHistory(f.c.connectionId,'1','pending-native-update'),null);
});
test('generation, account, expiry, provider errors and aborts fence persistence',async t=>{
 const f=fixture(t);f.job.accountUserId='2';await assert.rejects(createNativeWorker(f).tick(f.c),/INVALID_NATIVE_RESPONSE/);assert.equal(f.reads(),0);
 f.job.accountUserId='1';f.job.leaseExpiresAt=new Date(0).toISOString();await assert.rejects(createNativeWorker(f).tick(f.c),/INVALID_NATIVE_RESPONSE/);
 f.job.leaseExpiresAt=f.c.connectionLeaseExpiresAt;f.c.telegram.native.account=async()=>{throw Object.assign(new Error(),{code:'FLOOD_WAIT',retryAfterSeconds:60});};
 assert.equal((await createNativeWorker(f).tick(f.c)).status,'deferred');assert.equal(f.calls.at(-1).b.retryAfterSeconds,60);
 f.c.telegram.native.account=async()=>{f.c.isActive=()=>false;return {};};assert.equal((await createNativeWorker(f).tick(f.c)).status,'stale');
 assert.equal(f.vault.loadHistory(f.c.connectionId,'1','pending-native-update'),null);
});
test('host target overflow marks repair without storing event bodies',async t=>{
 const f=fixture(t);f.c.telegram.native.account=async()=>({kind:'difference',nextState:state,gapReason:null,candidates:[{action:'delete',peer:null,messageId:'1'}],changes:()=>{throw new Error('must not normalize');}});
 const host=async(a,b)=>a==='resolve'?{targets:[],overflow:true}:f.host(a,b);
 await createNativeWorker({...f,host}).tick(f.c);assert.equal(f.calls.at(-1).b.kind,'gap');assert.deepEqual(f.calls.at(-1).b.changes,[]);
});

test('source lane consumes at most one provider read per tick',async()=>{
 let nativeReads=0,repairReads=0;
 const work=createSourceWork({native:{tick:async()=>{nativeReads++;return{providerRead:true,status:'native_checked'};}},reconcile:{tick:async()=>{repairReads++;return{status:'checked'};}}});
 await work.tick({});assert.equal(nativeReads,1);assert.equal(repairReads,0);
 await work.tick({});assert.equal(nativeReads,1);assert.equal(repairReads,1);
 const ack=createSourceWork({native:{tick:async()=>({providerRead:false,status:'native_checked'})},reconcile:{tick:async()=>{repairReads++;return{};}}});await ack.tick({});assert.equal(repairReads,2);
});

test('413 converts encrypted pending page to a bounded gap ACK without rereading provider',async t=>{
 const f=fixture(t);let reject=true;const host=async(a,b)=>{if(a==='complete'&&reject){reject=false;throw Object.assign(new Error(),{status:413});}return f.host(a,b);};
 await createNativeWorker({...f,host}).tick(f.c);assert.equal(f.reads(),1);assert.equal(f.calls.at(-1).b.kind,'gap');assert.equal(f.calls.at(-1).b.gapReason,'OVERFLOW');assert.deepEqual(f.calls.at(-1).b.changes,[]);
});

test('channel bootstrap/difference uses one RPC and validates exact channel including explicit deletion',async()=>{
 const Api={InputChannel:Request,ChannelMessagesFilterEmpty:Request,channels:{GetFullChannel:Request},updates:{GetChannelDifference:Request}};
 let calls=0;let response={fullChat:{id:12,pts:10}};const adapter=createNativeAdapter({Api,client:{invoke:async()=>{calls++;return response;}}});
 const args={peer:{kind:'channel',id:'12'},fromState:null,baseline:true,accountUserId:'1',readPeer:()=>({kind:'channel',id:'12',accessHash:'-123'})};
 assert.equal((await adapter.channel(args)).kind,'baseline');assert.equal(calls,1);
 response={className:'updates.ChannelDifference',pts:12,users:[],chats:[],otherUpdates:[{className:'UpdateEditChannelMessage',message:{className:'Message',id:1,peerId:{channelId:12},date:100,message:'changed channel'}},{className:'UpdateDeleteChannelMessages',channelId:12,messages:[2]}]};
 const page=await adapter.channel({...args,baseline:false,fromState:{pts:10,qts:0,date:0,seq:0}});assert.equal(calls,2);
 assert.equal(page.changes([{index:1,chatId:randomUUID(),chatVersion:1,messageId:'2',peer:args.peer}])[0].action,'delete');
 response.otherUpdates[1].channelId=13;await assert.rejects(adapter.channel({...args,baseline:false,fromState:{pts:10,qts:0,date:0,seq:0}}),{code:'INVALID_RESULT'});
 response={className:'updates.ChannelDifferenceTooLong',dialog:{peer:{channelId:12},pts:20}};assert.equal((await adapter.channel({...args,baseline:false,fromState:{pts:10,qts:0,date:0,seq:0}})).gapReason,'PROVIDER_GAP');
 response={className:'updates.ChannelDifferenceEmpty',pts:20};assert.equal((await adapter.channel({...args,baseline:false,fromState:{pts:10,qts:0,date:0,seq:0}})).changes([]).length,0);
});
test('channel durable ACK replay uses same feed with no provider reread',async t=>{
 const f=fixture(t);f.job.kind='channel';f.job.peer={kind:'channel',id:'12'};f.job.fromState={pts:10,qts:0,date:0,seq:0};f.c.telegram.native.channel=f.c.telegram.native.account;
 let lost=true;const host=async(a,b)=>{const r=await f.host(a,b);if(a==='channelComplete'&&lost){lost=false;throw new Error('channel ACK lost');}return r;};
 await assert.rejects(createNativeWorker({...f,host}).tick(f.c),/channel ACK lost/);await createNativeWorker({...f,host}).tick(f.c);
 assert.equal(f.reads(),1);assert.equal(f.calls.filter(x=>x.a==='channelComplete').length,2);assert.equal(f.calls.at(-1).b.feedId,f.job.id);
});
