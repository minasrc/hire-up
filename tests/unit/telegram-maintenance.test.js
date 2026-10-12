import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { handleTelegramMaintenance, runTelegramMaintenance, telegramMaintenancePoolOptions } from '../../src/lib/telegram-maintenance.js';
import { drainMaintenance, requestMaintenance, runMaintenanceCommand } from '../../scripts/run-telegram-maintenance.mjs';

const secret = 'a'.repeat(43);
const counts = { ownersProcessed: 1, batchesPurged: 2, messagesPurged: 40, bytesFreed: 5120, queriesExpired: 3, queryResultRowsDeleted: 100, analysesPurged: 0, remainingWork: false };
const request = (headers = {}, path = '', method = 'GET') => new Request(`https://synthetic.invalid/api/telegram-maintenance${path}`, { method, headers });

test('maintenance preserves existing database connection options without a custom CA', () => {
    const connectionString = 'postgresql://maintenance:synthetic@db.example.test/app?sslmode=verify-full';
    for (const ca of [undefined, '']) {
        assert.deepEqual(telegramMaintenancePoolOptions(connectionString, ca), {
            connectionString, max: 1, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000,
        });
    }
});

test('maintenance custom CA survives pg URL parsing and enforces certificate and hostname verification', () => {
    const ca = '-----BEGIN CERTIFICATE-----\nsynthetic-test-ca\n-----END CERTIFICATE-----\n';
    for (const sslParameters of [
        'sslmode=verify-full', 'sslmode=no-verify', 'sslmode=disable&ssl=0',
        'sslmode=require&uselibpqcompat=true',
        'sslrootcert=/nonexistent/ca&sslcert=/nonexistent/cert&sslkey=/nonexistent/key',
        'sslmode=disable&sslmode=no-verify&sslnegotiation=direct',
    ]) {
        const options = telegramMaintenancePoolOptions(`postgresql://maintenance:p%40ss@db.example.test:6543/app?${sslParameters}&application_name=maintenance`, ca);
        // Exercise the driver's real parsing precedence; it must not read URL
        // certificate paths or replace the explicit TLS configuration.
        const parsed = new pg.Client(options).connectionParameters;
        assert.deepEqual(parsed.ssl, { ca, rejectUnauthorized: true });
        assert.equal(parsed.ssl.checkServerIdentity, undefined);
        assert.equal(parsed.host, 'db.example.test');
        assert.equal(parsed.port, 6543);
        assert.equal(parsed.user, 'maintenance');
        assert.equal(parsed.password, 'p@ss');
        assert.equal(parsed.database, 'app');
        assert.equal(parsed.application_name, 'maintenance');
    }
    assert.throws(() => telegramMaintenancePoolOptions('http://db.example.test/app', ca), /Invalid database URL/);
});

test('maintenance authenticates before opening a database pool and rejects browser and parameterized requests', async () => {
    let opened = 0;
    const options = { secret, getPool: () => { opened++; return {}; }, run: async () => counts };
    for (const header of [undefined, 'Bearer bad', `Bearer ${'b'.repeat(43)}`, `Basic ${secret}`]) {
        const result = await handleTelegramMaintenance(request(header ? { authorization: header } : {}), options);
        assert.equal(result.status, 401);
    }
    assert.equal((await handleTelegramMaintenance(request({ origin: 'https://synthetic.invalid', authorization: `Bearer ${secret}` }), options)).status, 403);
    assert.equal((await handleTelegramMaintenance(request({ authorization: `Bearer ${secret}` }, '?owner=arbitrary'), options)).status, 400);
    assert.equal((await handleTelegramMaintenance(request({}, '', 'POST'), options)).status, 405);
    assert.equal(opened, 0);
    const result = await handleTelegramMaintenance(request({ authorization: `Bearer ${secret}` }), options);
    assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(await result.json(), { ok: true, ...counts }); assert.equal(opened, 1);
});

