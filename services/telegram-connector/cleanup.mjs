const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateCleanup(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response) || Object.keys(response).length !== 1 || !Object.hasOwn(response, 'cleanup')) throw new Error('INVALID_HOST_RESPONSE');
  const c = response.cleanup;
  if (c === null) return null;
  const keys = ['removalId', 'chatId', 'connectionId', 'accountUserId', 'peer', 'historyJobId', 'cvJobIds', 'cleanupToken'];
  if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).length !== keys.length || keys.some(k => !Object.hasOwn(c, k))
    || ![c.removalId, c.chatId, c.connectionId, c.cleanupToken].every(v => typeof v === 'string' && uuid.test(v))
    || typeof c.accountUserId !== 'string' || !/^[1-9][0-9]{0,29}$/.test(c.accountUserId)
    || (c.historyJobId !== null && !uuid.test(c.historyJobId))
    || !c.peer || Object.keys(c.peer).length !== 2 || !['user', 'chat', 'channel'].includes(c.peer.kind) || !/^[1-9][0-9]{0,29}$/.test(c.peer.id)
    || !Array.isArray(c.cvJobIds) || c.cvJobIds.length > 50 || new Set(c.cvJobIds).size !== c.cvJobIds.length || !c.cvJobIds.every(v => typeof v === 'string' && uuid.test(v))) throw new Error('INVALID_HOST_RESPONSE');
  return c;
}
// A server claim has fenced native/source leases. Unrelated committed cursors,
// pending pages, peer records, encryption keys and authentication are preserved.
export function cleanupScratch(vault, c) {
  const load = key => vault.loadHistory(c.connectionId, c.accountUserId, key);
  const remove = key => vault.removeHistoryRecord(c.connectionId, c.accountUserId, key);
  const history = load('pending-page');
  if (c.historyJobId && history?.payload?.jobId === c.historyJobId) remove('pending-page');
  const source = load('pending-source-update');
  if ((source?.payload?.chatId ?? source?.payload?.jobId) === c.chatId) remove('pending-source-update');
  const cv = load('pending-cv');
  if (c.cvJobIds.includes(cv?.jobId)) remove('pending-cv');
  for (const id of c.cvJobIds) vault.removeCvChunks(c.connectionId, c.accountUserId, id);
  const native = load('pending-native-update');
  if (native && (!native.payload?.feedId || native.payload.feedId === c.chatId)) remove('pending-native-update');
  remove(`peer:${c.peer.kind}:${c.peer.id}`);
}
