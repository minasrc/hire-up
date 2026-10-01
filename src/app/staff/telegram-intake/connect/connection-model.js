export const connectionErrors = {
    AUTH_FAILED: 'Telegram could not complete sign-in. Start a new connection to try again.',
    PASSWORD_INVALID: 'That Telegram password was not accepted. Try again.',
    LOGIN_EXPIRED: 'This sign-in attempt expired. Start a new connection.',
    SESSION_MISSING: 'The Mac no longer has this Telegram session. Connect again.',
    SESSION_REVOKED: 'This Telegram session was revoked. Connect again.',
    TELEGRAM_UNAVAILABLE: 'Telegram is temporarily unavailable. Keep the Mac connector running and retry.',
    LOGOUT_FAILED: 'Telegram has not confirmed logout. The Mac will retry. You can also revoke this session in Telegram Settings → Devices.',
};

export function connectionError(code) {
    return connectionErrors[code] || (code ? 'The connection could not be completed. Refresh the status and try again.' : '');
}

export function pollingDelay(status) {
    return ['requested', 'qr_pending', 'awaiting_password', 'disconnecting'].includes(status) ? 2000 : 15000;
}

export function usableQr(connection, now = Date.now()) {
    return connection?.status === 'qr_pending'
        && /^tg:\/\/login\?token=[A-Za-z0-9_-]{1,512}$/.test(connection.qrLoginUrl || '')
        && Date.parse(connection.qrExpiresAt) > now;
}

/** Encrypt in the browser; never include the password in a request or error. */
export async function encryptTelegramPassword(password, publicKeySpki, connection, cryptoApi = globalThis.crypto) {
    const bytes = new TextEncoder().encode(password);
    if (bytes.length < 1 || bytes.length > 128) throw new Error('Enter a Telegram password of 1–128 UTF-8 bytes.');
    if (!cryptoApi?.subtle) throw new Error('Secure sign-in requires HTTPS. Open this page using its secure address.');
    if (!publicKeySpki || !connection?.id || !connection?.challengeId || !Number.isSafeInteger(connection.generation)) {
        throw new Error('The sign-in challenge changed. Refresh the status and try again.');
    }
    try {
        const key = await cryptoApi.subtle.importKey('spki', Uint8Array.from(atob(publicKeySpki), character => character.charCodeAt(0)),
            { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
        if (key.algorithm.modulusLength !== 2048) throw new Error('Invalid key');
        const label = new TextEncoder().encode(`agora-telegram:${connection.id}:${connection.generation}:${connection.challengeId}`);
        const result = await cryptoApi.subtle.encrypt({ name: 'RSA-OAEP', label }, key, bytes);
        return btoa(String.fromCharCode(...new Uint8Array(result)));
    } catch {
        throw new Error('Secure password delivery is unavailable. Refresh the status and check the Mac connector.');
    } finally {
        bytes.fill(0);
    }
}
