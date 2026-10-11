import { randomUUID } from 'node:crypto';
import { HistoryReadError } from './history-adapter.mjs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pendingKey='pending-native-update';
const stateValid=v=>v===null||(v&&['pts','qts','date','seq'].every(k=>Number.isSafeInteger(v[k])&&v[k]>=0&&v[k]<=2147483647));
export function createNativeWorker({host,vault,now=Date.now,randomId=randomUUID}){
 let busy=false;let nextPoll=0;let scope='';
 const proof=c=>({connectionId:c.connectionId,generation:c.generation,connectionLeaseToken:c.connectionLeaseToken,accountUserId:c.accountUserId});
 const active=c=>!c.signal?.aborted&&c.isActive()&&Date.parse(c.connectionLeaseExpiresAt)>now();
 const requireActive=c=>{if(!active(c))throw new HistoryReadError('CONNECTION_CHANGED');};
 const load=c=>vault.loadHistory(c.connectionId,c.accountUserId,pendingKey);
 const save=(c,p)=>vault.saveHistory(c.connectionId,c.accountUserId,pendingKey,p);
 const clear=c=>vault.removeHistoryRecord(c.connectionId,c.accountUserId,pendingKey);
 const valid=(j,c)=>j&&j.kind==='account'&&uuid.test(j.id)&&uuid.test(j.leaseToken)&&j.connectionId===c.connectionId&&j.generation===c.generation&&j.accountUserId===c.accountUserId&&Date.parse(j.leaseExpiresAt)>now()&&/^[a-f0-9]{64}$/.test(j.scopeDigest)&&typeof j.baseline==='boolean'&&stateValid(j.fromState);
 async function defer(c,leaseToken,code,seconds){
  requireActive(c);
  try{const r=await host('defer',{...proof(c),leaseToken,code,...(code==='FLOOD_WAIT'?{retryAfterSeconds:seconds}:{})});if(r?.ok!==true)throw new Error('INVALID_NATIVE_RESPONSE');}
  catch(e){if(e.status!==409)throw e;}
  nextPoll=now()+5000;
 }
 async function complete(c,p){
  requireActive(c);let result;
  try{result=await host('complete',{...proof(c),...p.payload});}
  catch(e){
   if(e.status===413&&p.payload.kind!=='gap'){p.payload={...p.payload,pageId:randomId(),kind:'gap',gapReason:'OVERFLOW',changes:[]};save(c,p);return complete(c,p);}
   if(![400,409,413,422].includes(e.status))throw e;
   if(e.status!==409){p.rejectionCode=e.status===422?'CAPACITY_LIMIT':'INVALID_RESULT';save(c,p);await defer(c,p.payload.leaseToken,p.rejectionCode);}
   clear(c);return{status:'stale',providerRead:false};
  }
  if(result?.ok!==true||!['native_checked','repair_required'].includes(result.status))throw new Error('INVALID_NATIVE_RESPONSE');
  clear(c);return{status:result.status,providerRead:false};
 }
 return{async tick(c){
  if(busy||!active(c))return{status:'stale',providerRead:false};
  const s=`${c.connectionId}:${c.accountUserId}:${c.generation}`;if(s!==scope){scope=s;nextPoll=0;}
  if(now()<nextPoll)return{status:'idle',providerRead:false};
  busy=true;let job;let providerRead=false;
  try{
   const pending=load(c);
   if(pending){
    if(pending.generation!==c.generation){clear(c);return{status:'stale',providerRead:false};}
    if(pending.rejectionCode){await defer(c,pending.payload.leaseToken,pending.rejectionCode);clear(c);return{status:'deferred',providerRead:false};}
    return await complete(c,pending);
   }
   const response=await host('claim',proof(c));requireActive(c);job=response.job;
   if(job===null){nextPoll=now()+3000;return{status:'idle',providerRead:false};}
   if(!valid(job,c))throw new Error('INVALID_NATIVE_RESPONSE');
   providerRead=true;
   const page=await c.telegram.native.account({fromState:job.fromState,baseline:job.baseline,accountUserId:c.accountUserId,signal:c.signal});requireActive(c);
   if(!page||!['baseline','difference','empty','gap'].includes(page.kind)||!stateValid(page.nextState)||page.nextState===null||!Array.isArray(page.candidates)||page.candidates.length>128||typeof page.changes!=='function')throw new HistoryReadError('INVALID_RESULT');
   let changes=[];
   if(page.candidates.length){
    const targets=await host('resolve',{...proof(c),leaseToken:job.leaseToken,scopeDigest:job.scopeDigest,candidates:page.candidates});requireActive(c);
    if(!Array.isArray(targets.targets)||targets.targets.length>128)throw new HistoryReadError('INVALID_RESULT');
    if(targets.overflow===true){page.kind='gap';page.gapReason='OVERFLOW';}else{try{changes=page.changes(targets.targets);}catch(e){if(e.code==='MESSAGE_TOO_LARGE'){page.kind='gap';page.gapReason='OVERFLOW';}else throw new HistoryReadError('INVALID_RESULT');}}
   }
   if(!Array.isArray(changes)||changes.length>128)throw new HistoryReadError('INVALID_RESULT');
   const payload={leaseToken:job.leaseToken,pageId:randomId(),scopeDigest:job.scopeDigest,fromState:job.fromState,nextState:page.nextState,kind:page.kind,gapReason:page.gapReason,changes};
   if(Buffer.byteLength(JSON.stringify({...proof(c),...payload}))>2097152){payload.changes=[];payload.kind='gap';payload.gapReason='OVERFLOW';}
   const durable={generation:c.generation,payload};save(c,durable);
   const result=await complete(c,durable);return{...result,providerRead};
  }catch(e){
   if(!active(c)||e.code==='CONNECTION_CHANGED')return{status:'stale',providerRead};
   if(e.status===409){clear(c);return{status:'stale',providerRead};}
   if(job&&['FLOOD_WAIT','TELEGRAM_UNAVAILABLE','INVALID_RESULT','PROVIDER_GAP'].includes(e.code)){await defer(c,job.leaseToken,e.code,e.retryAfterSeconds);return{status:'deferred',providerRead};}
   throw e;
  }finally{busy=false;}
 }};
}
