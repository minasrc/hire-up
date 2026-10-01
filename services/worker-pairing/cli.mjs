#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createPairingStore } from './vault.mjs';
import { createPairingClient } from './client.mjs';
import { PairingError, origin } from './protocol.mjs';
const SAFE = new Set(['INVALID_SERVER','INVALID_INPUT','INVALID_LOCAL_STATE','LOCAL_STATE_EXISTS','UNSAFE_LOCAL_DIRECTORY','UNSAFE_LOCAL_FILE','LOCAL_WRITE_FAILED','PAIRING_ALREADY_RUNNING','CANNOT_VERIFY_LOCK','INVALID_RESPONSE','HOST_UNAVAILABLE','CANCELLED','TTY_REQUIRED','NODE_22_REQUIRED']);
export const safeErrorCode = error => SAFE.has(error?.code) ? error.code : 'PAIRING_FAILED';
export function readHiddenInvitation(input = process.stdin, output = process.stderr, signal) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') throw new PairingError('TTY_REQUIRED');
  output.write('Paste pairing invitation (hidden), then press Enter: ');
  return new Promise((resolve, reject) => {
    let value = ''; const wasRaw = Boolean(input.isRaw);
    const finish = (error) => { input.removeListener('data', onData); input.removeListener('end', onEnd); signal?.removeEventListener('abort', onEnd); input.setRawMode(wasRaw); input.pause(); output.write('\n'); if (error) reject(error); else resolve(value); value = ''; };
    const onEnd = () => finish(new PairingError('CANCELLED'));
    const onData = buffer => {
      for (const ch of buffer.toString('utf8')) {
        if (ch === '\x03' || ch === '\x04') { finish(new PairingError('CANCELLED')); return; }
        if (ch === '\r' || ch === '\n') { finish(); return; }
        if (ch === '\x7f' || ch === '\b') value = value.slice(0, -1);
        else if (/^[A-Za-z0-9_.-]$/.test(ch)) value += ch;
        else { finish(new PairingError('INVALID_INPUT')); return; }
        if (value.length > 80) { finish(new PairingError('INVALID_INPUT')); return; }
      }
    };
    if (signal?.aborted) { reject(new PairingError('CANCELLED')); return; }
    signal?.addEventListener('abort', onEnd, { once: true });
    input.setRawMode(true); input.on('data', onData); input.once('end', onEnd); input.resume();
  });
}
export async function main(args = process.argv.slice(2), { prompt = ({ signal }) => readHiddenInvitation(process.stdin, process.stderr, signal), output = process.stdout, signal } = {}) {
  if (process.versions.node.split('.')[0] !== '22') throw new PairingError('NODE_22_REQUIRED');
  if (args.length === 1 && args[0] === '--help') { output.write('Usage: node services/worker-pairing/cli.mjs --directory /absolute/private/device [--server https://platform.example --name "My Mac"] [--unlock]\nThe invitation is entered at a hidden terminal prompt; never put it in arguments.\n'); return; }
  const options = {}; for (let i = 0; i < args.length; i++) {
    if (args[i] === '--unlock' && !options.unlock) options.unlock = true;
    else if (['--directory','--server','--name'].includes(args[i]) && args[i + 1] && !options[args[i].slice(2)]) options[args[i].slice(2)] = args[++i];
    else throw new PairingError('INVALID_INPUT');
  }
  if (!options.directory?.startsWith('/')) throw new PairingError('INVALID_INPUT');
  const store = createPairingStore({ directory: options.directory }); if (options.unlock) { store.unlock(); output.write('Stopped pairing lock removed.\n'); return; }
  const release = store.lock();
  try {
    const client = createPairingClient({ store });
    const current = store.loadPending(), configured = store.loadCredential();
    if (configured) { await client.tick(); output.write('This directory already contains a paired device. Existing credentials preserved.\n'); return; }
    if (current) {
      if ((options.server && origin(options.server) !== current.serverOrigin) || (options.name && options.name !== current.deviceName)) throw new PairingError('LOCAL_STATE_EXISTS');
    } else {
      if (!options.server || !options.name) throw new PairingError('INVALID_INPUT');
      origin(options.server);
      client.initialize({ serverOrigin: options.server, deviceName: options.name, invitation: await prompt({ signal }) });
    }
    output.write(`Device fingerprint: ${client.snapshot().fingerprint}\nCompare this fingerprint in Agora, then confirm the device there.\n`);
    while (!signal?.aborted) {
      let result;
      try { result = await client.tick({ signal }); } catch (e) { if (!['HOST_UNAVAILABLE','INVALID_RESPONSE'].includes(e.code)) throw e; result = { status: 'retry', retryAfterSeconds: 5 }; }
      if (result.status === 'approved') { output.write('Mac paired. Credentials saved privately in credential.json. Configure the connector with credentialFile; service setup is separate.\n'); return; }
      if (['expired','cancelled','access_denied','claim_conflict'].includes(result.status)) { output.write(`Pairing stopped: ${result.status}. Existing local state was preserved; use a new private directory for a new invitation.\n`); return; }
      await delay(Math.max(5, result.retryAfterSeconds ?? 5) * 1000, undefined, { signal }).catch(() => {});
    }
  } finally { release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController(); const stop = () => controller.abort(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  main(undefined, { signal: controller.signal }).catch(error => { process.stderr.write(`${safeErrorCode(error)}\n`); process.exitCode = 1; }).finally(() => { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); });
}
