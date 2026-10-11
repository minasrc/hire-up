import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import { POSTGRES_17_IMAGE, assertLocalTestEnvironment, psql, startPostgresContainer, stopAndRemoveContainer } from '../support/foundation-docker.js';
import { AUTHZ_ID as ID, SUBJECTS, installStaffFixture, staffPoolOptions } from '../support/staff-authorization.js';
import { telegramContextSearch, telegramContextView } from '../../src/lib/telegram-context-operations.js';
import { withStaffTransaction } from '../../src/lib/staff-authorization.js';
const dir=fileURLToPath(new URL('../../supabase/migrations/',import.meta.url));
const who=subject=>({provider:'google',issuer:'https://accounts.google.com',subject});
const owner=who(SUBJECTS.CUSTOM), org=ID.ORG_A;
const message=(i)=>({messageId:String(i),kind:'message',sentAt:`2026-10-${i%2?'10':'11'}T12:00:00.000Z`,editedAt:null,sender:{peer:{kind:'user',id:'1000'},username:i%2?'Candidate':'Other',displayName:'Synthetic'},replyToMessageId:i===42?'41':null,forwardedFrom:null,text:i===42?'Engineering "original" 東京 <script>safe</script>':'Engineering opportunity',attachments:i%2?[{kind:'photo',id:'123',filename:null,mimeType:null,sizeBytes:0}]:[]});
test('private retained Telegram search and conversation viewer', {timeout:120000},async t=>{
 assertLocalTestEnvironment(); const db=await startPostgresContainer('pgtelegramcontext',POSTGRES_17_IMAGE,{publish:true}); let pool;
 t.after(async()=>{await pool?.end();stopAndRemoveContainer(db);});
 for(const f of readdirSync(dir).filter(f=>f>='20260922090000_foundation_roles.sql'&&f<='20261011120000_telegram_context_search.sql'&&f.endsWith('.sql')).sort()) psql(db,readFileSync(join(dir,f),'utf8'));
 const password=installStaffFixture(db); pool=new pg.Pool(staffPoolOptions(db,password,4));
 const chatIds=[];
 for(const [index,user,organization] of [[0,ID.USER_CUSTOM,org],[1,ID.USER_ADMIN2,org],[2,ID.USER_SHARED,ID.ORG_B]]){
 const worker=randomUUID(),connection=randomUUID(),account=randomUUID(),chat=randomUUID();chatIds.push(chat);
 psql(db,`insert into app.telegram_workers(id,organization_id,owner_user_id,name,token_sha256) values('${worker}','${organization}','${user}','Synthetic',sha256(convert_to('${worker}','UTF8')));
 insert into app.telegram_connector_workers(id,organization_id,owner_user_id,public_key_spki) values('${worker}','${organization}','${user}',repeat('A',392));
 insert into app.telegram_connections(id,organization_id,owner_user_id,worker_id,status,auth_expires_at) values('${connection}','${organization}','${user}','${worker}','disconnected',now());
 insert into app.telegram_history_accounts(id,organization_id,owner_user_id,connection_id,account_user_id) values('${account}','${organization}','${user}','${connection}','1000');
 insert into app.telegram_history_chats(id,organization_id,owner_user_id,account_id,peer_kind,peer_id,title) values('${chat}','${organization}','${user}','${account}','user','1000','Synthetic ${index}');`);
 const inserts=[]; for(let i=1;i<= (index===0?125:1);i++) {const body=JSON.stringify(message(i)).replaceAll("'","''");inserts.push(`insert into app.telegram_history_messages(organization_id,owner_user_id,chat_id,message_id,body,stored_bytes) values('${organization}','${user}','${chat}',${i},'${body}',100);`);} psql(db,inserts.join('\n'));
 if(index===0) psql(db,`insert into app.telegram_history_chats(organization_id,owner_user_id,account_id,peer_kind,peer_id,title) select '${organization}','${user}','${account}','user',n::text,'Same title' from generate_series(2001,2055)n;`);
 }
 const search=input=>telegramContextSearch(pool,owner,org,{action:'search',query:'engineering',...input});
 const view=input=>telegramContextView(pool,owner,org,{chatId:chatIds[0],...input});
 await t.test('read-only candidate permission, disconnected history and source text',async()=>{
 const r=await search();assert.equal(r.results.length,25);assert.equal(r.coverage.retainedMessages,125);assert.ok(r.nextAfter);
 const original=await search({query:'"original" 東京'});assert.equal(original.results.length,1);assert.equal(original.results[0].text,message(42).text);assert.equal(original.results[0].replyToMessageId,'41');
 const r2=await view({anchor:'42'});assert.equal(r2.messages.length,41);assert.equal(r2.messages[20].text,message(42).text);assert.equal(r2.anchorUnavailable,false);
 });
 await t.test('deterministic exhaustive pagination and bound filters',async()=>{
 let after=null,ids=[];do{const r=await search({after});ids.push(...r.results.map(m=>m.messageId));after=r.nextAfter;}while(after);
 assert.equal(ids.length,125);assert.equal(new Set(ids).size,125);
 const first=await search();for(const f of [{query:'opportunity'},{sender:'candidate'},{chatId:chatIds[0]},{from:'2026-10-10'},{attachmentsOnly:true}]) await assert.rejects(search({...f,after:first.nextAfter}));
 const chats=await telegramContextSearch(pool,owner,org,{action:'chats'});assert.equal(chats.chats.length,50);const next=await telegramContextSearch(pool,owner,org,{action:'chats',after:chats.nextAfter});assert.equal(next.chats.length,6);assert.equal(new Set([...chats.chats,...next.chats].map(c=>c.id)).size,56);
 await assert.rejects(telegramContextSearch(pool,owner,org,{action:'chats',query:'Synthetic',after:chats.nextAfter}));
 });
 await t.test('username, attachments and inclusive UTC day filters',async()=>{
 const r=await search({sender:'@Candidate',from:'2026-10-10',to:'2026-10-10',attachmentsOnly:true});assert.equal(r.results.length,25);assert.ok(r.results.every(m=>m.sender.username==='Candidate'&&m.sentAt.startsWith('2026-10-10')&&m.attachments.length===1));
 assert.equal((await search({sender:'missing'})).results.length,0);assert.equal((await search({from:'2026-10-12'})).results.length,0);
 for(const query of ['-engineering','!!!']) {await assert.rejects(search({query}),e=>e.fieldErrors?.query?.includes('positive')); }
 });
 await t.test('owner/org isolation, unknown chats and no runtime direct grants',async()=>{
 for(const chatId of chatIds.slice(1)) {await assert.rejects(view({chatId}),{code:'P0002'});assert.equal((await search({chatId})).results.length,0);}
 const other=await telegramContextSearch(pool,who(SUBJECTS.ADMIN2),org,{action:'search',query:'engineering'});assert.equal(other.results.length,1);
 const sharedOtherOrg=await telegramContextSearch(pool,who(SUBJECTS.SHARED),org,{action:'search',query:'engineering'});assert.equal(sharedOtherOrg.results.length,0);
 await withStaffTransaction(pool,owner,org,['candidates.read'],async({client})=>{await assert.rejects(client.query('select * from app.telegram_history_messages'),{code:'42501'});});
 });
 await t.test('SQL callable boundary rejects malformed requests and cannot mutate history',async()=>{
 const call=p=>withStaffTransaction(pool,owner,org,['candidates.read'],async({client})=>(await client.query('select app.telegram_context_search_v1($1::jsonb)',[JSON.stringify(p)])));
 for(const input of [[],{action:'search',query:'engineering',secret:'bad'},{action:'search',query:'engineering',sender:123},{action:'search',query:'engineering',from:'2026-02-30'},{action:'search',query:'engineering',attachmentsOnly:'true'},{action:'chats',query:'',after:{digest:'a'.repeat(64),title:'x',id:'bad'}}]) await assert.rejects(call(input),{code:'22023'});
 await withStaffTransaction(pool,owner,org,['candidates.read'],async({client})=>{await assert.rejects(client.query('delete from app.telegram_history_messages'),{code:'42501'});});
 });
 await t.test('context edges, bidirectional pages and physically purged anchors',async()=>{
 const latest=await view({});assert.equal(latest.messages.length,50);assert.equal(latest.messages[0].messageId,'76');assert.equal(latest.newerAfter,null);assert.equal(latest.olderBefore,'76');
 const older=await view({before:'76'});assert.equal(older.messages[0].messageId,'26');assert.equal(older.newerAfter,'75');const newer=await view({after:'75'});assert.deepEqual(newer.messages,latest.messages);
 const edge=await view({anchor:'1'});assert.equal(edge.messages.length,21);assert.equal(edge.olderBefore,null);
 psql(db,`delete from app.telegram_history_messages where chat_id='${chatIds[0]}' and message_id=42;`);
 const purged=await view({anchor:'42'});assert.equal(purged.anchorUnavailable,true);assert.ok(purged.messages.every(m=>m.messageId!=='42'));assert.equal((await search({query:'original'})).results.length,0);assert.equal((await search()).coverage.retainedMessages,124);
 psql(db,`update app.telegram_history_messages set body=jsonb_set(body,'{text}','"Revised source"') where chat_id='${chatIds[0]}' and message_id=43;`);assert.equal((await search({query:'revised'})).results.length,1);
 psql(db,`update app.telegram_history_messages set body=jsonb_set(body,'{kind}','\"unavailable\"') where chat_id='${chatIds[0]}' and message_id=44;`);assert.equal((await view({anchor:'44'})).anchorUnavailable,true);
 });
});
