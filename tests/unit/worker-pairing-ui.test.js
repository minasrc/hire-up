import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import test from 'node:test';
import { canRenewDevice, createInvitation, deviceStatus, pairingCommand, pairingError } from '../../src/app/staff/telegram-intake/connect/pairing-model.js';

test('pairing invitation uses independent 32-byte CSPRNG secrets and hashes their UTF8 value', async () => {
    const a = await createInvitation(webcrypto); const b = await createInvitation(webcrypto);
    assert.match(a.secret, /^[A-Za-z0-9_-]{43}$/); assert.equal(Buffer.from(a.secret, 'base64url').length, 32);
    assert.notEqual(a.secret, b.secret); assert.notEqual(a.operationId, b.operationId);
    assert.equal(a.invitationSha256, createHash('sha256').update(a.secret, 'utf8').digest('hex'));
    assert.notEqual(a.invitationSha256, createHash('sha256').update(Buffer.from(a.secret, 'base64url')).digest('hex'));
    await assert.rejects(createInvitation({}), /HTTPS/);
});
test('renewal is offered only inside the seven-day window and never for revoked devices', () => {
    const now = Date.parse('2030-01-15T12:00:00Z'); const day = 86400000;
    for (const offset of [-7, -1, 0, 1, 7]) assert.equal(canRenewDevice({ expiresAt: new Date(now + offset * day).toISOString(), revokedAt: null }, now), true);
    for (const offset of [-7 * day - 1, 7 * day + 1]) assert.equal(canRenewDevice({ expiresAt: new Date(now + offset).toISOString() }, now), false);
    assert.equal(canRenewDevice({ expiresAt: new Date(now).toISOString(), revokedAt: '2030-01-01' }, now), false);
    assert.equal(canRenewDevice({ expiresAt: 'bad' }, now), false);
    assert.equal(deviceStatus({ expiresAt: new Date(now).toISOString() }, now), 'Expired');
    assert.equal(deviceStatus({ expiresAt: '2040-01-01', revokedAt: '2030-01-01' }, now), 'Revoked');
});
test('setup command contains public origin only and fixed errors cannot echo server detail', () => {
    assert.equal(pairingCommand('https://platform.example'), "node services/worker-pairing/cli.mjs --server https://platform.example --directory /absolute/private/agora-device --name 'My Mac'");
    for (const origin of ['http://platform.example', 'https://platform.example/?secret=x', 'https://user:password@platform.example']) assert.equal(pairingCommand(origin), null);
    assert.match(pairingError('PAIRING_RATE_LIMIT', 30), /30 seconds/);
    assert.equal(pairingError('private-provider-secret').includes('private-provider-secret'), false);
});