test('maintenance fails closed and never returns secrets, database errors or extra record fields', async () => {
    const req = request({ authorization: `Bearer ${secret}` });
    const unopened = () => { assert.fail('Unconfigured route must not open pool'); };
    assert.equal((await handleTelegramMaintenance(req, { secret: '', getPool: unopened })).status, 503);
    assert.equal((await handleTelegramMaintenance(req, { secret, getPool: () => null })).status, 503);
    const fail = await handleTelegramMaintenance(req, { secret, getPool: () => ({}), run: async () => { throw new Error(`private source ${secret}`); } });
    assert.equal(fail.status, 503); assert.doesNotMatch(await fail.text(), /private source|aaa/);
    const success = await handleTelegramMaintenance(req, { secret, getPool: () => ({}), run: async () => ({ ...counts, source: 'private conversation' }) });
    assert.deepEqual(await success.json(), { ok: true, ...counts });
    const invalid = await handleTelegramMaintenance(req, { secret, getPool: () => ({}), run: async () => ({ ...counts, bytesFreed: 'private data' }) });
    assert.equal(invalid.status, 503);
});

test('maintenance uses the restricted role and rolls back and releases failed transactions', async () => {
    for (const failed of [false, true]) {
        const calls = []; let released = false;
        const client = { query: async sql => { calls.push(sql); if (sql.startsWith('select') && failed) throw new Error('SYNTHETIC_FAILURE'); return { rows: [{ result: counts }] }; }, release: () => { released = true; } };
        const result = runTelegramMaintenance({ connect: async () => client });
        if (failed) await assert.rejects(result, /SYNTHETIC_FAILURE/); else assert.deepEqual(await result, counts);
        assert.match(calls[0], /set local role app_telegram_maintenance/); assert.match(calls[0], /statement_timeout='10s'/);
        assert.equal(calls[1], 'select app.telegram_maintenance_v1() as result');
        assert.equal(calls[2], failed ? 'rollback' : 'commit'); assert.equal(released, true);
    }
});

test('scheduler targets the configured HTTPS endpoint without redirects and prints aggregate counts only', async () => {
    let requests = 0;
    const fetchImpl = async (url, options) => {
        requests++; assert.equal(url.href, 'https://synthetic.invalid/api/telegram-maintenance');
        assert.equal(options.redirect, 'error'); assert.equal(options.headers.authorization, `Bearer ${secret}`);
        assert.ok(options.signal instanceof AbortSignal);
        return Response.json({ ok: true, ...counts, source: 'do not print this' });
    };
    assert.deepEqual(await requestMaintenance({ url: 'https://synthetic.invalid/api/telegram-maintenance', secret, fetchImpl }), counts);
    assert.equal(requests, 1);
    for (const url of ['http://synthetic.invalid/api/telegram-maintenance', 'https://u:p@synthetic.invalid/api/telegram-maintenance', 'https://synthetic.invalid/api/telegram-maintenance?owner=1', 'https://synthetic.invalid/other']) {
        await assert.rejects(requestMaintenance({ url, secret, fetchImpl }), /Invalid maintenance URL/);
    }
    await assert.rejects(requestMaintenance({ url: 'https://synthetic.invalid/api/telegram-maintenance', secret: 'short', fetchImpl }), /credential/);
    assert.equal(requests, 1);
    await assert.rejects(requestMaintenance({ url: 'https://synthetic.invalid/api/telegram-maintenance', secret, fetchImpl: async () => new Response('secret failure', { status: 503 }) }), /HTTP 503/);
    await assert.rejects(requestMaintenance({ url: 'https://synthetic.invalid/api/telegram-maintenance', secret, fetchImpl: async () => new Response('x'.repeat(5000)) }), /Invalid maintenance response/);
});

