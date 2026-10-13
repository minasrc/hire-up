import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createTelegramFactory } from '../../services/telegram-connector/telegram-adapter.mjs';

test('pinned SDK confirms QR approval directly across wrappers, migration and password verification', async t => {
 const require=createRequire(new URL('../../services/telegram-connector/package.json',import.meta.url));
 const {TelegramClient,Api}=require('teleproto'),{StringSession}=require('teleproto/sessions'),{Logger}=require('teleproto/extensions');
 const {_handleUpdate}=require('teleproto/client/updates/dispatch.js');
 const user=()=>new Api.User({id:123n,firstName:'Synthetic'});
 const success=()=>new Api.auth.LoginTokenSuccess({authorization:new Api.auth.Authorization({user:user()})});
 const wrappers={
  bare:()=>new Api.UpdateLoginToken(),
  short:()=>new Api.UpdateShort({update:new Api.UpdateLoginToken(),date:1}),
  updates:()=>new Api.Updates({updates:[new Api.UpdateDeleteMessages({messages:[1],pts:1,ptsCount:1}),new Api.UpdateLoginToken()],users:[],chats:[],date:1,seq:1}),
  combined:()=>new Api.UpdatesCombined({updates:[new Api.UpdateLoginToken()],users:[],chats:[],date:1,seq:1,seqStart:1}),
 };
 for(const [wrapper,packet] of Object.entries(wrappers))for(const mode of ['direct','migration','password','cancelled'])await t.test(`${wrapper}: ${mode}`,async t=>{
  const clients=[],calls=[],queue=[],events=[],checkpoints=[];
  class OfflineClient extends TelegramClient{
   constructor(...args){super(...args);clients.push(this);}
   async connect(){this.updateManager.start();}
   async destroy(){this._destroyed=true;this.updateManager.stop();}
   async getMe(){throw Error('Unsolicited profile lookup during QR confirmation');}
   async _switchDC(id){this.migratedDC=id;this.session.save=()=> 'synthetic-migrated-session';this.updateManager.start();}
   async invoke(request){
    calls.push(request.className);
    assert.ok(request instanceof Api.auth.ExportLoginToken||request instanceof Api.auth.ImportLoginToken||request instanceof Api.account.GetPassword||request instanceof Api.auth.CheckPassword,'Only explicit sign-in requests are allowed');
    if(request instanceof Api.auth.ImportLoginToken)assert.deepEqual(checkpoints,['synthetic-migrated-session'],'Migration key is checkpointed before authorization import');
    const value=queue.shift();if(value instanceof Error)throw value;return value;
   }
  }
  const factory=await createTelegramFactory({apiId:1,apiHash:'synthetic'},[{TelegramClient:OfflineClient,Api},{StringSession},{computeCheck:async()=>new Api.InputCheckPasswordEmpty()},{Logger}],code=>events.push(code));
  const adapter=await factory('',async session=>checkpoints.push(session));t.after(()=>adapter.close());
  assert.equal(clients[0].updateManager.running,false,'SDK automatic fetching stays stopped even when connect starts its update loop');
  queue.push(new Api.auth.LoginToken({token:Buffer.from('synthetic-approval'),expires:Math.floor(Date.now()/1000)+60}));
  assert.equal((await adapter.poll()).status,'qr_pending');assert.equal(await adapter.poll(),null);
  _handleUpdate(clients[0],new Api.UpdateDeleteMessages({messages:[1],pts:1,ptsCount:1}));
  assert.equal(await adapter.poll(),null,'Message updates cannot trigger sign-in or automatic fetching');
  if(mode==='cancelled') {
   const count=calls.length;
   await adapter.close();_handleUpdate(clients[0],packet());
   assert.equal(await adapter.poll(),null);assert.equal(calls.length,count);assert.deepEqual(events,[]);
   return;
  }
  if(mode==='direct')queue.push(success());
  if(mode==='migration')queue.push(new Api.auth.LoginTokenMigrateTo({dcId:4,token:Buffer.from('synthetic-migration')}),success());
  if(mode==='password'){
   const required=Error('synthetic password requirement');required.errorMessage='SESSION_PASSWORD_NEEDED';queue.push(required,{hint:'Synthetic hint'});
  }
  _handleUpdate(clients[0],packet());
  await new Promise(resolve=>setImmediate(resolve));
  let confirmed=await adapter.poll();
  if(mode==='password'){
   assert.equal(confirmed?.status,'awaiting_password');assert.equal(await adapter.poll(),null);
   queue.push({},new Api.auth.Authorization({user:user()}));confirmed=await adapter.password(Buffer.from('synthetic password'));
  }
  assert.equal(confirmed?.status,'connected','Phone approval must be confirmed before the displayed QR expires');
  assert.equal(confirmed.profile.telegramUserId,'123');
  assert.equal(clients[0].updateManager.running,false,'DC reconnect cannot restart autonomous synchronization');
  assert.deepEqual(events,mode==='password'?['CONNECTOR_PHONE_APPROVED','CONNECTOR_PASSWORD_REQUIRED','CONNECTOR_AUTHENTICATED']:['CONNECTOR_PHONE_APPROVED','CONNECTOR_AUTHENTICATED']);
  const count=calls.length;
  _handleUpdate(clients[0],packet());assert.equal(await adapter.poll(),null,'Late notifications cannot start a new sign-in after authorization');
  await adapter.close();_handleUpdate(clients[0],packet());assert.equal(await adapter.poll(),null,'Closed clients ignore late approval');
  assert.equal(calls.length,count);
 });
});
test('pinned SDK exposes explicit account and channel APIs and stoppable update manager offline',async()=>{
 const {createRequire}=await import('node:module');const require=createRequire(new URL('../../services/telegram-connector/package.json',import.meta.url));
 const {Api,TelegramClient}=require('teleproto');const {StringSession}=require('teleproto/sessions');
 assert.equal(typeof Api.updates.GetState,'function');assert.equal(typeof Api.updates.GetDifference,'function');assert.equal(typeof Api.updates.GetChannelDifference,'function');
 const client=new TelegramClient(new StringSession(''),1,'synthetic',{connectionRetries:0});assert.equal(typeof client.updateManager.stop,'function');client.updateManager.stop();
});
test('pinned SDK serializes actual GetDifference and channel requests offline',async()=>{
 const {createRequire}=await import('node:module');const require=createRequire(new URL('../../services/telegram-connector/package.json',import.meta.url));const {Api}=require('teleproto');
 const account=new Api.updates.GetDifference({pts:10,qts:0,date:100,ptsLimit:100,ptsTotalLimit:1000,qtsLimit:100});
 const channel=new Api.updates.GetChannelDifference({channel:new Api.InputChannel({channelId:123n,accessHash:-456n}),filter:new Api.ChannelMessagesFilterEmpty(),pts:10,limit:100,force:true});
 const bootstrap=new Api.channels.GetFullChannel({channel:new Api.InputChannel({channelId:123n,accessHash:-456n})});
 for(const request of [account,channel,bootstrap]){const bytes=request.getBytes();assert.ok(bytes.length>4);assert.equal(bytes.readUInt32LE(0),request.CONSTRUCTOR_ID>>>0);}
});

test('pinned SDK transport dispatch does not deliver raw events after native manager stop',async()=>{
 const require=createRequire(new URL('../../services/telegram-connector/package.json',import.meta.url));
 const {UpdateManager}=require('teleproto/client/updates/manager.js');
 const {_handleUpdate,addEventHandler}=require('teleproto/client/updates/dispatch.js');
 const {Api}=require('teleproto');let events=0,invocations=0;
 const client={_eventBuilders:[],_log:{error(){},debug(){}},_entityCache:{add(){}},session:{},updates:{_pause(){},_resume(){}},invoke:async()=>{invocations++;throw Error('automatic provider RPC prohibited');}};
 client.updateManager=new UpdateManager(client);client.updateManager.stop();addEventHandler(client,()=>events++);
 _handleUpdate(client,new Api.UpdateDeleteMessages({messages:[1],pts:1,ptsCount:1}));
 await new Promise(resolve=>setImmediate(resolve));assert.equal(events,0);assert.equal(invocations,0);assert.equal(client.updateManager.running,false);
});
