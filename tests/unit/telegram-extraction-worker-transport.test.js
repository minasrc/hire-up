import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, validateConfig, readToken } from '../../services/telegram-extraction-worker/config.mjs';
import { requestJson } from '../../services/telegram-extraction-worker/transport.mjs';
const config = { serverUrl: 'https://app.example.test', workerTokenFile: '/private/worker', providerBaseUrl: 'http://127.0.0.1:8317/v1', providerModel: 'configured-model', providerTokenFile: '/private/provider' };

test('provider endpoint and model are required and insecure remote destinations are rejected', () => {
  assert.throws(() => validateConfig({}), /PROVIDER_NOT_CONFIGURED/);
  assert.equal(validateConfig(config).providerBaseUrl, 'http://127.0.0.1:8317/v1');
  for (const providerBaseUrl of ['http://example.test/v1', 'https://key@example.test/v1', 'https://example.test/v1?api_key=secret', 'https://example.test/v1#secret']) assert.throws(() => validateConfig({ ...config, providerBaseUrl }), /INVALID_CONFIG/);
  assert.throws(() => validateConfig({ ...config, serverUrl: 'https://app.example.test/path' }), /INVALID_CONFIG/);
  assert.throws(() => validateConfig({ ...config, providerModel: 'model\nsecret' }), /INVALID_CONFIG/);
  assert.throws(() => validateConfig({ ...config, providerModel: 'https://model.example' }), /INVALID_CONFIG/);
});

test('private config resolves credential paths without reading or exposing credentials', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'extraction-config-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'config.json');
  await writeFile(file, JSON.stringify({ ...config, workerTokenFile: 'worker.token', providerTokenFile: 'provider.token' }), { mode: 0o600 });
  const loaded = await loadConfig(file, {});
  assert.equal(loaded.providerTokenFile, join(root, 'provider.token'));
  assert.equal(loaded.workerTokenFile, join(root, 'worker.token'));
  assert.equal(loaded.providerModel, 'configured-model');
  await chmod(file, 0o644); await assert.rejects(loadConfig(file, {}), /CREDENTIAL_UNAVAILABLE/);
});

test('credential reader refuses exposed files, symlinks and newline injection', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'extraction-token-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'token'); const link = join(root, 'link');
  await writeFile(file, 'synthetic-secret-token', { mode: 0o600 });
  assert.equal(await readToken(file), 'synthetic-secret-token');
  await symlink(file, link); await assert.rejects(readToken(link), /CREDENTIAL_UNAVAILABLE/);
  await writeFile(file, 'synthetic-secret\nsecond-line'); await assert.rejects(readToken(file), /CREDENTIAL_UNAVAILABLE/);
  await chmod(file, 0o644); await assert.rejects(readToken(file), /CREDENTIAL_UNAVAILABLE/);
});

test('transport bounds bodies, refuses redirects and never includes provider errors in exceptions', async () => {
  let seen;
  const fetchImpl = async (url, request) => { seen = { url, request }; return new Response('{"ok":true}'); };
  await requestJson('http://127.0.0.1:8317/v1/chat/completions', 'synthetic-token', { messages: [] }, { fetchImpl });
  assert.equal(seen.request.redirect, 'error'); assert.equal(seen.request.headers.Authorization, 'Bearer synthetic-token');
  await assert.rejects(requestJson('https://example.test', 'key', {}, { fetchImpl: async () => new Response('raw-provider-secret', { status: 401 }) }), (error) => error.status === 401 && error.message === 'HTTP_UNAVAILABLE');
  await assert.rejects(requestJson('https://example.test', 'key', {}, { fetchImpl: async () => new Response('x'.repeat(101)), maxResponseBytes: 100 }), /INVALID_RESPONSE/);
  await assert.rejects(requestJson('https://example.test', 'key', { value: 'x'.repeat(101) }, { fetchImpl, maxRequestBytes: 100 }), /INVALID_PAYLOAD/);
  await assert.rejects(requestJson('https://example.test', 'key', {}, { fetchImpl: async () => new Response('not JSON with secret') }), (error) => error.message === 'INVALID_RESPONSE');
});

test('transport cancellation returns a fixed code rather than a raw abort reason', async () => {
  const control = new AbortController(); control.abort(new Error('sensitive details'));
  await assert.rejects(requestJson('https://example.test', 'key', {}, { signal: control.signal, fetchImpl: async (_url, request) => { request.signal.throwIfAborted(); } }), /^Error: STOPPED$/);
});

test('body streaming timeout remains a retryable transport error, without leaking partial content', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const fetchImpl = async (_url, { signal }) => new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('{"private":"partial')); signal.addEventListener('abort', () => controller.error(signal.reason), { once: true }); } }));
    await assert.rejects(requestJson('https://example.test', 'key', {}, { fetchImpl, timeoutMs: 10 }), error => error.code === 'HTTP_UNAVAILABLE' && error.message === 'HTTP_UNAVAILABLE');
  } finally { clearTimeout(keepAlive); }
});
