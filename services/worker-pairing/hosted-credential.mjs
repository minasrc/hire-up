import { isAbsolute } from 'node:path';
import { readCredentialFile } from './vault.mjs';
import { origin } from './protocol.mjs';

function unavailable() { const error = new Error('CREDENTIAL_UNAVAILABLE'); error.code = 'CREDENTIAL_UNAVAILABLE'; error.status = 401; return error; }
export function hostedCredentialConfig(raw) {
  if (raw.credentialFile === undefined) return raw;
  try {
    if (typeof raw.credentialFile !== 'string' || !isAbsolute(raw.credentialFile)) throw unavailable();
    const paired = readCredentialFile(raw.credentialFile);
    if (raw.serverUrl !== undefined && origin(raw.serverUrl) !== paired.server) throw unavailable();
    return { ...raw, serverUrl: paired.server };
  } catch { throw unavailable(); }
}

// Tokens stay in memory. Original identity is frozen for the process; metadata
// updates (including same-token renewal) do not create a new encrypted scope.
export async function createHostedCredentialGuard(config, readToken) {
  async function current() {
    try {
      const paired = config.credentialFile ? readCredentialFile(config.credentialFile) : null;
      const serverUrl = origin(config.serverUrl);
      if (paired && paired.server !== serverUrl) throw unavailable();
      const legacy = config.workerTokenFile ? await readToken(config.workerTokenFile) : null;
      if (paired && legacy !== null && legacy !== paired.token) throw unavailable();
      const workerToken = paired?.token ?? legacy;
      if (!workerToken) throw unavailable();
      return { serverUrl, workerToken, workerId: paired?.workerId ?? null };
    } catch { throw unavailable(); }
  }
  const initial = await current();
  return {
    serverUrl: initial.serverUrl,
    workerToken: initial.workerToken,
    async check() {
      const value = await current();
      if (value.serverUrl !== initial.serverUrl || value.workerToken !== initial.workerToken || value.workerId !== initial.workerId) throw unavailable();
    },
  };
}
