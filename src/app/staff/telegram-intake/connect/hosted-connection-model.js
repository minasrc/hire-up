const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function hostedStatus(value) {
    if (!value || !['not_requested', 'pending', 'ready', 'unavailable'].includes(value.state)
        || typeof value.serviceOnline !== 'boolean' || typeof value.workerOnline !== 'boolean'
        || (value.workerId !== null && (typeof value.workerId !== 'string' || !UUID.test(value.workerId)))) {
        throw new Error('Telegram service status is unavailable. Retry shortly.');
    }
    let enrollment = null;
    if (value.enrollment != null) {
        const e = value.enrollment;
        if (!e || typeof e !== 'object' || !UUID.test(e.requestId ?? '')
            || (e.workerId !== null && !UUID.test(e.workerId ?? '')) || e.workerId !== value.workerId
            || !['safe', 'external_revocation_required'].includes(e.retirementMode)) throw new Error('Telegram enrollment status is unavailable. Retry shortly.');
        enrollment = { requestId: e.requestId, workerId: e.workerId, retirementMode: e.retirementMode };
    }
    return {
        enrollment, state: value.state, serviceOnline: value.serviceOnline,
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
    if (status === 429 && body?.code === 'HOSTED_CAPACITY') return 'The deployment limit for active hosted Telegram connections has been reached. Your imported history remains available. Ask your workspace administrator for more connection capacity.';
    if (status === 409 && body?.code === 'TELEGRAM_REVOCATION_REQUIRED') return 'First revoke the old session in Telegram Settings → Devices, then confirm that step here.';
    if (status === 409) return 'This connection registration changed. Refresh the service status before retrying.';
    return [401, 403, 428].includes(status) ? 'Your workspace access needs verification. Sign in again to continue.' : 'The Telegram service is temporarily unavailable. Retry shortly.';
}

export function hostedEmergencyLogout(connection, status) {
    return Boolean(connection && (connection.status === 'disconnecting' || (connection.status !== 'disconnected' && (!status?.serviceOnline || !status?.workerOnline))));
}

export function hostedRetirementInput(enrollment, telegramRevoked, operationId) {
    if (!enrollment || !UUID.test(enrollment.requestId ?? '') || !UUID.test(operationId ?? '')
        || (enrollment.workerId !== null && !UUID.test(enrollment.workerId ?? ''))
        || !['safe', 'external_revocation_required'].includes(enrollment.retirementMode)
        || (enrollment.retirementMode === 'external_revocation_required' && telegramRevoked !== true)) {
        throw new Error('Revoke the old session in Telegram Settings → Devices before resetting this registration.');
    }
    return { action: 'retire', operationId, requestId: enrollment.requestId, expectedWorkerId: enrollment.workerId, telegramRevoked: telegramRevoked === true };
}
export function retirementMessage(reason) {
    return reason === 'external_revocation_attested'
        ? 'Registration reset after your confirmation of revocation in Telegram. Imported history is preserved. Click Connect Telegram to create a new connection.'
        : 'Registration reset. Imported history is preserved. Click Connect Telegram to create a new connection.';
}
