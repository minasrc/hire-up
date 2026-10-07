import { createPublicKey } from 'node:crypto';
import { ClientJobContractError } from './client-job-contracts.js';
import { assertUuid } from './candidate-profile-contracts.js';

const invalid = (field) => { throw new ClientJobContractError({ [field]: 'Invalid Telegram connection request.' }); };
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.isWellFormed() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const exact = (input, keys) => { if (!object(input) || Object.keys(input).some((key) => !keys.includes(key))) invalid('input'); };
const generation = (value) => { if (!Number.isSafeInteger(value) || value < 1) invalid('generation'); return value; };
const uuid = (value, key) => assertUuid(value, key);
const errorCodes = ['AUTH_FAILED', 'PASSWORD_INVALID', 'LOGIN_EXPIRED', 'SESSION_MISSING', 'SESSION_REVOKED', 'TELEGRAM_UNAVAILABLE', 'LOGOUT_FAILED'];

export function validateConnectorPublicKey(value) {
    if (typeof value !== 'string' || value.length !== 392 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) invalid('publicKeySpki');
    try {
        const bytes = Buffer.from(value, 'base64');
        const key = createPublicKey({ key: bytes, type: 'spki', format: 'der' });
        if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength !== 2048
            || key.asymmetricKeyDetails.publicExponent !== 65537n
            || key.export({ format: 'der', type: 'spki' }).toString('base64') !== value) invalid('publicKeySpki');
    } catch { invalid('publicKeySpki'); }
    return value;
}

export function validateTelegramConnectionAction(input) {
    if (input?.action === 'connect') {
        exact(input, ['action', 'workerId']);
        return { action: input.action, workerId: uuid(input.workerId, 'workerId') };
    }
    if (input?.action === 'disconnect') {
        exact(input, ['action', 'connectionId', 'generation']);
        return { action: input.action, connectionId: uuid(input.connectionId, 'connectionId'), generation: generation(input.generation) };
    }
    if (input?.action === 'password') {
        exact(input, ['action', 'connectionId', 'generation', 'challengeId', 'ciphertext']);
        if (typeof input.ciphertext !== 'string' || !/^[A-Za-z0-9+/]{342}==$/.test(input.ciphertext)
            || Buffer.from(input.ciphertext, 'base64').toString('base64') !== input.ciphertext) invalid('ciphertext');
        return { action: input.action, connectionId: uuid(input.connectionId, 'connectionId'), generation: generation(input.generation),
            challengeId: uuid(input.challengeId, 'challengeId'), ciphertext: input.ciphertext };
    }
    invalid('action');
}

export function validateTelegramConnectionReport(input, now = Date.now()) {
    exact(input, ['connectionId', 'generation', 'leaseToken', 'status', 'challengeId', 'qrLoginUrl', 'qrExpiresAt', 'passwordHint', 'profile', 'errorCode', 'passwordSubmissionId']);
    const report = { status: input.status };
    if (!['qr_pending', 'awaiting_password', 'connected', 'disconnecting', 'disconnected', 'failed'].includes(input.status)) invalid('status');
    if (input.errorCode != null) {
        if (!errorCodes.includes(input.errorCode)) invalid('errorCode');
        report.errorCode = input.errorCode;
    }
    if (input.passwordSubmissionId != null) report.passwordSubmissionId = uuid(input.passwordSubmissionId, 'passwordSubmissionId');
    if (['qr_pending', 'awaiting_password'].includes(input.status)) report.challengeId = uuid(input.challengeId, 'challengeId');
    if (input.status === 'qr_pending') {
        if (typeof input.qrLoginUrl !== 'string' || !/^tg:\/\/login\?token=[A-Za-z0-9_-]{1,512}$/.test(input.qrLoginUrl)) invalid('qrLoginUrl');
        const expiry = typeof input.qrExpiresAt === 'string' ? Date.parse(input.qrExpiresAt) : NaN;
        if (!Number.isFinite(expiry) || expiry <= now || expiry > now + 120000) invalid('qrExpiresAt');
        report.qrLoginUrl = input.qrLoginUrl; report.qrExpiresAt = new Date(expiry).toISOString();
    }
    if (input.status === 'awaiting_password' && input.passwordHint != null) {
        if (!text(input.passwordHint, 100)) invalid('passwordHint');
        report.passwordHint = input.passwordHint;
    }
    if (input.status === 'connected') {
        exact(input.profile, ['telegramUserId', 'username', 'displayName']);
        if (typeof input.profile.telegramUserId !== 'string' || !/^[0-9]{1,30}$/.test(input.profile.telegramUserId)
            || !text(input.profile.displayName, 200) || !input.profile.displayName.trim()
            || (input.profile.username != null && (typeof input.profile.username !== 'string' || !/^[A-Za-z0-9_]{5,32}$/.test(input.profile.username)))) invalid('profile');
        report.profile = { telegramUserId: input.profile.telegramUserId, username: input.profile.username ?? null, displayName: input.profile.displayName.trim() };
    }
    return { connectionId: uuid(input.connectionId, 'connectionId'), generation: generation(input.generation), leaseToken: uuid(input.leaseToken, 'leaseToken'), report };
}
