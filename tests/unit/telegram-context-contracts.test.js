import test from 'node:test';
import assert from 'node:assert/strict';
import { contextPost, contextGet } from '../../src/lib/telegram-context-contracts.js';
const chatId='12345678-1234-1234-1234-123456789abc';
test('search normalizes exact usernames and UTC date boundaries without changing Unicode',()=>{
 assert.deepEqual(contextPost({action:'search',query:'  "Ingeniería 東京" -onsite ',sender:'@Candidate',from:'2024-02-29',to:'2024-03-01'}),{action:'search',query:'"Ingeniería 東京" -onsite',sender:'candidate',from:'2024-02-29',to:'2024-03-01',chatId:null,attachmentsOnly:false,after:null});
});
test('invalid dates, unbounded input, extra fields and conflicting windows are rejected',()=>{
 for(const v of [{from:'2026-02-30'},{from:'2026-03-01',to:'2026-02-01'},{sender:'Jane Doe'},{query:'x'.repeat(501)},{query:'\uD800'},{attachmentsOnly:'true'},{secret:'x'},{query:''},{after:'bad cursor'}]) assert.throws(()=>contextPost({action:'search',query:'engineering',...v}));
 assert.throws(()=>contextGet({chatId,anchor:'1',before:'2'}));
 assert.throws(()=>contextGet({chatId,anchor:'2147483648'}));
 assert.deepEqual(contextGet({chatId,anchor:'42'}),{chatId,anchor:'42'});
 assert.throws(()=>contextPost({action:'chats',query:'x'.repeat(101)}));
});
test('pagination cursors validate action-specific positions before reaching PostgreSQL',()=>{
 const cursor=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
 const valid={digest:'a'.repeat(64),sentAt:'2026-10-11T12:00:00+00:00',chatId,messageId:'42'};
 assert.deepEqual(contextPost({action:'search',query:'engineering',after:cursor(valid)}).after,valid);
 for(const changed of [{chatId:'bad'},{sentAt:'2026-02-30T12:00:00Z'},{messageId:'9999999999'},{title:'not a search position'},{sentAt:123},{digest:123}]) assert.throws(()=>contextPost({action:'search',query:'engineering',after:cursor({...valid,...changed})}));
 assert.throws(()=>contextPost({action:'chats',after:cursor(valid)}));
 assert.throws(()=>contextPost({action:'search',query:'engineering',after:cursor({digest:'a'.repeat(64),title:'x',id:chatId})}));
});
