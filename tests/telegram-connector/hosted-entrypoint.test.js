import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { terminateChild } from '../../services/telegram-hosted/supervisor.mjs';

test('actual supervised connector starts SDK and acknowledges synthetic hosted heartbeat', { timeout: 40000 }, async t => {
  assert.equal(process.versions.node.split('.')[0], '22');
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'connector-entrypoint-'));
  chmodSync(root, 0o700);
  let heartbeats = 0, claims = 0;
  const token = 'S'.repeat(64);
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    const body = JSON.parse(Buffer.concat(chunks));
    let response;
    if (req.url === '/api/telegram-connection/worker/heartbeat') {
      assert.match(body.publicKeySpki, /^[A-Za-z0-9+/]+=*$/); heartbeats++; response = { ok: true };
    } else if (req.url === '/api/telegram-connection/worker/claim') {
      claims++; response = { connection: null };
    } else { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response));
  });
  server.listen(0, '127.0.0.1');
  try { await once(server, 'listening'); } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
  const configPath = join(root, 'connector.json');
  writeFileSync(configPath, JSON.stringify({ server: `http://127.0.0.1:${server.address().port}`, workerId: randomUUID(),
    token, apiId: 12345, apiHash: 'a'.repeat(32), stateDirectory: join(root, 'state') }), { mode: 0o600 });
  const child = fork(fileURLToPath(new URL('../../services/telegram-connector/run.mjs', import.meta.url)), [], {
    execPath: process.execPath, execArgv: [], env: { PATH: process.env.PATH, HOME: process.env.HOME,
      TELEGRAM_CONNECTOR_CONFIG: configPath, TELEGRAM_CONNECTOR_SUPERVISED: '1' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let renewal;
  t.after(async () => {
    clearInterval(renewal); await terminateChild(child);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  const codes = [];
  const ready = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`Entrypoint stalled at fixed codes: ${codes.join(',')}`)), 30000);
    child.on('message', message => {
      if (message?.type !== 'telegram-connector-status' || typeof message.code !== 'string') return;
      codes.push(message.code);
      if (codes.includes('CONNECTOR_STARTED') && codes.includes('CONNECTOR_HEARTBEAT_ACKNOWLEDGED')) {
        clearTimeout(deadline); resolve();
      }
    });
    child.once('exit', () => { clearTimeout(deadline); reject(new Error('Connector exited before readiness')); });
  });
  const leaseToken = randomUUID();
  const grant = () => { if (child.connected) child.send({ type: 'telegram-hosted-lease', leaseToken, deadline: Date.now() + 10000 }, () => {}); };
  await once(child, 'spawn'); grant(); renewal = setInterval(grant, 300);
  await ready;
  assert.ok(heartbeats > 0); assert.ok(codes.includes('CONNECTOR_SDK_READY'));
  const claimDeadline = Date.now() + 5000;
  while (claims === 0 && Date.now() < claimDeadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(claims > 0);
  assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
});
