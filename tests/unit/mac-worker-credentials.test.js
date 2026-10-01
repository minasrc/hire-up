import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, chmodSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostedCredentialGuard } from '../../services/worker-pairing/hosted-credential.mjs';
import { loadConfig as extractionConfig, readToken } from '../../services/telegram-extraction-worker/config.mjs';
import { loadConfig as semanticConfig } from '../../services/semantic-worker/config.mjs';
import { loadConfig as cvConfig } from '../../services/cv-analysis-worker/config.mjs';
import { main as extractionMain } from '../../services/telegram-extraction-worker/cli.mjs';
import { main as semanticMain } from '../../services/semantic-worker/cli.mjs';
import { main as cvMain } from '../../services/cv-analysis-worker/cli.mjs';
import { createPendingStore as extractionStore } from '../../services/telegram-extraction-worker/store.mjs';
import { createPendingStore as semanticStore } from '../../services/semantic-worker/store.mjs';
import { createPendingStore as cvStore } from '../../services/cv-analysis-worker/vault.mjs';
import { INDEX_VERSION, PROJECTION_VERSION, CHUNKER_VERSION, MODEL } from '../../services/semantic-worker/constants.mjs';
function setup(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'worker-credential-'))); chmodSync(root, 0o700); t.after(() => rmSync(root, { recursive: true, force: true }));
  const credentialFile = join(root, 'paired.json'), tokenFile = join(root, 'token'), configPath = join(root, 'config.json');
  const credential = { version: 1, server: 'https://synthetic.example', workerId: randomUUID(), token: 't'.repeat(64), name: 'Mac', expiresAt: new Date(Date.now() + 86400000).toISOString(), organization: { id: randomUUID(), name: 'Workspace' } };
  const writeCredential = value => writeFileSync(credentialFile, JSON.stringify(value), { mode: 0o600 }); writeCredential(credential); writeFileSync(tokenFile, credential.token, { mode: 0o600 });
  const config = { credentialFile: './paired.json', providerBaseUrl: 'http://127.0.0.1:8317/v1', providerModel: 'synthetic-model', providerTokenFile: './token', embeddingUrl: 'http://127.0.0.1:8828', embeddingTokenFile: './token', stateDirectory: './state' };
  const writeConfig = value => writeFileSync(configPath, JSON.stringify(value), { mode: 0o600 }); writeConfig(config);
  return { root, credentialFile, tokenFile, credential, config, configPath, writeConfig, writeCredential };
}
const loaders = [extractionConfig, semanticConfig, cvConfig];
test('paired config supplies same server and path for each worker; legacy settings remain valid', async t => {
  const f = setup(t);
  for (const load of loaders) {
    const config = await load(f.configPath, {}); assert.equal(config.serverUrl, f.credential.server); assert.equal(config.credentialFile, f.credentialFile); assert.equal(config.workerTokenFile, undefined);
    const guard = await createHostedCredentialGuard(config, readToken); assert.equal(guard.workerToken, f.credential.token); await guard.check();
  }
  const { credentialFile: unused, ...legacy } = f.config; assert.ok(unused); f.writeConfig({ ...legacy, serverUrl: f.credential.server, workerTokenFile: './token' });
  for (const load of loaders) { const config = await load(f.configPath, {}); assert.equal(config.credentialFile, undefined); assert.equal((await createHostedCredentialGuard(config, readToken)).workerToken, f.credential.token); }
});
test('environment overrides resolve relative paired files, fail closed on mixed origin/token mismatch', async t => {
  const f = setup(t);
  for (const [load, prefix] of [[extractionConfig, 'TELEGRAM_EXTRACTION'], [cvConfig, 'CV_ANALYSIS'], [semanticConfig, 'SEMANTIC']]) {
    const config = await load(f.configPath, { [`${prefix}_CREDENTIAL_FILE`]: 'paired.json', [`${prefix}_WORKER_TOKEN_FILE`]: 'token' });
    assert.equal(config.credentialFile, f.credentialFile); await (await createHostedCredentialGuard(config, readToken)).check();
    await assert.rejects(load(f.configPath, { [`${prefix}_SERVER_URL`]: 'https://another.example' }), { code: 'CREDENTIAL_UNAVAILABLE' });
  }
  f.writeConfig({ ...f.config, workerTokenFile: './token' }); writeFileSync(f.tokenFile, 'x'.repeat(64));
  for (const load of loaders) await assert.rejects(createHostedCredentialGuard(await load(f.configPath, {}), readToken), { code: 'CREDENTIAL_UNAVAILABLE' });
});
test('same-token renewal permits metadata changes; token, worker UUID and origin replacements fence requests', async t => {
  const f = setup(t), config = await extractionConfig(f.configPath, {}), guard = await createHostedCredentialGuard(config, readToken);
  f.writeCredential({ ...f.credential, name: 'Renamed device', expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(), organization: { ...f.credential.organization, name: 'Renamed workspace' } }); await guard.check();
  for (const change of [{ token: 'x'.repeat(64) }, { workerId: randomUUID() }, { server: 'https://another.example' }]) {
    f.writeCredential({ ...f.credential, ...change }); await assert.rejects(guard.check(), { code: 'CREDENTIAL_UNAVAILABLE', status: 401 });
  }
  f.writeCredential(f.credential); await guard.check();
});
test('private reader rejects permissions, symlinks, and malformed credential without disclosing content', async t => {
  const f = setup(t); chmodSync(f.credentialFile, 0o644); await assert.rejects(extractionConfig(f.configPath, {}), { code: 'CREDENTIAL_UNAVAILABLE' }); chmodSync(f.credentialFile, 0o600);
  const alias = join(f.root, 'alias.json'); symlinkSync(f.credentialFile, alias); f.writeConfig({ ...f.config, credentialFile: alias }); await assert.rejects(cvConfig(f.configPath, {}), { code: 'CREDENTIAL_UNAVAILABLE' });
  f.writeConfig(f.config); writeFileSync(f.credentialFile, f.credential.token); await assert.rejects(semanticConfig(f.configPath, {}), e => e.code === 'CREDENTIAL_UNAVAILABLE' && !String(e).includes(f.credential.token));
});
test('same paired identity reopens every existing legacy encrypted receipt namespace', async t => {
  const f = setup(t), config = await extractionConfig(f.configPath, {}), guard = await createHostedCredentialGuard(config, readToken);
  for (const [index, factory] of [extractionStore, semanticStore, cvStore].entries()) {
    const root = join(f.root, `state-${index}`); const prior = factory({ root, server: f.credential.server, workerToken: f.credential.token }); prior.save({ receipt: 'existing encrypted job' });
    const paired = factory({ root, server: config.serverUrl, workerToken: guard.workerToken }); assert.deepEqual(paired.load(), { receipt: 'existing encrypted job' });
  }
});
test('all actual CLI entrypoints send paired token without requiring raw token copy', async t => {
  const f = setup(t); const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { requests.push({ url, authorization: options.headers.Authorization }); return Response.json({ job: null }); });
  for (const [index, main] of [extractionMain, cvMain, semanticMain].entries()) {
    f.writeConfig({ ...f.config, stateDirectory: `./cli-state-${index}` }); await main(['--config', f.configPath, '--once']);
  }
  assert.equal(requests.length, 3); assert.deepEqual(requests.map(r => r.authorization), Array(3).fill(`Bearer ${f.credential.token}`)); assert.ok(requests.every(r => r.url.startsWith(f.credential.server)));
});
test('replacement during synthetic inference stops actual semantic CLI before hosted completion and retains receipt', async t => {
  const f = setup(t), query = 'synthetic candidate', seen = [];
  const job = { id: randomUUID(), kind: 'query', leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 120000).toISOString(), indexVersion: INDEX_VERSION, projectionVersion: PROJECTION_VERSION, chunkerVersion: CHUNKER_VERSION, query, querySha256: createHash('sha256').update(query).digest('hex') };
  t.mock.method(globalThis, 'fetch', async url => {
    seen.push(url);
    if (url.endsWith('/claim')) return Response.json({ job });
    if (url.endsWith('/v1/embeddings')) { f.writeCredential({ ...f.credential, workerId: randomUUID() }); return Response.json({ model: MODEL, index_version: INDEX_VERSION, data: [{ index: 0, embedding: [1, ...Array(383).fill(0)] }] }); }
    assert.fail('Replacement identity must not submit a hosted completion.');
  });
  await assert.rejects(semanticMain(['--config', f.configPath, '--once']), { code: 'CREDENTIAL_UNAVAILABLE' });
  assert.equal(seen.length, 2); const saved = semanticStore({ root: join(f.root, 'state'), server: f.credential.server, workerToken: f.credential.token }).load(); assert.equal(saved.body.jobId, job.id);
});
