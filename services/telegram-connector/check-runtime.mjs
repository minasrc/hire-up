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
assert.equal(typeof Api.account.GetPassword, 'function');
assert.equal(typeof Api.UpdateLoginToken, 'function');
assert.equal(typeof computeCheck, 'function');
assert.equal(new StringSession('').save(), '');
assert.equal(new Logger('none').canSend('error'), false);
process.stdout.write('Telegram runtime imports and API contract passed (offline).\n');
