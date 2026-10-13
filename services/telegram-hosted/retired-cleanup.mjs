const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateRetiredClaim(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)
    || Object.keys(response).length !== 2 || response.protocolVersion !== 1
    || !Array.isArray(response.requests) || response.requests.length > 5) throw new Error('INVALID_HOST_RESPONSE');
  const seen = new Set();
  for (const row of response.requests) {
    const keys = ['requestId', 'workerId', 'organizationId', 'ownerUserId', 'cleanupToken'];
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== keys.length
      || keys.some(key => !Object.hasOwn(row, key))
      || ![row.requestId, row.organizationId, row.ownerUserId, row.cleanupToken].every(v => typeof v === 'string' && uuid.test(v))
      || (row.workerId !== null && (typeof row.workerId !== 'string' || !uuid.test(row.workerId)))
      || seen.has(row.requestId)) throw new Error('INVALID_HOST_RESPONSE');
    seen.add(row.requestId);
  }
  return response.requests;
}
export function createRetiredCleanup({ control, store, instanceId, proof, valid, stopRequest,
  onLeaseLost, wall = Date.now, output = () => {} }) {
  let requested = false, busy = false, next = 0;
  return {
    hint(pending) { if (pending === true) requested = true; },
    async tick() {
      if (!requested || busy || !valid() || wall() < next) return;
      busy = true; next = wall() + 300000;
      const leaseToken = proof();
      try {
        const rows = validateRetiredClaim(await control('retiredCleanupClaim', { instanceId, leaseToken }));
        if (!valid() || proof() !== leaseToken) return;
        requested = rows.length > 0;
        let blocked = false;
        for (const row of rows) {
          if (!valid() || proof() !== leaseToken) return;
          let erased = false;
          try {
            // Observed exit precedes any disk operation. Restart/orphan PID
            // locks are separately verified by the private store.
            await stopRequest(row.requestId);
            if (!valid() || proof() !== leaseToken) return;
            await store.eraseRetired(row); erased = true;
            if (!valid() || proof() !== leaseToken) return;
            const result = await control('retiredCleanupAck', { instanceId, leaseToken,
              requestId: row.requestId, workerId: row.workerId, cleanupToken: row.cleanupToken });
            if (result?.ok !== true || Object.keys(result).length !== 1) throw new Error('INVALID_HOST_RESPONSE');
            output('RETIRED_VAULT_CLEANED');
          } catch (error) {
            if (['ACCESS_DENIED', 'LEASE_CONFLICT', 'INVALID_HOST_RESPONSE'].includes(error.message)) throw error;
            blocked = true;
            output(erased ? 'RETIRED_VAULT_ACK_PENDING' : error.message === 'RETIRED_VAULT_STILL_RUNNING' ? error.message : 'RETIRED_VAULT_UNVERIFIABLE');
          }
        }
        if (!blocked && requested) next = wall() + 10000;
      } catch (error) {
        output('RETIRED_VAULT_CLEANUP_DEFERRED');
        if (['ACCESS_DENIED', 'LEASE_CONFLICT', 'INVALID_HOST_RESPONSE'].includes(error.message)) onLeaseLost?.();
      } finally { busy = false; }
    },
  };
}
