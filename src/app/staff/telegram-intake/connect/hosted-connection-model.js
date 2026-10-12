const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function hostedStatus(value) {
    if (!value || !['not_requested', 'pending', 'ready', 'unavailable'].includes(value.state)
        || typeof value.serviceOnline !== 'boolean' || typeof value.workerOnline !== 'boolean'
        || (value.workerId !== null && (typeof value.workerId !== 'string' || !UUID.test(value.workerId)))) {
        throw new Error('Telegram service status is unavailable. Retry shortly.');
    }
    return {
        state: value.state, serviceOnline: value.serviceOnline,
        workerId: value.workerId, workerOnline: value.workerOnline,
        // Provider detail is never rendered as an error.
        errorCode: typeof value.errorCode === 'string' ? value.errorCode : null,
    };
}

export function hostedConnectionError(code) {
    const errors = {
        SESSION_MISSING: 'This Telegram session is no longer available. Connect again.',
        TELEGRAM_UNAVAILABLE: 'Telegram is temporarily unavailable. The service will retry.',
        LOGOUT_FAILED: 'Telegram has not confirmed logout. The service will retry. You can also revoke this session in Telegram Settings → Devices.',
    };
    return errors[code] || null;
}

// Called only by a user action. A cancelled attempt can never start sign-in.
export async function prepareHostedConnection({ prepare, read, wait, start, onStatus, signal, now = Date.now, timeoutMs = 90000, visible = () => true }) {
    const deadline = now() + timeoutMs;
    signal.throwIfAborted();
    let status = hostedStatus(await prepare(signal));
    while (true) {
        signal.throwIfAborted();
        onStatus(status);
        if (!status.serviceOnline || status.state === 'unavailable') {
            throw new Error('The Telegram service is temporarily offline or unavailable. Your imported history remains available. Retry shortly.');
        }
        if (now() >= deadline) throw new Error('Telegram setup is taking longer than expected. Click Connect again to retry.');
        if (visible() && status.state === 'ready' && status.workerOnline && status.workerId) {
            signal.throwIfAborted();
            await start(status.workerId, signal);
            return;
        }
        await wait(signal);
        signal.throwIfAborted();
        if (now() >= deadline) throw new Error('Telegram setup is taking longer than expected. Click Connect again to retry.');
        status = hostedStatus(await read(signal));
    }
}

export function hostedRequestError(status, body) {
    if (status === 429 && body?.code === 'HOSTED_CAPACITY') return 'The deployment registration limit for hosted Telegram connections has been reached. Your imported history remains available. Ask your workspace administrator for more connection capacity.';
    return [401, 403, 428].includes(status) ? 'Your workspace access needs verification. Sign in again to continue.' : 'The Telegram service is temporarily unavailable. Retry shortly.';
}

export function hostedEmergencyLogout(connection, status) {
    return Boolean(connection && (connection.status === 'disconnecting' || (connection.status !== 'disconnected' && (!status?.serviceOnline || !status?.workerOnline))));
}
