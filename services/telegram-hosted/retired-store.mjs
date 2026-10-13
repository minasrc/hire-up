import { lstat as inspect, readdir as names, rm as erase, open as openDirectory } from 'node:fs/promises';
import { constants, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { unlockStoppedProcess } from '../telegram-connector/vault.mjs';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const exists = path => { try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
// No server-provided paths. Service identity and a canonical request UUID select
// the exact retired directory; every existing node is checked before rm.
export async function eraseRetiredDirectory({ workers, scope, row, privateDirectory, readPrivateJson }) {
  if (!row || ![row.requestId, row.organizationId, row.ownerUserId, row.cleanupToken].every(v => typeof v === 'string' && uuid.test(v))
    || (row.workerId !== null && (typeof row.workerId !== 'string' || !uuid.test(row.workerId)))) throw new Error('RETIRED_VAULT_UNVERIFIABLE');
  privateDirectory(workers);
  const identity = readPrivateJson(join(dirname(workers), 'service.json'));
  if (identity.server !== scope.server || !same(identity.serviceId, scope.serviceId)) throw new Error('RETIRED_VAULT_UNVERIFIABLE');
  const directory = join(workers, row.requestId.toLowerCase());
  if (exists(directory)) {
    privateDirectory(directory);
    const credential = join(directory, 'credential.json'), config = join(directory, 'connector.json');
    if (exists(credential)) {
      const record = readPrivateJson(credential);
      if (record.server !== scope.server || !same(record.serviceId, scope.serviceId)
        || !same(record.requestId, row.requestId) || !same(record.organizationId, row.organizationId) || !same(record.ownerUserId, row.ownerUserId)
        || !uuid.test(record.workerId ?? '') || (row.workerId !== null && !same(record.workerId, row.workerId))) throw new Error('RETIRED_VAULT_UNVERIFIABLE');
    }
    if (exists(config)) {
      const record = readPrivateJson(config);
      if (record.server !== scope.server || !uuid.test(record.workerId ?? '') || (row.workerId !== null && !same(record.workerId, row.workerId))
        || record.stateDirectory !== join(directory, 'state')) throw new Error('RETIRED_VAULT_UNVERIFIABLE');
    }
    const state = join(directory, 'state');
    if (exists(state)) {
      privateDirectory(state);
      if (exists(join(state, 'connector.lock'))) {
        try { unlockStoppedProcess(state); }
        catch (error) { throw new Error(error.message === 'CONNECTOR_STILL_RUNNING' ? 'RETIRED_VAULT_STILL_RUNNING' : 'RETIRED_VAULT_UNVERIFIABLE'); }
      }
    }
    let count = 0;
    const verify = async (path, depth) => {
      if (++count > 20000 || depth > 8) throw new Error('RETIRED_VAULT_UNVERIFIABLE');
      const stat = await inspect(path);
      if (stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('RETIRED_VAULT_UNVERIFIABLE');
      if (stat.isDirectory()) for (const name of await names(path)) await verify(join(path, name), depth + 1);
      else if (!stat.isFile() || stat.nlink !== 1) throw new Error('RETIRED_VAULT_UNVERIFIABLE');
    };
    await verify(directory, 0);
    await erase(directory, { recursive: true });
  }
  // Verified absence is also a replayable proof. Flush the parent entry before
  // ACK, including recovery after deletion committed but its ACK was lost.
  const fd = await openDirectory(workers, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await fd.sync(); } finally { await fd.close(); }
}
