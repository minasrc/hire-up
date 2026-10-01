import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import { connectionError, encryptTelegramPassword, pollingDelay, usableQr } from '../../src/app/staff/telegram-intake/connect/connection-model.js';

test('Telegram password is RSA-encrypted and bound to the exact connection challenge', async () => {
    const keys = await webcrypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
    const spki = Buffer.from(await webcrypto.subtle.exportKey('spki', keys.publicKey)).toString('base64');
    const connection = { id: 'connection-one', generation: 2, challengeId: 'challenge-two' };
    const ciphertext = await encryptTelegramPassword('synthetic secret 🔒', spki, connection, webcrypto);
    assert.equal(Buffer.from(ciphertext, 'base64').length, 256);
    assert.equal(ciphertext.includes('synthetic'), false);
    const bytes = Buffer.from(ciphertext, 'base64');
    const label = new TextEncoder().encode('agora-telegram:connection-one:2:challenge-two');
    assert.equal(new TextDecoder().decode(await webcrypto.subtle.decrypt({ name: 'RSA-OAEP', label }, keys.privateKey, bytes)), 'synthetic secret 🔒');
    await assert.rejects(webcrypto.subtle.decrypt({ name: 'RSA-OAEP', label: new TextEncoder().encode('agora-telegram:connection-one:3:challenge-two') }, keys.privateKey, bytes));
});

test('password byte limits and secure-context errors never echo the supplied secret', async () => {
    await assert.rejects(encryptTelegramPassword('', '', {}), /1–128/);
    await assert.rejects(encryptTelegramPassword('🔒'.repeat(33), '', {}), /1–128/);
    await assert.rejects(encryptTelegramPassword('private sentinel', '', {}, {}), /HTTPS/);
    await assert.rejects(encryptTelegramPassword('private sentinel', '', {}, webcrypto), /challenge changed/);
});

test('QR display accepts only unexpired Telegram login URLs in the QR state', () => {
    const valid = { status: 'qr_pending', qrLoginUrl: 'tg://login?token=synthetic_123', qrExpiresAt: '2030-01-01T00:00:01Z' };
    const now = Date.parse('2030-01-01T00:00:00Z');
    assert.equal(usableQr(valid, now), true);
    for (const patch of [{ status: 'connected' }, { qrLoginUrl: 'https://example.test/' }, { qrLoginUrl: 'tg://login?token=abc&redirect=https://evil.test' }, { qrExpiresAt: 'invalid' }, { qrExpiresAt: '2030-01-01T00:00:00Z' }]) {
        assert.equal(usableQr({ ...valid, ...patch }, now), false);
    }
});

test('pending actions poll promptly; fixed error text never renders provider errors', () => {
    for (const status of ['requested', 'qr_pending', 'awaiting_password', 'disconnecting']) assert.equal(pollingDelay(status), 2000);
    assert.equal(pollingDelay('connected'), 15000);
    assert.match(connectionError('LOGOUT_FAILED'), /not confirmed logout/);
    assert.match(connectionError('PASSWORD_INVALID'), /not accepted/);
    assert.equal(connectionError('provider error containing private sentinel').includes('sentinel'), false);
});
