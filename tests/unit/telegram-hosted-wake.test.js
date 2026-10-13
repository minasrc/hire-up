import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { hostedWakeCursor, hostedWakeInput, hostedWakeChannel, sessionDatabaseUrl, waitForHostedWake } from '../../src/lib/telegram-hosted-wake.js';
const id = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const rows = [{ requestId: id, wakeEpoch: '0', workerId: null, state: 'pending', canRun: true }];
const input = { instanceId: id, leaseToken: second, cursor: hostedWakeCursor(rows) };
class Client extends EventEmitter {
    calls = []; reads = 0;
    constructor(read = () => rows) { super(); this.read = read; }
    async query(sql, args) {
        this.calls.push([sql, args]);
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
        if (sql.includes('pg_advisory_unlock')) return { rows: [{ pg_advisory_unlock: true }] };
        if (sql.startsWith('select')) return { rows: [{ result: { requests: await this.read(++this.reads, this) } }] };
        return { rows: [] };
    }
}
function clean(client) {
    assert.equal(client.listenerCount('notification'), 0); assert.equal(client.listenerCount('error'), 0);
    assert.ok(client.calls.some(([sql]) => /^UNLISTEN telegram_hosted_/.test(sql)));
    if (client.calls.some(([sql]) => sql.includes('pg_try_advisory_lock'))) assert.ok(client.calls.some(([sql]) => sql.includes('pg_advisory_unlock')));
}
test('wake contracts reject extra scope, malformed cursors and missing epochs', () => {
    assert.deepEqual(hostedWakeInput(input), input);
    for (const value of [{ ...input, ownerUserId: id }, { ...input, cursor: 'A'.repeat(64) }, { ...input, leaseToken: null }]) assert.throws(() => hostedWakeInput(value));
    for (const value of [[{ requestId: id }], [{ requestId: id, wakeEpoch: 0 }], [{ requestId: id, wakeEpoch: '9223372036854775808' }], [{ requestId: id, wakeEpoch: '-1' }], Array(11).fill(rows[0]), [rows[0], rows[0]]]) assert.throws(() => hostedWakeCursor(value));
    assert.equal(hostedWakeChannel(id.toUpperCase()), 'telegram_hosted_' + id.replaceAll('-', ''));
    assert.throws(() => hostedWakeChannel('invalid; select 1'));
    const more = [...rows, { requestId: second, wakeEpoch: '9223372036854775807', workerId: null, state: 'pending', canRun: true, ownerUserId: id }];
    assert.equal(hostedWakeCursor(more), hostedWakeCursor([...more].reverse()));
    assert.equal(hostedWakeCursor(rows), hostedWakeCursor([{ ...rows[0], secret: 'ignored' }]));
});
test('LISTEN precedes authoritative lease query and changed snapshot returns only cursor', async () => {
    const client = new Client(() => [{ requestId: id, wakeEpoch: '1', workerId: null, state: 'pending', canRun: true }]);
    const result = await waitForHostedWake(client, id, input);
    assert.deepEqual(result, { protocolVersion: 1, cursor: hostedWakeCursor([{ requestId: id, wakeEpoch: '1', workerId: null, state: 'pending', canRun: true }]), changed: true });
    assert.match(client.calls[0][0], /^LISTEN /); assert.match(client.calls[1][0], /set local role app_telegram_hosted_service/);
    assert.match(client.calls[2][0], /app.telegram_hosted_wake_snapshot_v1/);
    assert.ok(!client.calls.some(([sql]) => /heartbeat|sync_v1/.test(sql)));
    assert.deepEqual(client.calls[2][1], [id, id, second]); assert.equal(client.reads, 1); clean(client);
});
test('notification during initial query is retained and storms cause only one recheck', async () => {
    const client = new Client((read, connection) => {
        if (read === 1) { for (let n = 0; n < 100; n++) connection.emit('notification', { channel: hostedWakeChannel(id), payload: 'wake' }); return rows; }
        return [{ requestId: id, wakeEpoch: '1', workerId: null, state: 'pending', canRun: true }];
    });
    assert.equal((await waitForHostedWake(client, id, input)).changed, true);
    assert.equal(client.reads, 2); clean(client);
});
test('timeout rechecks authorization; unrelated notifications do not wake', async () => {
    const client = new Client((read, connection) => { connection.emit('notification', { channel: hostedWakeChannel(second) }); return rows; });
    assert.deepEqual(await waitForHostedWake(client, id, input, { waitMs: 5 }), { protocolVersion: 1, cursor: input.cursor, changed: false });
    assert.equal(client.reads, 2); clean(client);
});
test('revoked lease on final query rejects and rolls back', async () => {
    const client = new Client(read => { if (read === 2) throw Object.assign(new Error('lease changed'), { code: '40001' }); return rows; });
    await assert.rejects(waitForHostedWake(client, id, input, { waitMs: 0 }), { code: '40001' });
    assert.ok(client.calls.some(([sql]) => sql === 'rollback')); clean(client);
});
test('abort and database connection errors release waiting handlers', async () => {
    for (const mode of ['abort', 'error']) {
        const controller = new AbortController();
        const client = new Client((read, connection) => {
            if (read === 1) setImmediate(() => mode === 'abort' ? controller.abort() : connection.emit('error', new Error('connection lost')));
            return rows;
        });
        await assert.rejects(waitForHostedWake(client, id, input, { signal: controller.signal }), mode === 'abort' ? { name: 'AbortError' } : /connection lost/);
        clean(client);
    }
});

