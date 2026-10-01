import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

export class ExtractionWorkerError extends Error {
  constructor(code, status = 0) { super(code); this.code = code; this.status = status; }
}
export async function readPrivateFile(path, maxBytes = 65536) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size < 1 || stat.size > maxBytes) throw new Error();
    return await file.readFile('utf8');
  } catch { throw new ExtractionWorkerError('CREDENTIAL_UNAVAILABLE'); }
  finally { await file?.close(); }
}
export async function readToken(path) {
  const value = (await readPrivateFile(path, 4098)).trim();
  if (value.length < 16 || value.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(value)) throw new ExtractionWorkerError('CREDENTIAL_UNAVAILABLE');
  return value;
}
function safeUrl(value, originOnly) {
  let url;
  try { url = new URL(value); } catch { throw new ExtractionWorkerError('INVALID_CONFIG'); }
  if (!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) || url.username || url.password || url.search || url.hash || (originOnly && url.pathname !== '/')) throw new ExtractionWorkerError('INVALID_CONFIG');
  return originOnly ? url.origin : url.href.replace(/\/+$/, '');
}
export function validateConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ExtractionWorkerError('INVALID_CONFIG');
  if (!raw.providerBaseUrl || !raw.providerModel || !raw.providerTokenFile) throw new ExtractionWorkerError('PROVIDER_NOT_CONFIGURED');
  if (typeof raw.providerModel !== 'string' || raw.providerModel.length > 120 || raw.providerModel.includes('://') || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(raw.providerModel)) throw new ExtractionWorkerError('INVALID_CONFIG');
  for (const name of ['workerTokenFile', 'providerTokenFile']) if (typeof raw[name] !== 'string' || !isAbsolute(raw[name])) throw new ExtractionWorkerError('INVALID_CONFIG');
  return { serverUrl: safeUrl(raw.serverUrl, true), workerTokenFile: raw.workerTokenFile, providerBaseUrl: safeUrl(raw.providerBaseUrl, false), providerModel: raw.providerModel, providerTokenFile: raw.providerTokenFile, stateDirectory: resolve(raw.stateDirectory ?? 'services/telegram-extraction-worker/.runtime') };
}
export async function loadConfig(configPath, env = process.env) {
  let raw = {};
  if (configPath) {
    try { raw = JSON.parse(await readPrivateFile(resolve(configPath))); }
    catch (error) { if (error instanceof ExtractionWorkerError) throw error; throw new ExtractionWorkerError('INVALID_CONFIG'); }
  }
  const base = configPath ? dirname(resolve(configPath)) : process.cwd();
  const merged = {
    stateDirectory: resolve(base, env.TELEGRAM_EXTRACTION_STATE_DIRECTORY ?? raw.stateDirectory ?? 'services/telegram-extraction-worker/.runtime'),
    serverUrl: env.TELEGRAM_EXTRACTION_SERVER_URL ?? raw.serverUrl,
    workerTokenFile: env.TELEGRAM_EXTRACTION_WORKER_TOKEN_FILE ?? raw.workerTokenFile,
    providerBaseUrl: env.TELEGRAM_EXTRACTION_PROVIDER_BASE_URL ?? raw.providerBaseUrl,
    providerModel: env.TELEGRAM_EXTRACTION_PROVIDER_MODEL ?? raw.providerModel,
    providerTokenFile: env.TELEGRAM_EXTRACTION_PROVIDER_TOKEN_FILE ?? raw.providerTokenFile,
  };
  for (const key of ['workerTokenFile', 'providerTokenFile']) if (typeof merged[key] === 'string' && merged[key]) merged[key] = resolve(base, merged[key]);
  return validateConfig(merged);
}
