import assert from 'node:assert/strict';
import test from 'node:test';
import { getClient, getJobPreview, getJobWorkspace } from '../../src/lib/client-job-operations.js';
const jobId = '97000000-0000-4000-8000-000000000001';
const clientId = '97000000-0000-4000-8000-000000000002';
const org = '97000000-0000-4000-8000-000000000003';
const identity = { provider: 'google', issuer: 'https://accounts.google.com', subject: '1002' };
const workspace = { job: { id: jobId, clientId, title: 'Synthetic role' }, draft: { id: 'draft', version: '2' }, published: null };
const client = { id: clientId, name: 'Synthetic client', contactEmail: 'private@example.test' };
function fixture({ denied, jobError, clientError } = {}) {
    const calls = [];
    let connections = 0, releases = 0, active = true;
    const pool = { connect: async () => {
        connections++;
        return { release: () => { releases++; }, query: async (text, params) => {
            calls.push({ text, params });
            if (text.includes('resolve_staff_principal_v1')) return { rows: active ? [{ user_id: jobId, membership_id: clientId, role_id: org }] : [] };
            if (text.includes('has_permission_v1')) return { rows: params[0].map(permission => ({ allowed: permission !== denied })) };
            if (text.includes('get_job_workspace_v1')) { if (jobError) throw jobError; return { rows: [{ result: workspace }] }; }
            if (text.includes('get_client_v1')) { if (clientError) throw clientError; return { rows: [{ result: client }] }; }
            return { rows: [] };
        } };
    } };
    return { pool, calls, get connections() { return connections; }, get releases() { return releases; }, revoke: () => { active = false; } };
}
test('job preview preserves the old projection with one connection and one principal resolution', async () => {
    const old = fixture();
    const job = await getJobWorkspace(old.pool, identity, org, { jobId });
    const company = await getClient(old.pool, identity, org, { clientId: job.job.clientId });
    const next = fixture();
    const result = await getJobPreview(next.pool, identity, org, { jobId });
    assert.deepEqual(result, { job: job.job, draft: job.draft, published: job.published, client: { name: company.name } });
    assert.equal(old.connections, 2);
    assert.equal(next.connections, 1);
    assert.equal(next.releases, 1);
    assert.equal(next.calls.filter(call => call.text.includes('resolve_staff_principal_v1')).length, 1);
    assert.deepEqual(next.calls.find(call => call.text.includes('has_permission_v1')).params, [['jobs.read', 'clients.read']]);
    assert.deepEqual(next.calls.find(call => call.text.includes('get_client_v1')).params, [clientId]);
    assert.equal(next.calls.at(-1).text, 'commit');
    assert.ok(!JSON.stringify(result).includes('private@example.test'));
});
for (const denied of ['jobs.read', 'clients.read']) test(`preview fails closed without ${denied}`, async () => {
    const f = fixture({ denied });
    await assert.rejects(getJobPreview(f.pool, identity, org, { jobId }), { code: 'FORBIDDEN' });
    assert.ok(!f.calls.some(call => /get_job_workspace_v1|get_client_v1/.test(call.text)));
    assert.equal(f.calls.at(-1).text, 'rollback');
});
for (const input of [{ jobId: 'invalid' }, { jobId, clientId }]) test(`preview rejects invalid input before acquiring a connection ${Object.keys(input).join(',')}`, async () => {
    const f = fixture();
    await assert.rejects(getJobPreview(f.pool, identity, org, input), { code: 'INVALID_INPUT' });
    assert.equal(f.connections, 0);
});
for (const field of ['jobError', 'clientError']) test(`${field} preserves missing-record errors and rolls back`, async () => {
    const error = Object.assign(new Error('missing'), { code: 'P0002' });
    const f = fixture({ [field]: error });
    await assert.rejects(getJobPreview(f.pool, identity, org, { jobId }), caught => caught === error);
    assert.equal(f.calls.at(-1).text, 'rollback');
    assert.ok(!f.calls.some(call => call.text === 'commit'));
    assert.equal(f.releases, 1);
});
test('a later preview rechecks membership rather than reusing previous authorization', async () => {
    const f = fixture();
    await getJobPreview(f.pool, identity, org, { jobId });
    f.revoke();
    await assert.rejects(getJobPreview(f.pool, identity, org, { jobId }), { code: 'UNAUTHORIZED' });
    assert.equal(f.connections, 2);
    assert.equal(f.calls.filter(call => call.text.includes('get_job_workspace_v1')).length, 1);
});
