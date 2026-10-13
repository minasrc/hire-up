import assert from 'node:assert/strict';
import test from 'node:test';
import { staffWorkspaceFetch, staffWorkspaceUrl, refreshStaffWorkspace } from '../../src/lib/staff-workspace-fetch.js';

const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';

test('browser requests carry the rendered workspace without leaking it to private file storage', async t => {
    const original = { fetch: globalThis.fetch, window: globalThis.window, document: globalThis.document };
    t.after(() => Object.assign(globalThis, original));
    let visible = first;
    const calls = [], events = [];
    globalThis.document = { querySelector: () => ({ content: visible }) };
    globalThis.window = { location: { origin: 'https://app.test' }, dispatchEvent: event => events.push(event.type) };
    globalThis.fetch = async (url, input) => { calls.push({ url, input }); return Response.json({ ok: true }); };
    const body = JSON.stringify({ title: 'Synthetic title' });
    await staffWorkspaceFetch('/api/staff/jobs', { method: 'POST', body, headers: { 'content-type': 'application/json' } });
    assert.equal(calls[0].input.headers.get('x-staff-workspace-id'), first);
    assert.equal(calls[0].input.headers.get('content-type'), 'application/json');
    assert.equal(calls[0].input.body, body);
    await staffWorkspaceFetch('https://storage.test/private-signed-document', { headers: { authorization: 'synthetic-storage-proof' } });
    assert.equal(calls[1].input.headers.has('x-staff-workspace-id'), false);
    assert.equal(calls[1].input.headers.get('authorization'), 'synthetic-storage-proof');
    let cancelled = false;
    globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }),
        { status: 409, headers: { 'x-staff-workspace-changed': '1' } });
    const denied = await staffWorkspaceFetch('/api/staff/jobs');
    assert.equal(denied.status, 409); assert.equal((await denied.json()).code, 'WORKSPACE_CHANGED');
    assert.equal(cancelled, true); assert.deepEqual(events, ['staff-workspace-changed']);
    globalThis.fetch = async () => { visible = second; return Response.json({ privateRecord: 'must not reach stale form' }); };
    const stale = await staffWorkspaceFetch('/api/staff/candidates');
    assert.equal((await stale.json()).code, 'WORKSPACE_CHANGED');
    assert.equal(events.length, 2);
});

test('programmatic staff navigation binds its URL to the rendered workspace and preserves filters without external leakage', t => {
    const original = { window: globalThis.window, document: globalThis.document };
    t.after(() => Object.assign(globalThis, original));
    const location = new URL('https://app.test/staff/jobs?q=typescript');
    globalThis.window = { location };
    globalThis.document = { querySelector: () => ({ content: first, dataset: { multiWorkspace: '1' } }) };
    assert.equal(staffWorkspaceUrl('/staff/jobs?q=rust&page=2'), `/staff/jobs?q=rust&page=2&_workspace=${first}`);
    assert.equal(staffWorkspaceUrl('/staff/candidates?source=telegram#details'), `/staff/candidates?source=telegram&_workspace=${first}#details`);
    assert.equal(staffWorkspaceUrl(`?q=go&_workspace=${second}`), `/staff/jobs?q=go&_workspace=${first}`);
    assert.equal(staffWorkspaceUrl('https://storage.test/private'), 'https://storage.test/private');
    const calls = [];
    const router = { refresh: () => calls.push(['refresh']), replace: (href, options) => calls.push(['replace', href, options]) };
    refreshStaffWorkspace(router);
    assert.deepEqual(calls, [['replace', `/staff/jobs?q=typescript&_workspace=${first}`, { scroll: false }]]);
    location.searchParams.set('_workspace', first); refreshStaffWorkspace(router);
    assert.deepEqual(calls.at(-1), ['refresh']);
    globalThis.document = { querySelector: () => ({ content: first, dataset: { multiWorkspace: '0' } }) };
    assert.equal(staffWorkspaceUrl('/staff/jobs?q=rust'), '/staff/jobs?q=rust');
});
