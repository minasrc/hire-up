import { createHash } from 'node:crypto';
import { hostedUuid, TelegramHostedError } from './telegram-hosted-contracts.js';

export function sessionDatabaseUrl(connectionString) {
    let url;
    try {
        url = new URL(connectionString);
        if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) throw new Error();
    } catch { throw new TelegramHostedError('SERVICE_UNAVAILABLE', 503); }
    if (url.hostname.toLowerCase().endsWith('.pooler.supabase.com') && url.port === '6543') {
        url.port = '5432'; return url.toString();
    }
    return connectionString;
}
export function hostedWakeInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).length !== 3 || !['instanceId', 'leaseToken', 'cursor'].every(key => Object.hasOwn(input, key))) throw new TelegramHostedError();
    hostedUuid(input.instanceId); hostedUuid(input.leaseToken);
    if (typeof input.cursor !== 'string' || !/^[a-f0-9]{64}$/.test(input.cursor)) throw new TelegramHostedError();
    return input;
}
export function hostedWakeChannel(serviceId) {
    return 'telegram_hosted_' + hostedUuid(serviceId).toLowerCase().replaceAll('-', '');
}
export function hostedWakeCursor(requests) {
    if (!Array.isArray(requests) || requests.length > 10) throw new TelegramHostedError('INVALID_SNAPSHOT', 503);
    const seen = new Set();
    const records = requests.map(record => {
        const id = hostedUuid(record?.requestId).toLowerCase();
        const epoch = record?.wakeEpoch;
        if (seen.has(id) || typeof epoch !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(epoch)
            || BigInt(epoch) > 9223372036854775807n) throw new TelegramHostedError('INVALID_SNAPSHOT', 503);
        if (record.workerId !== null) hostedUuid(record.workerId);
        if (!['pending', 'registered', 'stopped'].includes(record.state) || typeof record.canRun !== 'boolean') throw new TelegramHostedError('INVALID_SNAPSHOT', 503);
        seen.add(id); return [id, epoch, record.workerId === null ? null : record.workerId.toLowerCase(), record.state, record.canRun];
    }).sort((a, b) => a[0].localeCompare(b[0]));
    return createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

// Requires a dedicated session connection: transaction poolers cannot retain LISTEN.
// Notifications are hints only; every response revalidates the service lease.
/** @param {{signal?: AbortSignal, waitMs?: number}} [options] */
export async function waitForHostedWake(client, serviceId, input, options = {}) {
    const { signal, waitMs = 25000 } = options;
    hostedWakeInput(input);
    const channel = hostedWakeChannel(serviceId);
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 25000) throw new TelegramHostedError();
    let notified = false, failure, wake, timer, dwelling = false, locked = false;
    const started = Date.now();
    const abortError = () => Object.assign(new Error('Wake request aborted'), { name: 'AbortError' });
    const check = () => { if (signal?.aborted) throw abortError(); if (failure) throw failure; };
    const onNotification = notification => { if (notification.channel === channel && notification.payload === 'wake') { notified = true; if (!dwelling) wake?.(); } };
    const onError = error => { failure = error; wake?.(); };
    const onAbort = () => wake?.();
    const snapshot = async () => {
        check();
        try {
            await client.query("begin;set local role app_telegram_hosted_service;set local statement_timeout='5s';set local lock_timeout='2s'");
            const result = (await client.query('select app.telegram_hosted_wake_snapshot_v1($1,$2,$3) result', [serviceId, input.instanceId, input.leaseToken])).rows[0]?.result;
            const cursor = hostedWakeCursor(result?.requests);
            await client.query('commit'); check(); return cursor;
        } catch (error) { await client.query('rollback').catch(() => {}); throw error; }
    };
    client.on('notification', onNotification); client.on('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        check();
        await client.query(`LISTEN ${channel}`);
        let cursor = await snapshot();
        if (cursor !== input.cursor) return { protocolVersion: 1, cursor, changed: true };
        // Session lock bounds held waiters globally across server instances. It
        // grants no authority and is acquired only after the lease check commits.
        locked = (await client.query('select pg_try_advisory_lock(hashtextextended($1,0)) acquired', ['telegram-hosted-wake:' + serviceId.toLowerCase()])).rows[0]?.acquired === true;
        if (!locked) throw new TelegramHostedError('WAKE_BUSY', 429);
        check();
        await new Promise(resolve => {
            wake = resolve;
            timer = setTimeout(resolve, waitMs);
            if (notified || failure || signal?.aborted) resolve();
        });
        check();
        cursor = await snapshot();
        // Coalesce false/spoofed hints into at most one unchanged response per
        // second; changed snapshots still respond immediately. No SQL transaction
        // is held while dwelling, and the final query rechecks the lease.
        if (cursor === input.cursor && notified && waitMs > 0) {
            const dwell = Math.min(waitMs, 1000) - (Date.now() - started);
            if (dwell > 0) {
                clearTimeout(timer); dwelling = true;
                await new Promise(resolve => {
                    wake = resolve; timer = setTimeout(resolve, dwell);
                    if (failure || signal?.aborted) resolve();
                });
                check(); cursor = await snapshot();
            }
        }
        return { protocolVersion: 1, cursor, changed: cursor !== input.cursor };
    } finally {
        clearTimeout(timer); wake = undefined;
        signal?.removeEventListener('abort', onAbort);
        // Keep the error handler attached until the session command completes.
        await client.query(`UNLISTEN ${channel}`).catch(() => {});
        if (locked) await client.query('select pg_advisory_unlock(hashtextextended($1,0))', ['telegram-hosted-wake:' + serviceId.toLowerCase()]).catch(() => {});
        client.removeListener('notification', onNotification); client.removeListener('error', onError);
    }
}
