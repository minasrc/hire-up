import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeHistoryCursor } from '../../src/lib/telegram-history-operations.js';
const id='10000000-0000-4000-8000-000000000001';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
test('history tuple cursor validates bounded canonical transport preserving timestamp precision', () => {
  const tuple={v:1,accountId:id,view:'all',q:'',lastMessageAt:'2026-01-01T12:01:01.123456+00:00',id};
  assert.deepEqual(decodeHistoryCursor(encode(tuple)),tuple);
  assert.deepEqual(decodeHistoryCursor(encode({...tuple,lastMessageAt:null})),{...tuple,lastMessageAt:null});
  assert.deepEqual(decodeHistoryCursor(id),{legacyId:id});
  for(const value of ['', 'x'.repeat(2049),encode(tuple)+'=',encode({...tuple,v:2}),encode({...tuple,extra:true}),encode({...tuple,lastMessageAt:'infinity'}),encode({...tuple,lastMessageAt:'not-a-date'}),encode({...tuple,id:'bad'}),Buffer.from(' '+JSON.stringify(tuple)).toString('base64url')]) assert.throws(()=>decodeHistoryCursor(value));
});
