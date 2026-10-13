import { randomUUID } from 'node:crypto';
import { HistoryReadError, peerKey } from './history-adapter.mjs';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pendingKey = 'pending-source-update';
export function createSourceUpdateWorker({ host, vault, now = Date.now, randomId = randomUUID }) {
  let busy = false; let nextPoll = 0; let scope = '';
  const proof = c => ({connectionId:c.connectionId,generation:c.generation,connectionLeaseToken:c.connectionLeaseToken,accountUserId:c.accountUserId});
  const active = c => !c.signal?.aborted && c.isActive() && Date.parse(c.connectionLeaseExpiresAt)>now();
  const requireActive = c => { if (!active(c)) throw new HistoryReadError('CONNECTION_CHANGED'); };
  const load = c => vault.loadHistory(c.connectionId,c.accountUserId,pendingKey);
  const save = (c,p) => vault.saveHistory(c.connectionId,c.accountUserId,pendingKey,p);
  const clear = c => vault.removeHistoryRecord(c.connectionId,c.accountUserId,pendingKey);
  const valid = (job,c) => job && uuid.test(job.id) && uuid.test(job.leaseToken) && job.connectionId===c.connectionId && job.generation===c.generation && job.accountUserId===c.accountUserId && Date.parse(job.leaseExpiresAt)>now() && Array.isArray(job.messageIds) && job.messageIds.length>0 && job.messageIds.length<=20 && job.messageIds.every(id=>/^[1-9][0-9]{0,9}$/.test(id));
  async function complete(c,p) {
    requireActive(c);
    const result = await host('complete',{...proof(c),...p.payload});
    if (result?.ok!==true || !['checked','capacity_paused'].includes(result.status)) throw new Error('INVALID_SOURCE_RESPONSE');
    clear(c); return {status:result.status};
  }
  return { async tick(c) {
    if (busy || !active(c)) return {status:'stale'};
    const current = `${c.connectionId}:${c.accountUserId}:${c.generation}`;
    if (current!==scope) {scope=current;nextPoll=0;}
    if (now()<nextPoll && !c.wake) return {status:'idle',idleReason:'local_wait',providerRead:false};
    busy=true; let job;
    try {
      const pending=load(c);
      if (pending) {
        if (pending.generation!==c.generation) {clear(c);return {status:'stale'};}
        try {return await complete(c,pending);} catch(error) {
          if (![400,409,422].includes(error.status)) throw error;
          // Re-read after expiry/validation rejection, never advance the server sweep.
          clear(c);nextPoll=now()+5000;return {status:'stale'};
        }
      }
      if (c.plan?.source===false) return {status:'idle',idleReason:'plan',providerRead:false};
      const response=await host('claim',proof(c)); requireActive(c);job=response.job;
      if (job===null) {nextPoll=now()+5000;return {status:'idle',idleReason:'empty',providerRead:false};}
      if (!valid(job,c)) throw new Error('INVALID_SOURCE_RESPONSE');
      const records=await c.telegram.reconcile({peer:job.peer,messageIds:job.messageIds,accountUserId:c.accountUserId,signal:c.signal,
        readPeer:peer=>vault.loadHistory(c.connectionId,c.accountUserId,`peer:${peerKey(peer)}`),
        cachePeer:(peer,record)=>{requireActive(c);vault.saveHistory(c.connectionId,c.accountUserId,`peer:${peerKey(peer)}`,record);}});
      requireActive(c);
      if (!Array.isArray(records) || records.length!==job.messageIds.length || new Set(records.map(r=>r.messageId)).size!==records.length || records.some(r=>!job.messageIds.includes(r.messageId))) throw new HistoryReadError('PEER_UNAVAILABLE');
      const p={generation:c.generation,payload:{jobId:job.id,jobLeaseToken:job.leaseToken,pageId:randomId(),records}};
      if (Buffer.byteLength(JSON.stringify({...proof(c),...p.payload}))>262144) throw new HistoryReadError('MESSAGE_TOO_LARGE');
      save(c,p);return await complete(c,p);
    } catch(error) {
      if (!active(c) || error.code==='CONNECTION_CHANGED') return {status:'stale'};
      if (error.status===409) {clear(c);nextPoll=now()+5000;return {status:'stale'};}
      if (job && ['FLOOD_WAIT','TELEGRAM_UNAVAILABLE','PEER_UNAVAILABLE','PEER_CACHE_MISSING','MESSAGE_TOO_LARGE'].includes(error.code)) {
        requireActive(c);
        await host('defer',{...proof(c),jobId:job.id,jobLeaseToken:job.leaseToken,code:error.code,...(error.code==='FLOOD_WAIT'?{retryAfterSeconds:error.retryAfterSeconds}:{})});
        nextPoll=now()+5000;return {status:'deferred'};
      }
      throw error;
    } finally {busy=false;}
  }};
}
