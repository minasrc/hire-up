import { HistoryReadError,messageRecord,peerLocator,peerKey } from './history-adapter.mjs';
const state=v=>{
 if(!v||['pts','qts','date','seq'].some(k=>!Number.isSafeInteger(v[k])||v[k]<0||v[k]>2147483647))throw new HistoryReadError('INVALID_RESULT');
 return Object.fromEntries(['pts','qts','date','seq'].map(k=>[k,v[k]]));
};
const id=v=>{const s=String(v??'');if(!/^[1-9][0-9]{0,9}$/.test(s)||BigInt(s)>2147483647n)throw new HistoryReadError('INVALID_RESULT');return s;};
export function createNativeAdapter({client,Api}){
 async function invoke(request,signal){
  if(signal?.aborted)throw new HistoryReadError('CONNECTION_CHANGED');
  // This adapter is called only from verified connected-account work. QR/password
  // login handlers stay active before that point. Hosted checkpoints own durability.
  client.updateManager?.stop();
  try{return await client.invoke(request,undefined,{abortSignal:signal,timeout:10000,maxRetryCount:0,floodSleepThreshold:0});}
  catch(e){
   if(signal?.aborted)throw new HistoryReadError('CONNECTION_CHANGED');
   if(Number.isInteger(e.seconds)&&e.seconds>0)throw new HistoryReadError('FLOOD_WAIT',Math.min(604800,e.seconds));
   if(['PERSISTENT_TIMESTAMP_EMPTY','PERSISTENT_TIMESTAMP_INVALID','PERSISTENT_TIMESTAMP_OUTDATED'].includes(e.errorMessage))throw new HistoryReadError('PROVIDER_GAP');
   throw new HistoryReadError('TELEGRAM_UNAVAILABLE');
  }
 }
 return{
  async account({fromState,baseline,accountUserId,signal}){
   if(baseline){const nextState=state(await invoke(new Api.updates.GetState(),signal));return{kind:'baseline',nextState,gapReason:fromState===null?'INITIAL_BASELINE':null,candidates:[],changes:()=>[]};}
   const from=state(fromState);
   const response=await invoke(new Api.updates.GetDifference({...from,ptsLimit:100,ptsTotalLimit:1000,qtsLimit:100}),signal);
   if(response.className==='updates.DifferenceTooLong')return{kind:'gap',nextState:state({...from,pts:response.pts}),gapReason:'PROVIDER_GAP',candidates:[],changes:()=>[]};
   if(response.className==='updates.DifferenceEmpty')return{kind:'empty',nextState:state({...from,date:response.date,seq:response.seq}),gapReason:null,candidates:[],changes:()=>[]};
   if(!['updates.Difference','updates.DifferenceSlice'].includes(response.className)||!Array.isArray(response.otherUpdates)||!Array.isArray(response.users)||!Array.isArray(response.chats))throw new HistoryReadError('INVALID_RESULT');
   const nextState=state(response.state??response.intermediateState);
   if(nextState.pts<from.pts||nextState.qts<from.qts)throw new HistoryReadError('INVALID_RESULT');
   const events=[];
   for(const update of response.otherUpdates){
    if(update.className==='UpdateEditMessage'){
     const peer=peerLocator(update.message?.peerId);
     if(!peer||peer.kind==='channel'||!['Message','MessageService'].includes(update.message?.className))throw new HistoryReadError('INVALID_RESULT');
     events.push({action:'edit',peer,messageId:id(update.message.id),raw:update.message});
    }else if(update.className==='UpdateDeleteMessages'){
     if(!Array.isArray(update.messages))throw new HistoryReadError('INVALID_RESULT');
     for(const messageId of update.messages)events.push({action:'delete',peer:null,messageId:id(messageId),raw:null});
    }
    if(events.length>128)return{kind:'gap',nextState,gapReason:'OVERFLOW',candidates:[],changes:()=>[]};
   }
   const entities=new Map([...response.users,...response.chats].map(entity=>[peerKey(peerLocator(entity)??{}),entity]));
   // Unselected event bodies remain transient. Only hosted target intersections
   // are normalized into the durable encrypted pending page.
   return{kind:'difference',nextState,gapReason:null,candidates:events.map(({action,peer,messageId})=>({action,peer,messageId})),changes:targets=>targets.map(target=>{
    const e=events[target.index];if(!e||e.messageId!==target.messageId||(e.peer&&peerKey(e.peer)!==peerKey(target.peer)))throw new HistoryReadError('INVALID_RESULT');
    return{action:e.action,chatId:target.chatId,chatVersion:target.chatVersion,messageId:e.messageId,record:e.action==='edit'?messageRecord(e.raw,entities,accountUserId):null};
   })};
  },
 };
}
