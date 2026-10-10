import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { saveCandidateProfileWithSnapshot } from '../../src/lib/candidate-profile-operations.js';

const identity = { provider: 'google', issuer: 'https://accounts.google.com', subject: '1002' };
const org = randomUUID();
const input = { candidateId: randomUUID(), expectedVersion: '1', fields: { fullName: 'Updated' }, operationId: randomUUID() };
const receipt = { status: 'updated', candidateId: input.candidateId, version: '2' };
const profile = { candidate: { candidateId: input.candidateId, fullName: 'Updated', version: '2' }, identifiers: [] };
function subject({ allowed = true, saveError, readError, snapshot = profile, result = receipt } = {}) {
    const queries = [];
    let connections = 0;
    const pool = { connect: async () => {
        connections++;
        return { release: () => {}, query: async (sql, params) => {
            queries.push({ sql, params });
            if (sql.includes('resolve_staff_principal_v1')) return { rows: [{ user_id: randomUUID(), membership_id: randomUUID(), role_id: randomUUID() }] };
            if (sql.includes('has_permission_v1')) return { rows: params[0].map(() => ({ allowed })) };
            if (sql.includes('save_candidate_profile_v1')) {
                if (saveError) throw saveError;
                return { rows: [{ result }] };
            }
            if (sql.includes('get_candidate_profile_v1')) {
                if (readError) throw readError;
                return { rows: [{ result: { ...snapshot, notes: ['private workspace sibling'] } }] };
            }
            return { rows: [] };
        } };
    } };
    return { queries, connections: () => connections, save: () => saveCandidateProfileWithSnapshot(pool, identity, org, input), pool };
}
test('candidate save and canonical profile snapshot share authorization and commit', async () => {
    const page = subject();
    assert.deepEqual(await page.save(), { ...receipt, profile });
    assert.equal(page.connections(), 1);
    assert.equal(page.queries.length, 6);
    assert.deepEqual(page.queries[2].params, [['candidates.read', 'candidates.write']]);
    assert.deepEqual(page.queries[4].params, [input.candidateId]);
    assert.equal(page.queries.at(-1).sql, 'commit');
});
test('snapshot failure rolls back the mutation instead of acknowledging incomplete content', async () => {
    const failure = Object.assign(new Error('profile unavailable'), { code: '42883' });
    const page = subject({ readError: failure });
    await assert.rejects(page.save(), error => error === failure);
    assert.equal(page.queries.at(-1).sql, 'rollback');
    assert.ok(!page.queries.some(query => query.sql === 'commit'));
});
test('permission and version failures do not read a profile snapshot', async () => {
    for (const config of [{ allowed: false }, { saveError: Object.assign(new Error('conflict'), { code: '40001' }) }]) {
        const page = subject(config);
        await assert.rejects(page.save());
        assert.ok(!page.queries.some(query => query.sql.includes('get_candidate_profile_v1')));
        assert.equal(page.queries.at(-1).sql, 'rollback');
    }
});
test('operation replay returns current fields and their matching version', async () => {
    const current = { ...profile, candidate: { ...profile.candidate, fullName: 'Later edit', version: '3' } };
    const page = subject({ result: { ...receipt, replayed: true }, snapshot: current });
    assert.deepEqual(await page.save(), { ...receipt, replayed: true, profile: current });
});
test('invalid input fails before connection acquisition', async () => {
    const page = subject();
    await assert.rejects(saveCandidateProfileWithSnapshot(page.pool, identity, org, { ...input, expectedVersion: '0' }), error => error.code === 'INVALID_INPUT');
    assert.equal(page.connections(), 0);
});
