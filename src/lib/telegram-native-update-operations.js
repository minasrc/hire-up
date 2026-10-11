import { nativeUpdateInput } from './telegram-native-update-contracts.js';
export async function telegramNativeWorkerOperation(pool,token,action,input){
 if(!/^[A-Za-z0-9_-]{64}$/.test(token??'')){const e=new Error('Unauthorized');e.code='42501';throw e;}
 const p=nativeUpdateInput(action,input);const f=p.proof;
 const args=[token,f.connectionId,f.generation,f.connectionLeaseToken,f.accountUserId];let sql;
 if(action==='claim')sql='select app.telegram_native_claim_v1($1,$2,$3,$4,$5) as result';
 else if(action==='resolve'){sql='select app.telegram_native_resolve_v1($1,$2,$3,$4,$5,$6,$7,$8::jsonb) as result';args.push(p.leaseToken,p.scopeDigest,JSON.stringify(p.candidates));}
 else if(action==='complete'){sql='select app.telegram_native_complete_v1($1,$2,$3,$4,$5,$6,$7::jsonb) as result';args.push(p.leaseToken,JSON.stringify(p.payload));}
 else{sql='select app.telegram_native_defer_v1($1,$2,$3,$4,$5,$6,$7,$8) as result';args.push(p.leaseToken,p.code,p.retryAfterSeconds);}
 const client=await pool.connect();
 try{await client.query("begin;set local role app_telegram_worker;set local statement_timeout='15s';set local lock_timeout='2s'");const{rows}=await client.query(sql,args);await client.query('commit');return rows[0].result;}
 catch(error){await client.query('rollback').catch(()=>{});throw error;}finally{client.release();}
}
