import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { databaseTlsConnectionOptions } from '../../src/lib/database-tls.server.js';

const ca = '-----BEGIN CERTIFICATE-----\nsynthetic-ca\n-----END CERTIFICATE-----\n';

test('database TLS preserves legacy URL behavior when no custom CA is supplied', () => {
    const connectionString = 'postgresql://worker:synthetic@db.example.test/app?sslmode=verify-full';
    for (const certificate of [undefined, '']) {
        assert.deepEqual(databaseTlsConnectionOptions(connectionString, certificate), { connectionString });
    }
});

test('custom CA enforces verification through real pg parsing despite URL TLS overrides', () => {
    for (const protocol of ['postgres', 'postgresql']) {
        for (const parameters of [
            'sslmode=verify-full', 'sslmode=no-verify', 'sslmode=disable&ssl=0',
            'sslmode=require&uselibpqcompat=true',
            'sslrootcert=/nonexistent/ca&sslcert=/nonexistent/cert&sslkey=/nonexistent/key',
            'sslmode=disable&sslmode=no-verify&sslnegotiation=direct',
            'SSLMODE=no-verify&SSL=0&UseLibpqCompat=true',
        ]) {
            const options = databaseTlsConnectionOptions(`${protocol}://worker:p%40ss@db.example.test:6543/app?${parameters}&application_name=worker`, ca);
            const parsed = new pg.Client(options).connectionParameters;
            assert.deepEqual(parsed.ssl, { ca, rejectUnauthorized: true });
            assert.equal(parsed.ssl.checkServerIdentity, undefined);
            assert.equal(parsed.host, 'db.example.test');
            assert.equal(parsed.port, 6543);
            assert.equal(parsed.user, 'worker');
            assert.equal(parsed.password, 'p@ss');
            assert.equal(parsed.database, 'app');
            assert.equal(parsed.application_name, 'worker');
        }
    }
});

test('invalid custom-CA URLs throw only a generic error without credentials or parser cause', () => {
    const secret = 'synthetic-secret-do-not-log';
    for (const connectionString of [
        `postgresql://worker:${secret}@[invalid/app`,
        `http://worker:${secret}@db.example.test/app`,
        `postgresql://worker:${secret}@/app`,
        `postgresql://worker:${secret}@db.example.test:invalid/app`,
    ]) {
        assert.throws(() => databaseTlsConnectionOptions(connectionString, ca), error => {
            assert.equal(error.message, 'Invalid database URL.');
            assert.equal(error.cause, undefined);
            for (const rendered of [String(error), error.stack, inspect(error), JSON.stringify(error)]) {
                assert.ok(!rendered.includes(secret));
                assert.ok(!rendered.includes(connectionString));
            }
            return true;
        });
    }
});

test('every worker database route configures its actual pool through the shared TLS helper', async () => {
    const directory = new URL('../../src/app/api/', import.meta.url);
    const entries = await readdir(directory, { recursive: true });
    let count = 0;
    for (const entry of entries.filter(entry => entry.endsWith('route.ts'))) {
        const source = await readFile(new URL(entry, directory), 'utf8');
        if (!source.includes('process.env.TELEGRAM_WORKER_DATABASE_URL')) continue;
        count++;
        assert.match(source, /import \{ databaseTlsConnectionOptions \} from '@\/lib\/database-tls.server'/);
        assert.match(source, /new pg\.Pool\(\{ \.\.\.databaseTlsConnectionOptions\(connectionString, process\.env\.TELEGRAM_WORKER_DATABASE_CA_CERT\), max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: (?:2000|5000) \}\)/);
        assert.equal((source.match(/new pg\.Pool/g) ?? []).length, 1);
    }
    assert.equal(count, 10);
});
