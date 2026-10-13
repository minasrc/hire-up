// Offline installation smoke check: inspect the actual pinned runtime without
// constructing a client or contacting Telegram.
import assert from 'node:assert/strict';
import { TelegramClient, Api } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { Logger } from 'teleproto/extensions';
import { computeCheck } from 'teleproto/Password.js';
import { createTelegramFactory } from './telegram-adapter.mjs';
import { createHistoryAdapter } from './history-adapter.mjs';
import { createCvAdapter } from './cv-adapter.mjs';
import { FileMigrateError, FileReferenceExpiredError } from 'teleproto/errors/RPCErrorList.js';
assert.equal(Number(process.versions.node.split('.')[0]), 22);
assert.equal(typeof await createTelegramFactory({ apiId: 1, apiHash: '0'.repeat(32) }), 'function');
for (const method of ['connect', 'destroy', '_switchDC', 'invoke', 'getMe', 'addEventHandler', 'removeEventHandler']) assert.equal(typeof TelegramClient.prototype[method], 'function', method);
for (const name of ['Authorization', 'LoginToken', 'LoginTokenMigrateTo', 'LoginTokenSuccess', 'ExportLoginToken', 'ImportLoginToken', 'CheckPassword', 'LogOut']) assert.equal(typeof Api.auth[name], 'function', name);
for (const name of ['GetDialogs', 'GetHistory', 'GetMessages']) assert.equal(typeof Api.messages[name], 'function', name);
assert.equal(typeof Api.channels.GetMessages, 'function');
assert.equal(typeof Api.upload.GetFile, 'function');
assert.equal(new Api.upload.GetFile({ location: new Api.InputDocumentFileLocation({ id: 100n, accessHash: -123n, fileReference: Buffer.from('synthetic'), thumbSize: '' }), offset: 0n, limit: 524288, precise: false, cdnSupported: false }).getBytes().length > 20, true);
assert.equal(new Api.channels.GetMessages({ channel: new Api.InputChannel({ channelId: 123n, accessHash: -123n }), id: [new Api.InputMessageID({ id: 1 })] }).getBytes().length > 20, true);
for (const name of ['InputPeerUser', 'InputPeerChat', 'InputPeerChannel', 'InputPeerEmpty', 'InputPeerSelf']) assert.equal(typeof Api[name], 'function', name);
assert.equal(new Api.InputPeerUser({ userId: 123456789012345678n, accessHash: -123456789012345678n }).getBytes().length, 20);
assert.equal(typeof Api.account.GetPassword, 'function');
for (const name of ['UpdateLoginToken', 'UpdateShort', 'Updates', 'UpdatesCombined']) assert.equal(typeof Api[name], 'function', name);
const { UpdateManager } = await import('teleproto/client/updates/manager.js');
for (const method of ['start', 'stop', 'onUpdates']) assert.equal(typeof UpdateManager.prototype[method], 'function', method);
assert.equal(typeof computeCheck, 'function');
assert.equal(new StringSession('').save(), '');
assert.equal(new Logger('none').canSend('error'), false);
for (const [error, expected] of [[new FileMigrateError({ capture: 4, request: undefined }), 'FILE_MIGRATE'], [new FileReferenceExpiredError({ capture: 0, request: undefined }), 'FILE_REFERENCE_EXPIRED']]) {
  const cv = createCvAdapter({ Api, client: { invoke: async () => { throw error; } } });
  await assert.rejects(cv.inspect({ peer: { kind: 'user', id: '123' }, messageId: '1', attachment: {}, readPeer: () => null }), value => value.code === expected);
}
const sourceAdapter = createHistoryAdapter({ Api, client: { invoke: async request => { assert.ok(request.getBytes().length >= 20); return { messages: [new Api.MessageEmpty({ id: 1 })], chats: [], users: [] }; } } });
for (const kind of ['chat', 'channel']) assert.equal((await sourceAdapter.reconcile({ peer: { kind, id: '123' }, messageIds: ['1'], accountUserId: '456', readPeer: () => ({ kind, id: '123', accessHash: '-123' }), cachePeer: () => {} }))[0].kind, 'unavailable');
// Native entities have IDs on `id`, while dialog/message peers have typed IDs.
// A matching message ID on a different peer must never supply its timestamp.
const peers = new Map(); let vaultReads = 0; const requests = [];
const responses = [{
  users: [new Api.User({ id: 11n, accessHash: 101n, firstName: 'Native', lastName: 'User', username: 'native_user' })],
  chats: [new Api.Channel({ id: 11n, accessHash: 102n, title: 'Native channel' }), new Api.ChatForbidden({ id: 12n, title: 'Forbidden group' }), new Api.Chat({ id: 13n, title: 'Migrated group', migratedTo: new Api.InputChannel({ channelId: 11n, accessHash: 102n }) })],
  dialogs: [new Api.Dialog({ peer: new Api.PeerUser({ userId: 11n }), topMessage: 1, pinned: true }), new Api.Dialog({ peer: new Api.PeerChannel({ channelId: 11n }), topMessage: 2 }), new Api.Dialog({ peer: new Api.PeerChat({ chatId: 12n }), topMessage: 3 }), new Api.Dialog({ peer: new Api.PeerChat({ chatId: 13n }), topMessage: 4 })],
  messages: [new Api.Message({ id: 1, peerId: new Api.PeerUser({ userId: 11n }), date: 100 }), new Api.Message({ id: 2, peerId: new Api.PeerUser({ userId: 11n }), date: 999 }), new Api.Message({ id: 2, peerId: new Api.PeerChannel({ channelId: 11n }), date: 200 }), new Api.Message({ id: 3, peerId: new Api.PeerChat({ chatId: 12n }), date: 300 }), new Api.Message({ id: 4, peerId: new Api.PeerChat({ chatId: 13n }), date: 400 })],
}, { users: [], chats: [], dialogs: [new Api.Dialog({ peer: new Api.PeerUser({ userId: 11n }), topMessage: 1, pinned: true })], messages: [] }, { users: [], chats: [], dialogs: [], messages: [] }];
const discovery = createHistoryAdapter({ Api, client: { invoke: async request => { requests.push(request); assert.ok(request.getBytes().length > 20); return responses.shift(); } } });
const common = { limit: 100, readPeer: peer => { vaultReads++; return peers.get(`${peer.kind}:${peer.id}`); }, cachePeer: (peer, value) => peers.set(`${peer.kind}:${peer.id}`, value) };
const cursor = { folder: 0, offsetDate: 0, offsetId: '0', offsetPeer: null, excludePinned: false };
const page = await discovery.dialogs({ ...common, cursor });
assert.deepEqual(page.records.map(record => record.title), ['Native User', 'Native channel', 'Forbidden group', 'Migrated group']);
assert.equal(page.records[1].lastMessageAt, new Date(200000).toISOString());
assert.equal(page.nextCursor.offsetPeer.id, '13');
assert.equal(vaultReads, 0);
assert.deepEqual(Object.keys(page.records[0]), ['peer', 'title', 'username', 'lastMessageAt']);
const pinnedOnly = await discovery.dialogs({ ...common, cursor });
assert.deepEqual(pinnedOnly.nextCursor, { ...cursor, excludePinned: true });
assert.equal(pinnedOnly.records.length, 1);
assert.equal((await discovery.dialogs({ ...common, cursor: pinnedOnly.nextCursor })).done, true);
assert.equal(requests[2].excludePinned, true);
process.stdout.write('Telegram runtime imports and API contract passed (offline).\n');
