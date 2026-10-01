import { resolve, dirname } from 'node:path';
import { readCredentialFile } from '../worker-pairing/vault.mjs';
import { origin } from '../worker-pairing/protocol.mjs';
// A pairing credential supplies only host identity; Telegram API keys remain local.
export function connectorCredential(file, env = process.env, configPath) {
  const path = env.TELEGRAM_CONNECTOR_CREDENTIAL_FILE ?? file.credentialFile;
  const paired = path ? readCredentialFile(resolve(configPath ? dirname(resolve(configPath)) : process.cwd(), path)) : null;
  const explicit = { server: env.TELEGRAM_CONNECTOR_SERVER ?? file.server, workerId: env.TELEGRAM_CONNECTOR_WORKER_ID ?? file.workerId, token: env.TELEGRAM_CONNECTOR_TOKEN ?? file.token };
  if (paired && ((explicit.server && origin(explicit.server) !== paired.server) || (explicit.workerId && explicit.workerId !== paired.workerId) || (explicit.token && explicit.token !== paired.token))) throw new Error('PAIRED_CREDENTIAL_CONFLICT');
  return { server: explicit.server ?? paired?.server, workerId: explicit.workerId ?? paired?.workerId, token: explicit.token ?? paired?.token };
}
