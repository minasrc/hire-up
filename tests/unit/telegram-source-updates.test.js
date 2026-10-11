import { telegramSourceUpdateStatus } from '../../src/lib/telegram-source-update-operations.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSourceUpdateWorker } from '../../services/telegram-connector/source-update-worker.mjs';
import { createVault } from '../../services/telegram-connector/vault.mjs';
import { createHistoryAdapter } from '../../services/telegram-connector/history-adapter.mjs';
function fixture(t) {
 const root=mkdtempSync(join(tmpdir(),'source-update-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const c={connectionId:randomUUID(),generation:1,connectionLeaseToken:randomUUID(),accountUserId:'123',connectionLeaseExpiresAt:new Date(Date.now()+120000).toISOString(),isActive:()=>true,telegram:{}};
 const job={id:randomUUID(),connectionId:c.connectionId,generation:1,accountUserId:'123',leaseToken:randomUUID(),leaseExpiresAt:c.connectionLeaseExpiresAt,messageIds:['1'],peer:{kind:'chat',id:'12'}};
 const vault=createVault({root,workerId:randomUUID(),server:'https://synthetic.test'});let reads=0;const calls=[];
 c.telegram.reconcile=async()=>{reads++;return [{messageId:'1',text:'private edited source'}];};
 const host=async(action,body)=>{calls.push({action,body});return action==='claim'?{job}:{ok:true,status:'checked'};};
 return {c,job,vault,host,calls,reads:()=>reads};
}
test('lost ACK survives encrypted vault restart and replays exactly without provider reads',async t=>{
 const f=fixture(t);let lose=true;
 const host=async(a,b)=>{const result=await f.host(a,b);if(a==='complete'&&lose){lose=false;throw new Error('lost ACK');}return result;};
 await assert.rejects(createSourceUpdateWorker({...f,host}).tick(f.c),/lost ACK/);
 await createSourceUpdateWorker({...f,host}).tick(f.c);
 assert.equal(f.reads(),1);assert.deepEqual(f.calls.filter(c=>c.action==='complete')[0].body,f.calls.filter(c=>c.action==='complete')[1].body);
 assert.equal(f.vault.loadHistory(f.c.connectionId,'123','pending-source-update'),null);
});
test('account and generation mismatch never reach provider; expired lease never reads',async t=>{
 const f=fixture(t);f.job.accountUserId='456';await assert.rejects(createSourceUpdateWorker(f).tick(f.c),/INVALID_SOURCE_RESPONSE/);
 f.job.accountUserId='123';f.job.leaseExpiresAt=new Date(0).toISOString();await assert.rejects(createSourceUpdateWorker(f).tick(f.c),/INVALID_SOURCE_RESPONSE/);assert.equal(f.reads(),0);
 f.vault.saveHistory(f.c.connectionId,'123','pending-source-update',{generation:0});assert.equal((await createSourceUpdateWorker(f).tick(f.c)).status,'stale');
});
test('omitted or duplicate IDs defer without complete or invented deletion',async t=>{
 const f=fixture(t);f.c.telegram.reconcile=async()=>[];assert.equal((await createSourceUpdateWorker(f).tick(f.c)).status,'deferred');assert.equal(f.calls.some(c=>c.action==='complete'),false);assert.equal(f.calls.at(-1).body.code,'PEER_UNAVAILABLE');
});
test('flood wait defers explicitly and revoked context prevents persistence',async t=>{
 const f=fixture(t);f.c.telegram.reconcile=async()=>{throw Object.assign(new Error(),{code:'FLOOD_WAIT',retryAfterSeconds:60});};assert.equal((await createSourceUpdateWorker(f).tick(f.c)).status,'deferred');assert.equal(f.calls.at(-1).body.retryAfterSeconds,60);
 f.c.telegram.reconcile=async()=>{f.c.isActive=()=>false;return [{messageId:'1'}];};assert.equal((await createSourceUpdateWorker(f).tick(f.c)).status,'stale');assert.equal(f.vault.loadHistory(f.c.connectionId,'123','pending-source-update'),null);
});
test('SDK reconciliation validates peer and exact IDs; inaccessible response never becomes deletion',async()=>{
 class Request {constructor(v){Object.assign(this,v);}}
 const Api={InputPeerChat:Request,InputMessageID:Request,messages:{GetMessages:Request},channels:{GetMessages:Request}};
 let response={messages:[{className:'MessageEmpty',id:1}],users:[],chats:[]};
 const adapter=createHistoryAdapter({Api,client:{invoke:async()=>response}});
 const args={peer:{kind:'chat',id:'12'},messageIds:['1'],readPeer:()=>null,cachePeer:()=>{},accountUserId:'123'};
 assert.equal((await adapter.reconcile(args))[0].kind,'unavailable');
 response={messages:[]};await assert.rejects(adapter.reconcile(args),{code:'PEER_UNAVAILABLE'});
 response={messages:[{className:'Message',id:1,peerId:{chatId:13},date:1,message:'wrong chat'}]};await assert.rejects(adapter.reconcile(args),{code:'PEER_UNAVAILABLE'});
 response={messages:[{className:'MessageEmpty',id:2}]};await assert.rejects(adapter.reconcile(args),{code:'PEER_UNAVAILABLE'});
});

test('staff freshness reads require 1–50 unique explicit UUIDs before touching the database',()=>{
 for(const ids of [null,[],[null],['bad'],Array(51).fill(randomUUID())]) assert.throws(()=>telegramSourceUpdateStatus(null,null,null,ids));
 const id=randomUUID();assert.throws(()=>telegramSourceUpdateStatus(null,null,null,[id,id]));
});