test('scheduler drains bounded pages and yields when consumers still hold sources', async () => {
    const busy = await drainMaintenance({}, async () => ({ ...counts, remainingWork: true }));
    assert.equal(busy.runs, 8); assert.equal(busy.queryResultRowsDeleted, 800); assert.equal(busy.remainingWork, true);
    const held = await drainMaintenance({}, async () => ({ ...counts, batchesPurged: 0, queriesExpired: 0, queryResultRowsDeleted: 0, remainingWork: true }));
    assert.equal(held.runs, 1);
    const empty = await drainMaintenance({}, async () => counts); assert.equal(empty.runs, 1);
});


test('analysis cleanup counts are bounded aggregates and keep scheduled cleanup moving', async () => {
    const req = request({ authorization: `Bearer ${secret}` });
    const options = { secret, getPool: () => ({}), run: async () => ({ ...counts, analysesPurged: 2 }) };
    assert.equal((await (await handleTelegramMaintenance(req, options)).json()).analysesPurged, 2);
    options.run = async () => ({ ...counts, analysesPurged: 'private parsed text' });
    assert.equal((await handleTelegramMaintenance(req, options)).status, 503);
    const older = { ...counts }; delete older.analysesPurged;
    options.run = async () => older;
    assert.equal((await (await handleTelegramMaintenance(req, options)).json()).analysesPurged, 0);
    assert.equal((await requestMaintenance({ url: 'https://synthetic.invalid/api/telegram-maintenance', secret,
        fetchImpl: async () => Response.json({ ok: true, ...older }) })).analysesPurged, 0);
    const draining = await drainMaintenance({}, async () => ({ ...counts, batchesPurged: 0, queriesExpired: 0,
        queryResultRowsDeleted: 0, analysesPurged: 2, remainingWork: true }));
    assert.equal(draining.runs, 8); assert.equal(draining.analysesPurged, 16);
});

test('scheduled cleanup fails visibly when either required secret is absent without sending a request', async () => {
    for (const environment of [{}, { TELEGRAM_MAINTENANCE_URL: 'https://synthetic.invalid/api/telegram-maintenance' }, { TELEGRAM_MAINTENANCE_SECRET: secret }]) {
        const errors = []; const summaries = [];
        const code = await runMaintenanceCommand({ environment, drain: async () => assert.fail('Incomplete configuration must not send a request'),
            log: () => assert.fail('Unconfigured cleanup must not log success'), error: message => errors.push(message), summary: message => summaries.push(message) });
        assert.equal(code, 1);
        assert.match(errors.join(''), /not configured; no request sent/);
        assert.match(summaries.join(''), /failed.*configuration is incomplete/);
        assert.doesNotMatch(errors.join(''), /aaa/);
    }
});

test('scheduled cleanup reports actual completion and an actionable remaining-work state', async () => {
    const logs = []; const summaries = [];
    const environment = { TELEGRAM_MAINTENANCE_URL: 'https://synthetic.invalid/api/telegram-maintenance', TELEGRAM_MAINTENANCE_SECRET: secret };
    const result = { ...counts, runs: 8, remainingWork: true };
    assert.equal(await runMaintenanceCommand({ environment, drain: async options => { assert.equal(options.secret, secret); return result; },
        log: message => logs.push(message), error: () => assert.fail('Completed requests should not fail'), summary: message => summaries.push(message) }), 0);
    assert.deepEqual(JSON.parse(logs[0]), result);
    assert.match(logs[1], /pending work/);
    assert.match(summaries.join(''), /8 bounded request/);
    assert.doesNotMatch([...logs, ...summaries].join(''), /aaa|synthetic.invalid/);
    const errors = [];
    assert.equal(await runMaintenanceCommand({ environment, drain: async () => { throw new Error(`private conversation ${secret}`); },
        log: () => assert.fail('Failed requests must not log success'), error: message => errors.push(message), summary: () => {} }), 1);
    assert.match(errors.join(''), /maintenance failed/);
    assert.doesNotMatch(errors.join(''), /private conversation|aaa/);
});
