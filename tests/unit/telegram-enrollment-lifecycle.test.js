import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hostedRetireInput } from '../../src/lib/telegram-hosted-contracts.js';
import { telegramHostedRetire } from '../../src/lib/telegram-hosted-operations.js';
import { telegramHostedErrorResponse } from '../../src/lib/telegram-hosted-http.js';
import { hostedStatus, hostedRetirementInput, retirementMessage, hostedRequestError } from '../../src/app/staff/telegram-intake/connect/hosted-connection-model.js';
const id='11111111-1111-4111-8111-111111111111',worker='22222222-2222-4222-8222-222222222222';
const enrollment={requestId:id,workerId:worker,retirementMode:'external_revocation_required'};
test('retirement contract requires exact owner-targeted generation identity and explicit boolean',()=>{
 const input=hostedRetirementInput(enrollment,true,id);assert.equal(hostedRetireInput(input),input);
 for(const bad of [{...input,telegramRevoked:'true'},{...input,expectedWorkerId:undefined},{...input,extra:true},{...input,operationId:'bad'}])assert.throws(()=>hostedRetireInput(bad));
 assert.throws(()=>hostedRetirementInput(enrollment,false,id),/Revoke/);
 assert.equal(hostedRetirementInput({...enrollment,retirementMode:'safe'},false,id).telegramRevoked,false);
});
test('enrollment status rejects mismatched workers and unknown retirement permission',()=>{
 const status={state:'ready',serviceOnline:true,workerOnline:true,workerId:worker,errorCode:null,enrollment};
 assert.deepEqual(hostedStatus(status).enrollment,enrollment);
 assert.throws(()=>hostedStatus({...status,enrollment:{...enrollment,workerId:id}}));
 assert.throws(()=>hostedStatus({...status,enrollment:{...enrollment,retirementMode:'automatically_rekey'}}));
});
test('external revocation acknowledgement is never described as service-confirmed logout',async()=>{
 assert.match(retirementMessage('external_revocation_attested'),/your confirmation/);
 assert.doesNotMatch(retirementMessage('external_revocation_attested'),/confirmed logout/);
 const response=telegramHostedErrorResponse({code:'55000',message:'private sentinel'});
 assert.equal(response.status,409);const body=await response.json();assert.equal(body.code,'TELEGRAM_REVOCATION_REQUIRED');assert.doesNotMatch(body.error,/sentinel/);
 assert.match(hostedRequestError(429,{code:'HOSTED_CAPACITY'}),/active/);
 const browser=readFileSync(new URL('../../src/app/staff/telegram-intake/connect/telegram-connection-browser.tsx',import.meta.url),'utf8');assert.match(browser,/retirementReason === 'external_revocation_attested'/);
});
test('invalid retirement fails before pool acquisition and route uses session/MFA/origin gate',async()=>{
 let connects=0;assert.throws(()=>telegramHostedRetire({connect:()=>{connects++;}},null,id,id,{action:'retire'}));assert.equal(connects,0);
 const route=readFileSync(new URL('../../src/app/api/staff/telegram-hosted/route.ts',import.meta.url),'utf8');assert.match(route,/telegramOriginAllowed/);assert.match(route,/staffApiContext/);assert.match(route,/staffGateResponse/);
 const panel=readFileSync(new URL('../../src/app/staff/telegram-intake/connect/hosted-connection-panel.tsx',import.meta.url),'utf8');assert.match(panel,/previous.operationId/);assert.match(panel,/external_revocation_required' && !revoked/);
});

test('supervisor observes old child exit before registering and starting a replacement owner',async()=>{
 const {EventEmitter}=await import('node:events');
 const {createSupervisor}=await import('../../services/telegram-hosted/supervisor.mjs');
 const replacement='33333333-3333-4333-8333-333333333333';let current=id;const events=[];
 const request=()=>({requestId:current,organizationId:id,ownerUserId:id,workerId:null,tokenSha256:null,state:'pending',canRun:true,wakeEpoch:'1',demand:'run',runnable:{history:false,cv:false,source:false}});
 const supervisor=createSupervisor({efficientPolling:true,control:async(action,input)=>{
  if(action==='sync')return{protocolVersion:1,leaseToken:id,leaseSeconds:89,capacity:10,requests:[request()],nextAfter:null};
  events.push(`register:${input.requestId}`);return{workerId:input.workerId,state:'registered'};
 },store:{prepare:r=>({requestId:r.requestId,workerId:worker,tokenSha256:'a'.repeat(64)})},spawn:async(entry,r)=>{events.push(`spawn:${r.requestId}`);const child=new EventEmitter();child.requestId=r.requestId;child.connected=true;child.exitCode=null;child.signalCode=null;child.send=()=>{};return child;},terminate:async child=>{await new Promise(resolve=>setImmediate(resolve));events.push(`exit:${child.requestId}`);}});
 await supervisor.refresh();await supervisor.reconcile();current=replacement;await supervisor.refresh();await supervisor.reconcile();
 assert.ok(events.indexOf(`exit:${id}`)<events.indexOf(`register:${replacement}`));assert.ok(events.indexOf(`exit:${id}`)<events.indexOf(`spawn:${replacement}`));await supervisor.stop();
});
