// Offline installation smoke check: inspect the actual pinned runtime without
// constructing a client or contacting Telegram.
import assert from 'node:assert/strict';
import { TelegramClient, Api } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { Logger } from 'teleproto/extensions';
import { computeCheck } from 'teleproto/Password.js';
import { createTelegramFactory } from './telegram-adapter.mjs';
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
assert.equal(typeof Api.UpdateLoginToken, 'function');
assert.equal(typeof computeCheck, 'function');
assert.equal(new StringSession('').save(), '');
assert.equal(new Logger('none').canSend('error'), false);
process.stdout.write('Telegram runtime imports and API contract passed (offline).\n');
