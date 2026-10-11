import { ClientJobContractError } from './client-job-contracts.js';
import { assertUuid } from './candidate-profile-contracts.js';
import { historyProof,historyPeer,historyWorkerInput } from './telegram-history-contracts.js';
export const NATIVE_BODY_LIMIT=2097152;
const proofKeys=['connectionId','generation','connectionLeaseToken','accountUserId'];
const fail=()=>{throw new ClientJobContractError({input:'Invalid native Telegram request.'});};
const exact=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))fail();};
const int=(v,min=0)=>{if(!Number.isSafeInteger(v)||v<min||v>2147483647)fail();return v;};
const id=v=>{if(typeof v!=='string'||!/^[1-9][0-9]{0,9}$/.test(v)||BigInt(v)>2147483647n)fail();return v;};
const digest=v=>{if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))fail();return v;};
export function nativeState(v){exact(v,['pts','qts','date','seq']);return Object.fromEntries(['pts','qts','date','seq'].map(k=>[k,int(v[k])]));}
export function nativeUpdateInput(action,input){
 if(action.startsWith('channel')){const base=action.slice(7);const normalized=base[0].toLowerCase()+base.slice(1);if(normalized==='claim')return nativeUpdateInput('claim',input);const {feedId,...rest}=input;return {...nativeUpdateInput(normalized,rest),feedId:assertUuid(feedId,'feedId')};}
 const proof=historyProof(input);
 if(action==='claim'){exact(input,proofKeys);return{proof};}
 if(action==='defer'){
  exact(input,[...proofKeys,'leaseToken','code','retryAfterSeconds']);
  if(!['FLOOD_WAIT','TELEGRAM_UNAVAILABLE','INVALID_RESULT','CAPACITY_LIMIT','PROVIDER_GAP'].includes(input.code))fail();
  const retry=input.code==='FLOOD_WAIT'?int(input.retryAfterSeconds,1):60;if(retry>604800)fail();
  return{proof,leaseToken:assertUuid(input.leaseToken,'leaseToken'),code:input.code,retryAfterSeconds:retry};
 }
 if(action==='resolve'){
  exact(input,[...proofKeys,'leaseToken','scopeDigest','candidates']);
  if(!Array.isArray(input.candidates)||input.candidates.length>128)fail();
  const candidates=input.candidates.map(c=>{exact(c,['action','peer','messageId']);if(!['edit','delete'].includes(c.action)||(c.action==='edit'&&c.peer===null))fail();return{action:c.action,peer:c.peer===null?null:historyPeer(c.peer),messageId:id(c.messageId)};});
  return{proof,leaseToken:assertUuid(input.leaseToken,'leaseToken'),scopeDigest:digest(input.scopeDigest),candidates};
 }
 if(action!=='complete')fail();
 exact(input,[...proofKeys,'leaseToken','pageId','scopeDigest','fromState','nextState','kind','gapReason','changes']);
 if(!['baseline','difference','empty','gap'].includes(input.kind)||!['INITIAL_BASELINE','PROVIDER_GAP','OVERFLOW',null].includes(input.gapReason)||!Array.isArray(input.changes)||input.changes.length>128)fail();
 const changes=input.changes.map(c=>{
  exact(c,['action','chatId','chatVersion','messageId','record']);if(!['edit','delete'].includes(c.action))fail();
  let record=null;
  if(c.action==='edit'){
   const parsed=historyWorkerInput('complete',{...proof,jobId:c.chatId,jobLeaseToken:input.leaseToken,pageId:input.pageId,fromCursor:{beforeMessageId:null,upperMessageId:null},nextCursor:{beforeMessageId:'1',upperMessageId:'1'},done:false,records:[c.record]});
   record=parsed.payload.records[0];if(record.messageId!==c.messageId)fail();
  }else if(c.record!==null)fail();
  return{action:c.action,chatId:assertUuid(c.chatId,'chatId'),chatVersion:int(c.chatVersion,1),messageId:id(c.messageId),record};
 });
 const payload={pageId:assertUuid(input.pageId,'pageId'),scopeDigest:digest(input.scopeDigest),fromState:input.fromState===null?null:nativeState(input.fromState),nextState:nativeState(input.nextState),kind:input.kind,gapReason:input.gapReason,changes};
 if(Buffer.byteLength(JSON.stringify(input))>NATIVE_BODY_LIMIT)fail();
 return{proof,leaseToken:assertUuid(input.leaseToken,'leaseToken'),payload};
}
