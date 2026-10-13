const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class TelegramHostedError extends Error {
    constructor(code = 'INVALID_INPUT', status = 400) { super(code); this.code = code; this.status = status; }
}
export function hostedUuid(value) {
    if (typeof value !== 'string' || !uuid.test(value)) throw new TelegramHostedError();
    return value;
}
function shape(input, required, optional = []) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !required.every(k => Object.hasOwn(input, k)) || Object.keys(input).some(k => !required.includes(k) && !optional.includes(k))) throw new TelegramHostedError();
}
export function hostedStaffInput(input) {
    shape(input, ['action']);
    if (input.action !== 'prepare') throw new TelegramHostedError();
    return input;
}
export function hostedRetireInput(input) {
    shape(input, ['action', 'operationId', 'requestId', 'expectedWorkerId', 'telegramRevoked']);
    if (input.action !== 'retire' || typeof input.telegramRevoked !== 'boolean') throw new TelegramHostedError();
    hostedUuid(input.operationId); hostedUuid(input.requestId);
    if (input.expectedWorkerId !== null) hostedUuid(input.expectedWorkerId);
    return input;
}
export function hostedControlInput(input) {
    if (['heartbeat', 'sync'].includes(input?.action)) shape(input, ['action', 'instanceId'], ['leaseToken']);
    else if (input?.action === 'retiredCleanupClaim') shape(input, ['action', 'instanceId', 'leaseToken']);
    else if (input?.action === 'retiredCleanupAck') shape(input, ['action', 'instanceId', 'leaseToken', 'requestId', 'workerId', 'cleanupToken']);
    else if (['list', 'maintenance'].includes(input?.action)) shape(input, ['action', 'instanceId', 'leaseToken'], input.action === 'list' ? ['after'] : []);
    else if (input?.action === 'register') shape(input, ['action', 'instanceId', 'leaseToken', 'requestId', 'workerId', 'tokenSha256']);
    else throw new TelegramHostedError();
    hostedUuid(input.instanceId);
    if (Object.hasOwn(input, 'leaseToken')) hostedUuid(input.leaseToken);
    if (Object.hasOwn(input, 'after') && input.after !== null) hostedUuid(input.after);
    if (input.action === 'retiredCleanupAck') {
        hostedUuid(input.requestId); hostedUuid(input.cleanupToken);
        if (input.workerId !== null) hostedUuid(input.workerId);
    }
    if (input.action === 'register') {
        hostedUuid(input.requestId); hostedUuid(input.workerId);
        if (!/^[a-f0-9]{64}$/.test(input.tokenSha256 ?? '') || typeof input.tokenSha256 !== 'string') throw new TelegramHostedError();
    }
    return input;
}
