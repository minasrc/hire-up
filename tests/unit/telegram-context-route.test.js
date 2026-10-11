import assert from 'node:assert/strict';
import test from 'node:test';
import { installRouteMocks, setRouteStub, stubModule } from '../support/staff-route-mocks.js';
const stubs=new Map();
setRouteStub((s,n,args)=>stubs.get(`${s}:${n}`)(...args));
installRouteMocks();
stubModule('@/lib/staff-api.server',{staffApiContext:'fn',staffGateResponse:'fn'});
stubModule('@/lib/telegram-context-operations',{telegramContextSearch:'fn',telegramContextView:'fn'});
const route=await import('../../src/app/api/staff/telegram-context/route.ts');
const verified={status:'ok',pool:{},identity:{},organizationId:'org'};
const url='http://localhost/api/staff/telegram-context';
function setup(context=verified){
 process.env.TELEGRAM_INTAKE_ENABLED='1';process.env.NEXTAUTH_URL='http://localhost';stubs.clear();const calls=[];
 stubs.set('@/lib/staff-api.server:staffApiContext',async()=>context);
 stubs.set('@/lib/staff-api.server:staffGateResponse',c=>c.status==='ok'?null:Response.json({error:'denied'},{status:c.status==='mfa-required'?428:401}));
 for(const name of ['telegramContextSearch','telegramContextView'])stubs.set(`@/lib/telegram-context-operations:${name}`,async(...args)=>{calls.push({name,args});return{name};});
 return calls;
}
const post=body=>new Request(url,{method:'POST',headers:{origin:'http://localhost'},body:JSON.stringify(body)});
const privateResponse=r=>assert.equal(r.headers.get('cache-control'),'private, no-store');
test('private context gate prevents feature-disabled, non-MFA and cross-origin reads',async()=>{
 const calls=setup();process.env.TELEGRAM_INTAKE_ENABLED='0';let r=await route.POST(post({action:'search',query:'private keyword'}));assert.equal(r.status,404);privateResponse(r);assert.equal(calls.length,0);
 for(const status of ['unauthorized','mfa-required']){const denied=setup({status});r=await route.GET(new Request(`${url}?chatId=123`));assert.equal(r.status,status==='mfa-required'?428:401);privateResponse(r);assert.equal(denied.length,0);}
 setup();const cross=post({action:'search',query:'keyword'});cross.headers.set('origin','https://other.invalid');r=await route.POST(cross);assert.equal(r.status,403);privateResponse(r);
});
test('search text stays in POST body; GET only accepts unique conversation coordinates',async()=>{
 const calls=setup();const r=await route.POST(post({action:'search',query:'Unicode 東京'}));privateResponse(r);assert.equal(r.status,200);assert.deepEqual(calls[0].args,[verified.pool,verified.identity,verified.organizationId,{action:'search',query:'Unicode 東京'}]);
 for(const query of ['query=secret','chatId=a&chatId=b']){const invalid=await route.GET(new Request(`${url}?${query}`));assert.equal(invalid.status,400);privateResponse(invalid);}
 const bounded=await route.POST(post({action:'search',query:'x'.repeat(9000)}));assert.equal(bounded.status,400);privateResponse(bounded);
});
test('unexpected identity resolution failures return a private sanitized503',async()=>{
 setup();stubs.set('@/lib/staff-api.server:staffApiContext',async()=>{throw Error('secret');});const r=await route.GET(new Request(`${url}?chatId=a`));assert.equal(r.status,503);privateResponse(r);assert.ok(!(await r.text()).includes('secret'));
});
