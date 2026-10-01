import { createHash } from 'node:crypto';
import { createVault } from '../telegram-connector/vault.mjs';

// Distinct namespace binds encrypted receipts to this origin and worker owner.
export function createPendingStore({ root, server, workerToken }) {
  const digest = createHash('sha256').update(`profile-search:${workerToken}`).digest('hex');
  const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
  const vault = createVault({ root, server, workerId: id });
  return {
    load: () => vault.loadHistory(id, '1', 'pending-semantic'),
    save: value => vault.saveHistory(id, '1', 'pending-semantic', value),
    clear: () => vault.removeHistoryRecord(id, '1', 'pending-semantic'),
  };
}