test('registration, stopped state and permission changes alter cursor without epoch change', () => {
    for (const patch of [{ workerId: second }, { state: 'registered' }, { state: 'stopped' }, { canRun: false }])
        assert.notEqual(hostedWakeCursor([{ ...rows[0], ...patch }]), input.cursor);
    for (const patch of [{ workerId: undefined }, { workerId: 'bad' }, { state: 'ready' }, { canRun: 'true' }, { canRun: undefined }])
        assert.throws(() => hostedWakeCursor([{ ...rows[0], ...patch }]));
});
test('session URL conversion is restricted to official Supabase transaction pool endpoint', () => {
    assert.equal(sessionDatabaseUrl('postgres://user:secret@aws-0-eu.pooler.supabase.com:6543/postgres?sslmode=require'), 'postgres://user:secret@aws-0-eu.pooler.supabase.com:5432/postgres?sslmode=require');
    for (const url of ['postgres://u:p@localhost:6543/db', 'postgresql://u:p@x.pooler.supabase.com:5432/db', 'postgres://u:p@pooler.supabase.com.evil:6543/db']) assert.equal(sessionDatabaseUrl(url), url);
    for (const url of ['https://localhost/db', 'secret', 'postgres:///db']) assert.throws(() => sessionDatabaseUrl(url));
});
test('non-wake payloads do not interrupt long poll', async () => {
    const client = new Client((read, connection) => { connection.emit('notification', { channel: hostedWakeChannel(id), payload: 'forged' }); return rows; });
    const result = await waitForHostedWake(client, id, input, { waitMs: 5 });
    assert.equal(result.changed, false); assert.equal(client.reads, 2); clean(client);
});
test('unchanged notification storms are coalesced without an open transaction', async () => {
    const client = new Client((read, connection) => { connection.emit('notification', { channel: hostedWakeChannel(id), payload: 'wake' }); return rows; });
    const started = Date.now();
    assert.equal((await waitForHostedWake(client, id, input, { waitMs: 35 })).changed, false);
    assert.ok(Date.now() - started >= 25); assert.equal(client.reads, 3); clean(client);
});

test('database session advisory lock bounds held waiters across app instances', async () => {
    const client = new Client();
    const baseQuery = client.query.bind(client);
    client.query = async (sql, args) => {
        if (sql.includes('pg_try_advisory_lock')) { client.calls.push([sql, args]); return { rows: [{ acquired: false }] }; }
        return baseQuery(sql, args);
    };
    await assert.rejects(waitForHostedWake(client, id, input), { code: 'WAKE_BUSY', status: 429 });
    assert.equal(client.reads, 1);
    assert.equal(client.listenerCount('notification'), 0);
    assert.match(client.calls.at(-1)[0], /^UNLISTEN /);
    assert.ok(!client.calls.some(([sql]) => sql.includes('pg_advisory_unlock')), 'never release another session lock');
    assert.deepEqual(client.calls.find(([sql]) => sql.includes('pg_try_advisory_lock'))[1], ['telegram-hosted-wake:' + id]);
});
