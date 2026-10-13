import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync,realpathSync,rmSync,existsSync,writeFileSync,symlinkSync,unlinkSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { createServiceStore } from '../../services/telegram-hosted/store.mjs';
import { createVault,acquireLock } from '../../services/telegram-connector/vault.mjs';
import { createRetiredCleanup,validateRetiredClaim } from '../../services/telegram-hosted/retired-cleanup.mjs';
import { createSupervisor } from '../../services/telegram-hosted/supervisor.mjs';
import { hostedControlInput } from '../../src/lib/telegram-hosted-contracts.js';
function fixture(t){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'retired-vault-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const serviceId=randomUUID(),organizationId=randomUUID(),ownerUserId=randomUUID();
 const store=createServiceStore({stateDirectory:root,server:'https://synthetic.test',serviceId});
 const prepare=()=>{const requestId=randomUUID();const record=store.prepare({requestId,organizationId,ownerUserId,workerId:null,tokenSha256:null,state:'pending',canRun:true},{apiId:1,apiHash:'a'.repeat(32)});return{record,row:{requestId,workerId:record.workerId,organizationId,ownerUserId,cleanupToken:randomUUID()}};};
 return{root,store,prepare};
}
test('retired directory destruction is scoped, durable and succeeds without the old encryption key',async t=>{
 const f=fixture(t),old=f.prepare(),active=f.prepare();
 const vault=createVault({root:old.record.stateDirectory,server:'https://synthetic.test',workerId:old.record.workerId});vault.save(old.row.requestId,{generation:1,state:'connected',session:'synthetic-old-session'});
 const activeVault=createVault({root:active.record.stateDirectory,server:'https://synthetic.test',workerId:active.record.workerId});activeVault.save(active.row.requestId,{generation:1,state:'connected',session:'keep-active'});
 unlinkSync(join(old.record.stateDirectory,createHash('sha256').update(`https://synthetic.test:${old.record.workerId}`).digest('hex'),'identity.json'));
 const privateFiles=join(old.record.stateDirectory); // The store never needs to decrypt old bytes.
 writeFileSync(join(privateFiles,'missing-key.json'),'ciphertext-with-unavailable-key',{mode:0o600});
 await f.store.eraseRetired(old.row);assert.equal(existsSync(join(f.root,'workers',old.row.requestId)),false);
 assert.equal(activeVault.load(active.row.requestId).session,'keep-active');await f.store.eraseRetired(old.row);
});
test('live PID lock blocks erasure; symlinks and scope metadata mismatch never ACK',async t=>{
 const f=fixture(t),old=f.prepare();const release=acquireLock(old.record.stateDirectory);
 await assert.rejects(f.store.eraseRetired(old.row),/RETIRED_VAULT_STILL_RUNNING/);assert.equal(existsSync(old.record.configPath),true);release();
 symlinkSync(join(f.root,'does-not-exist'),join(old.record.stateDirectory,'unknown'));
 await assert.rejects(f.store.eraseRetired(old.row));assert.equal(existsSync(old.record.configPath),true);unlinkSync(join(old.record.stateDirectory,'unknown'));
 await assert.rejects(f.store.eraseRetired({...old.row,workerId:randomUUID()}));assert.equal(existsSync(old.record.configPath),true);
});
test('unknown broken canonical path and changed deployment identity are refused',async t=>{
 const f=fixture(t),old=f.prepare();rmSync(join(f.root,'workers',old.row.requestId),{recursive:true});symlinkSync(join(f.root,'missing'),join(f.root,'workers',old.row.requestId));
 await assert.rejects(f.store.eraseRetired(old.row));unlinkSync(join(f.root,'workers',old.row.requestId));
 writeFileSync(join(f.root,'service.json'),JSON.stringify({version:1,server:'https://other.test',serviceId:randomUUID()}),{mode:0o600});await assert.rejects(f.store.eraseRetired(old.row),/UNVERIFIABLE/);
});
test('claim protocol is bounded and contains identities only; ACK forbids owner/path selection',()=>{
 const row={requestId:randomUUID(),workerId:null,organizationId:randomUUID(),ownerUserId:randomUUID(),cleanupToken:randomUUID()};assert.deepEqual(validateRetiredClaim({protocolVersion:1,requests:[row]}),[row]);
 for(const requests of [[row,row],[{...row,path:'/private'}],Array(6).fill(row)])assert.throws(()=>validateRetiredClaim({protocolVersion:1,requests}));
 const ack={action:'retiredCleanupAck',instanceId:randomUUID(),leaseToken:randomUUID(),requestId:row.requestId,workerId:null,cleanupToken:row.cleanupToken};assert.equal(hostedControlInput(ack),ack);assert.throws(()=>hostedControlInput({...ack,ownerUserId:row.ownerUserId}));
});
test('no idle claim, observed exit precedes erasure, lost ACK safely retries verified absence',async()=>{
 let now=1700000000000,valid=true,lost=true;const events=[],row={requestId:randomUUID(),workerId:randomUUID(),organizationId:randomUUID(),ownerUserId:randomUUID(),cleanupToken:randomUUID()};
 const cleaner=createRetiredCleanup({instanceId:randomUUID(),proof:()=>row.cleanupToken,valid:()=>valid,wall:()=>now,store:{eraseRetired:()=>events.push('erase')},stopRequest:async()=>{await new Promise(resolve=>setImmediate(resolve));events.push('exit');},control:async action=>{events.push(action);if(action==='retiredCleanupClaim')return{protocolVersion:1,requests:[row]};if(lost){lost=false;throw Error('HOST_UNAVAILABLE');}return{ok:true};}});
 await cleaner.tick();assert.equal(events.length,0);cleaner.hint(true);await cleaner.tick();assert.deepEqual(events,['retiredCleanupClaim','exit','erase','retiredCleanupAck']);
 now+=300000;await cleaner.tick();assert.equal(events.filter(e=>e==='retiredCleanupAck').length,2);assert.ok(events.lastIndexOf('exit')<events.lastIndexOf('erase'));valid=false;now+=300000;await cleaner.tick();assert.equal(events.filter(e=>e==='retiredCleanupClaim').length,2);
});
test('supervisor cancels an observed retired child before deleting its entire private scope',async()=>{
 const id=randomUUID(),worker=randomUUID(),owner=randomUUID();const events=[];const child=new EventEmitter();child.connected=true;child.exitCode=null;child.signalCode=null;child.send=()=>{};
 const row={requestId:id,workerId:worker,organizationId:owner,ownerUserId:owner,cleanupToken:randomUUID()};
 const supervisor=createSupervisor({efficientPolling:true,store:{prepare:()=>({workerId:worker}),eraseRetired:()=>events.push('erase')},terminate:async()=>{events.push('exit');},spawn:async()=>child,control:async(action,input)=>{
  if(action==='sync')return{protocolVersion:1,leaseToken:owner,leaseSeconds:89,capacity:10,nextAfter:null,requests:[{requestId:id,workerId:null,tokenSha256:null,organizationId:owner,ownerUserId:owner,state:'pending',canRun:true,wakeEpoch:'0',demand:'run',runnable:{history:false,cv:false,source:false}}]};
  if(action==='register')return{workerId:input.workerId,state:'registered'};
  if(action==='retiredCleanupClaim')return{protocolVersion:1,requests:[row]};return{ok:true};
 }});
 await supervisor.refresh();await supervisor.reconcile();supervisor.retiredCleanupHint(true);await supervisor.cleanupRetired();assert.deepEqual(events,['exit','erase']);await supervisor.stop();
});
test('backend acknowledgement uses the retired service action and fixed codes only',()=>{
 const source=readFileSync(new URL('../../services/telegram-hosted/retired-cleanup.mjs',import.meta.url),'utf8');assert.doesNotMatch(source,/output\(row/);assert.match(source,/RETIRED_VAULT_UNVERIFIABLE/);
});

test('restart cleanup verifies a real exited orphan PID before erasing its old directory',async t=>{
 const f=fixture(t),old=f.prepare();const child=spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore'});await once(child,'exit');
 writeFileSync(join(old.record.stateDirectory,'connector.lock'),JSON.stringify({pid:child.pid}),{mode:0o600});
 await f.store.eraseRetired(old.row);assert.equal(existsSync(old.record.configPath),false);
});
test('asynchronous private inventory leaves the service event loop available for lease renewal',async t=>{
 const f=fixture(t),old=f.prepare();for(let n=0;n<500;n++)writeFileSync(join(old.record.stateDirectory,`scratch-${n}`),'synthetic',{mode:0o600});
 let ticks=0,stopped=false;const renew=()=>{if(!stopped){ticks++;setImmediate(renew);}};setImmediate(renew);
 await f.store.eraseRetired(old.row);stopped=true;assert.ok(ticks>0);
});
