export async function createInvitation(cryptoApi = globalThis.crypto) {
    if (!cryptoApi?.subtle || !cryptoApi?.getRandomValues) throw new Error('Open this page over HTTPS to pair a Mac.');
    const bytes = cryptoApi.getRandomValues(new Uint8Array(32));
    const secret = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(secret));
    return { secret, invitationSha256: Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join(''), operationId: cryptoApi.randomUUID() };
}
export function canRenewDevice(device, now = Date.now()) {
    const expires = Date.parse(device.expiresAt);
    return !device.revokedAt && Number.isFinite(expires) && Math.abs(expires - now) <= 7 * 86400000;
}
export function deviceStatus(device, now = Date.now()) {
    return device.revokedAt ? 'Revoked' : Date.parse(device.expiresAt) <= now ? 'Expired' : 'Access active';
}
export function pairingError(code, retryAfterSeconds) {
    const text = ({ UNAUTHORIZED: 'Sign in again to manage your Macs.', FORBIDDEN: 'You no longer have access to manage devices.', INVALID_ORIGIN: 'Reload this workspace before trying again.',
        INVALID_INPUT: 'Check the device name and try again.', PAIRING_UNAVAILABLE: 'Pairing is unavailable. Refresh its status or try again shortly.', WORKER_UNAVAILABLE: 'This device is no longer available.',
        OPERATION_CONFLICT: 'This request changed. Refresh before trying again.', PAIRING_CLAIMED: 'This invitation was claimed. Check the device fingerprint before confirming.', PAIRING_DECIDED: 'This pairing is already closed. Its status has been refreshed.',
        WORKER_CHANGED: 'The device changed. Its status has been refreshed.', RENEWAL_UNAVAILABLE: 'Renewal is available within seven days before or after expiry. Revoked devices cannot be renewed.',
        INVITATION_LIMIT: 'Close an existing invitation or wait before creating another.', PAIRING_RATE_LIMIT: 'Too many pairing requests. Wait before trying again.', TOKEN_UNAVAILABLE: 'This device credential cannot be paired. Start a new pairing on your Mac.' })[code] || 'Unable to reach the pairing service. Try again.';
    return text + (Number.isInteger(retryAfterSeconds) && retryAfterSeconds > 0 ? ` Try again in ${retryAfterSeconds} seconds.` : '');
}
export function pairingCommand(origin) {
    const url = new URL(origin);
    if (url.origin !== origin || (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return null;
    return `node services/worker-pairing/cli.mjs --server ${url.origin} --directory /absolute/private/agora-device --name 'My Mac'`;
}
