import { dirname, isAbsolute, resolve } from 'node:path';
import { readPrivateFile } from '../telegram-extraction-worker/config.mjs';
import { SemanticWorkerError } from './constants.mjs';

export function validateConfig(raw) {
  const invalid = () => { throw new SemanticWorkerError('INVALID_CONFIG'); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid();
  let server, local;
  try { server = new URL(raw.serverUrl); local = new URL(raw.embeddingUrl ?? 'http://127.0.0.1:8817'); } catch { invalid(); }
  if (!['https:', 'http:'].includes(server.protocol) || (server.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(server.hostname)) || server.username || server.password || server.search || server.hash || server.pathname !== '/') invalid();
  if (local.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(local.hostname) || local.username || local.password || local.search || local.hash || local.pathname !== '/') invalid();
  for (const key of ['workerTokenFile', 'embeddingTokenFile', 'stateDirectory']) if (typeof raw[key] !== 'string' || !isAbsolute(raw[key])) invalid();
  return { serverUrl: server.origin, embeddingUrl: local.origin, workerTokenFile: raw.workerTokenFile, embeddingTokenFile: raw.embeddingTokenFile, stateDirectory: raw.stateDirectory };
}
export async function loadConfig(configPath, env = process.env) {
  let raw = {};
  if (configPath) {
    try { raw = JSON.parse(await readPrivateFile(resolve(configPath))); }
    catch (error) { if (error.code === 'CREDENTIAL_UNAVAILABLE') throw error; throw new SemanticWorkerError('INVALID_CONFIG'); }
  }
  const base = configPath ? dirname(resolve(configPath)) : process.cwd();
  const merged = {
    serverUrl: env.SEMANTIC_SERVER_URL ?? raw.serverUrl,
    embeddingUrl: env.SEMANTIC_EMBEDDING_URL ?? raw.embeddingUrl,
    workerTokenFile: env.SEMANTIC_WORKER_TOKEN_FILE ?? raw.workerTokenFile,
    embeddingTokenFile: env.SEMANTIC_EMBEDDING_TOKEN_FILE ?? raw.embeddingTokenFile,
    stateDirectory: env.SEMANTIC_STATE_DIRECTORY ?? raw.stateDirectory ?? 'services/semantic-worker/.runtime',
  };
  for (const key of ['workerTokenFile', 'embeddingTokenFile', 'stateDirectory']) if (typeof merged[key] === 'string' && merged[key]) merged[key] = resolve(base, merged[key]);
  return validateConfig(merged);
}
