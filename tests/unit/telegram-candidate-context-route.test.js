import assert from 'node:assert/strict';
import test from 'node:test';
import {installRouteMocks,setRouteStub,stubModule} from '../support/staff-route-mocks.js';
const stubs=new Map();setRouteStub((s,n,args)=>stubs.get(`${s}:${n}`)(...args));installRouteMocks();
stubModule('@/lib/staff-api.server',{staffApiContext:'fn',staffGateResponse:'fn'});
stubModule('@/lib/telegram-candidate-context-operations',{telegramCandidateContext:'fn'});
const route=await import('../../src/app/api/staff/candidates/[candidateId]/telegram-context/route.ts');
const candidateId='12345678-1234-1234-1234-123456789abc';
const verified={status:'ok',pool:{},identity:{},organizationId:'org'};
const url=`http://localhost/api/staff/candidates/${candidateId}/telegram-context`;
function setup(context=verified){process.env.TELEGRAM_INTAKE_ENABLED='1';const calls=[];stubs.clear();stubs.set('@/lib/staff-api.server:staffApiContext',async()=>context);stubs.set('@/lib/staff-api.server:staffGateResponse',c=>c.status==='ok'?null:Response.json({error:'denied'},{status:c.status==='mfa-required'?428:401}));stubs.set('@/lib/telegram-candidate-context-operations:telegramCandidateContext',async(...args)=>{calls.push(args);return{sources:[{chatId:candidateId,messageId:'42',available:true,sourceChanged:true}],nextAfter:null,provenanceUnavailable:false};});return calls;}
const get=(query='')=>route.GET(new Request(url+query),{params:Promise.resolve({candidateId})});
const privateResponse=r=>assert.equal(r.headers.get('cache-control'),'private, no-store');
test('candidate provenance gate enforces flag/session/MFA with private responses',async()=>{let calls=setup();process.env.TELEGRAM_INTAKE_ENABLED='0';let r=await get();assert.equal(r.status,404);privateResponse(r);assert.equal(calls.length,0);for(const status of ['unauthorized','mfa-required']){calls=setup({status});r=await get();assert.equal(r.status,status==='mfa-required'?428:401);privateResponse(r);assert.equal(calls.length,0);}});
test('candidate provenance accepts only a unique bounded cursor coordinate',async()=>{const calls=setup();let r=await get(`?after=${candidateId}`);assert.equal(r.status,200);privateResponse(r);assert.deepEqual(calls[0],[verified.pool,verified.identity,verified.organizationId,candidateId,candidateId]);assert.equal((await r.json()).sources[0].sourceChanged,true);for(const query of ['?after=a&after=b','?query=secret']){r=await get(query);assert.equal(r.status,400);privateResponse(r);}assert.equal(calls.length,1);});
test('identity failures are sanitized and private',async()=>{setup();stubs.set('@/lib/staff-api.server:staffApiContext',async()=>{throw Error('private subject');});const r=await get();assert.equal(r.status,503);privateResponse(r);assert.ok(!(await r.text()).includes('private subject'));});
