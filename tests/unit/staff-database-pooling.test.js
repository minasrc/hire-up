import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function poolConfig(connectionString, vercel) {
    let config;
    const exports = {};
    runInNewContext(ts.transpileModule(readFileSync(new URL('../../src/lib/staff-db.server.js', import.meta.url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText, {
        exports, URL, console,
        process: { env: { STAFF_DATABASE_URL: connectionString, VERCEL: vercel } },
        require: name => ({
            'server-only': {}, 'node:crypto': {}, './staff-access.js': {},
            pg: { default: { Pool: class { constructor(options) { config = options; } on() {} } } },
        })[name],
    });
    assert.ok(exports.getStaffPool());
    return config;
}

test('Vercel staff connections use the transaction pooler and preserve credentials and TLS', () => {
    const original = 'postgresql://app_staff.project:p%40ss@aws-0-eu-west-1.pooler.supabase.com:5432/postgres?sslmode=require';
    const endpoint = new URL(poolConfig(original, '1').connectionString);
    assert.equal(endpoint.port, '6543');
    assert.equal(endpoint.password, 'p%40ss');
    assert.equal(endpoint.username, 'app_staff.project');
    assert.equal(endpoint.searchParams.get('sslmode'), 'require');
    assert.equal(poolConfig(original, undefined).connectionString, original);
});

test('local, direct and already transactional database connections keep their configured endpoint', () => {
    for (const endpoint of [
        'postgresql://staff:synthetic@127.0.0.1:5432/postgres',
        'postgresql://staff:synthetic@db.project.supabase.co:5432/postgres',
        'postgresql://staff:synthetic@aws-0-eu-west-1.pooler.supabase.com:6543/postgres',
    ]) assert.equal(poolConfig(endpoint, '1').connectionString, endpoint);
});
