import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { workerDeviceInput, workerPairingInput, workerDeviceFilters, workerPairingFingerprint, WorkerPairingError } from '../../src/lib/worker-pairing-contracts.js';
import { readWorkerPairingJson, workerPairingError } from '../../src/lib/worker-pairing-http.js';
import { workerPairingOperation } from '../../src/lib/worker-pairing-operations.js';
test('pairing validators reject owner routing, malformed claims and ambiguous cursors', () => {
    const invite = { action: 'invite', operationId: randomUUID(), invitationSha256: 'a'.repeat(64), name: 'Recruiter Mac' };
    assert.deepEqual(workerDeviceInput(invite), invite);
    assert.throws(() => workerDeviceInput({ ...invite, ownerId: randomUUID() }));
    assert.throws(() => workerDeviceInput({ ...invite, name: '\ud800' }));
    const claim = { pairingId: randomUUID(), claimId: randomUUID(), deviceName: 'Mac', tokenSha256: 'b'.repeat(64), verifierSha256: 'c'.repeat(64) };
    assert.deepEqual(workerPairingInput('claim', claim), claim);
    assert.equal(workerPairingFingerprint(claim.pairingId, claim.claimId, claim.tokenSha256, claim.verifierSha256), createHash('sha256').update(JSON.stringify(['worker-pairing-v1', claim.pairingId, claim.claimId, claim.tokenSha256, claim.verifierSha256])).digest('hex').slice(0, 12));
    assert.throws(() => workerPairingInput('claim', { ...claim, token: 'secret' }));
    const after = Buffer.from(JSON.stringify({ createdAt: new Date().toISOString(), id: randomUUID() })).toString('base64url');
    assert(workerDeviceFilters({ after }).after.id);
    assert.throws(() => workerDeviceFilters({ after, pairingId: randomUUID() }));
});
test('body bound and safe flat errors do not echo submitted secrets', async () => {
    await assert.rejects(readWorkerPairingJson(new Request('http://localhost', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: 'x'.repeat(2048) }) })), { code: 'INVALID_INPUT' });
    const response = workerPairingError(new WorkerPairingError('PAIRING_RATE_LIMIT', 429, 5));
    assert.equal(response.headers.get('retry-after'), '5');
    assert.deepEqual(await response.json(), { error: 'Too many pairing requests. Try again shortly.', code: 'PAIRING_RATE_LIMIT', retryAfterSeconds: 5 });
    const error = new Error('sensitive token SQL'); assert.equal((await workerPairingError(error).json()).error, 'Pairing is temporarily unavailable. Try again shortly.');
});
test('proof rejection commits before operation throws, preserving durable budget debit', async () => {
    const calls = []; const client = { query: async sql => { calls.push(sql); return { rows: [{ result: { ok: false, httpStatus: 404, code: 'PAIRING_UNAVAILABLE' } }] }; }, release: () => calls.push('release') };
    await assert.rejects(workerPairingOperation({ connect: async () => client }, 'poll', 'invalid', null), { code: 'PAIRING_UNAVAILABLE', status: 404 });
    assert(calls.includes('commit')); assert(!calls.includes('rollback')); assert.equal(calls.at(-1), 'release');
});
