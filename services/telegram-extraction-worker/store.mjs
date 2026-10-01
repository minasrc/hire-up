import { createHash } from 'node:crypto';
import { createVault } from '../telegram-connector/vault.mjs';

// Credentials bind this queue to one worker owner and one hosted origin. Token
// rotation starts a new scope instead of replaying another owner's private data.
export function createPendingStore({ root, server, workerToken }) {
  const digest = createHash('sha256').update(`telegram-extraction:${workerToken}`).digest('hex');
  const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
  const vault = createVault({ root, server, workerId: id });
  return {
    load: () => vault.loadHistory(id, '1', 'pending-extraction'),
    save: value => vault.saveHistory(id, '1', 'pending-extraction', value),
    clear: () => vault.removeHistoryRecord(id, '1', 'pending-extraction'),
  };
}
