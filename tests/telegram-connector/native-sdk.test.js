import test from 'node:test';
import assert from 'node:assert/strict';
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
