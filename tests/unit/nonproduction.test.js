import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import {
    assertLocalServiceRoleKey,
    assertLocalSupabaseTarget,
    assertNonproductionTestEnvironment,
} from '../support/nonproduction.js';

const token = (payload) => `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
const localKey = token({ iss: 'supabase-demo', role: 'service_role' });
const localEnvironment = {
    E2E_REAL_BACKEND: '1',
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_SERVICE_ROLE_KEY: localKey,
};

test('allows only reviewed local API addresses, including their root trailing slash', () => {
    for (const url of [
        'http://127.0.0.1:54321',
        'http://localhost:54321',
        'http://localhost:54321/',
        'http://127.0.0.1:54321/',
    ]) {
        assert.doesNotThrow(() => assertLocalSupabaseTarget(url));
    }
});

test('rejects hosted, ambiguous, credential-bearing and non-API targets without echoing them', () => {
    for (const url of [
        undefined, '', 'not a URL',
        'https://project.supabase.co',
        'http://localhost:54322',
        'http://127.0.0.1:54321/rest/v1',
        'http://127.0.0.1:54321?token=private-value',
        'http://127.0.0.1:54321#private-value',
        'http://user:private-value@127.0.0.1:54321',
        'http://127.0.0.1.evil.invalid:54321',
        'http://localhost:54321@evil.invalid',
        'http://2130706433:54321',
        'http://0x7f000001:54321',
        'https://localhost:54321',
    ]) {
        assert.throws(() => assertLocalSupabaseTarget(url), (error) => (
            error.message.includes('explicitly allowed local')
            && !error.message.includes('private-value')
        ));
    }
});

test('rejects hosted or missing credentials even when the API URL is local', () => {
    for (const key of [
        undefined, '', 'sb_secret_hosted-value', 'not.a.jwt',
        token(null),
        token({ iss: 'supabase', role: 'service_role', ref: 'hosted-project' }),
        token({ iss: 'supabase-demo', role: 'anon' }),
        token({ iss: 'supabase-demo', role: 'service_role', ref: 'hosted-project' }),
    ]) {
        assert.throws(() => assertLocalServiceRoleKey(key), /Tests require/);
    }
    assert.doesNotThrow(() => assertLocalServiceRoleKey(localKey));
});

test('backend mode requires both target and local key before test selection', () => {
    assert.doesNotThrow(() => assertNonproductionTestEnvironment(localEnvironment));
    assert.throws(() => assertNonproductionTestEnvironment({ E2E_REAL_BACKEND: '1' }), /local Supabase API/);
    assert.throws(() => assertNonproductionTestEnvironment({
        ...localEnvironment, SUPABASE_SERVICE_ROLE_KEY: '',
    }), /SERVICE_ROLE_KEY/);
});

test('mocked mode allows absent configuration but never a configured remote target or credential', () => {
    assert.doesNotThrow(() => assertNonproductionTestEnvironment({}));
    assert.doesNotThrow(() => assertNonproductionTestEnvironment({ E2E_REAL_BACKEND: '0' }));
    assert.throws(() => assertNonproductionTestEnvironment({
        NEXT_PUBLIC_SUPABASE_URL: 'https://production.supabase.co',
    }), /local Supabase API/);
    assert.throws(() => assertNonproductionTestEnvironment({
        ...localEnvironment,
        E2E_REAL_BACKEND: '0',
        SUPABASE_SERVICE_ROLE_KEY: token({ iss: 'supabase', role: 'service_role' }),
    }), /local Supabase service-role JWT/);
});

test('typos in backend mode fail rather than silently skipping persistence checks', () => {
    for (const mode of ['', 'true', 'yes', '01']) {
        assert.throws(() => assertNonproductionTestEnvironment({
            ...localEnvironment, E2E_REAL_BACKEND: mode,
        }), /must be unset, 0 or 1/);
    }
});

test('loading the real Playwright configuration enforces the guard before running tests', () => {
    assert.throws(() => execFileSync(process.execPath, [
        '--input-type=module',
        '-e',
        'await import("./playwright.config.mjs")',
    ], {
        cwd: new URL('../../', import.meta.url),
        env: {
            ...process.env,
            E2E_REAL_BACKEND: '1',
            NEXT_PUBLIC_SUPABASE_URL: 'https://production.supabase.co',
            SUPABASE_SERVICE_ROLE_KEY: localKey,
        },
        stdio: 'pipe',
        encoding: 'utf8',
    }), (error) => error.status !== 0 && error.stderr.includes('explicitly allowed local Supabase'));
});

test('the app server cannot reuse another process or fill missing database settings from another env file', () => {
    assert.doesNotThrow(() => execFileSync(process.execPath, [
        '--input-type=module',
        '-e',
        `const { default: config } = await import("./playwright.config.mjs");
        if (config.webServer.reuseExistingServer
            || config.webServer.env.NEXT_PUBLIC_SUPABASE_URL !== ''
            || config.webServer.env.SUPABASE_SERVICE_ROLE_KEY !== '') {
            throw new Error('Unsafe server environment');
        }`,
    ], {
        cwd: new URL('../../', import.meta.url),
        env: {
            ...process.env,
            E2E_REAL_BACKEND: '0',
            NEXT_PUBLIC_SUPABASE_URL: '',
            SUPABASE_SERVICE_ROLE_KEY: '',
        },
        stdio: 'pipe',
    }));
});

function serverConfig(mode) {
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `const { default: config } = await import('./playwright.config.mjs'); console.log(JSON.stringify({ command: config.webServer.command, reuse: config.webServer.reuseExistingServer, url: config.webServer.url, workers: config.workers, projects: config.projects.map(project => project.name) }));`], {
        cwd: new URL('../../', import.meta.url), encoding: 'utf8', stdio: 'pipe',
        env: { ...process.env, E2E_SERVER_MODE: mode, E2E_REAL_BACKEND: '0', NEXT_PUBLIC_SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '' },
    }));
}

test('production browser mode serves an existing build without changing test coverage', () => {
    const config = serverConfig('production');
    assert.equal(config.command, 'npm run start -- --hostname 127.0.0.1');
    assert.equal(config.reuse, false);
    assert.equal(config.url, 'http://127.0.0.1:3000/jobs');
    assert.equal(config.workers, 2);
    assert.deepEqual(config.projects, ['desktop-chromium', 'mobile-chromium']);
});

test('local development mode is unchanged and invalid modes cannot fall back', () => {
    for (const mode of [undefined, 'development']) assert.equal(serverConfig(mode).command, 'npm run dev -- --hostname 127.0.0.1');
    for (const mode of ['', 'prod', 'arbitrary-command']) assert.throws(() => serverConfig(mode), error => error.status !== 0 && error.stderr.includes('E2E_SERVER_MODE must be development or production.'));
});

test('production browser mode still rejects a hosted backend before starting a server', () => {
    assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', 'await import("./playwright.config.mjs")'], {
        cwd: new URL('../../', import.meta.url), encoding: 'utf8', stdio: 'pipe',
        env: { ...process.env, E2E_SERVER_MODE: 'production', E2E_REAL_BACKEND: '1', NEXT_PUBLIC_SUPABASE_URL: 'https://production.supabase.co', SUPABASE_SERVICE_ROLE_KEY: localKey },
    }), error => error.status !== 0 && error.stderr.includes('explicitly allowed local Supabase'));
});
