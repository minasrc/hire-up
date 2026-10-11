import assert from 'node:assert/strict';
import test from 'node:test';
import { createStaffTimeZoneModel, timeZoneDismissalKey } from '../../src/app/staff/time-zone-model.ts';

function subject(overrides = {}) {
    let now = 0, detected = 'Europe/Madrid', required = false, detectCalls = 0;
    const requests = [], refreshes = [], requiredCalls = [], values = new Map(), storageReads = [];
    let respond = async body => ({ ok: true, status: 200, result: { timeZone: body.timeZone, version: '2' } });
    const model = createStaffTimeZoneModel({
        accountId: 'account-a', initial: { timeZone: null, version: '0' },
        detect: () => { detectCalls++; return detected; }, now: () => now,
        storage: () => ({ getItem: key => { storageReads.push(key); return values.get(key) ?? null; }, setItem: (key, value) => values.set(key, value) }),
        request: async (body, signal) => { requests.push({ body, signal }); return respond(body); },
        refresh: () => refreshes.push('refresh'),
        auth: { requestEpoch: () => 7, getSnapshot: () => ({ required }), require: (...args) => { requiredCalls.push(args); required = true; } },
        ...overrides,
    });
    return { model, requests, refreshes, requiredCalls, values, storageReads, detectCalls: () => detectCalls,
        setNow: value => { now = value; }, setDetected: value => { detected = value; },
        setRequired: value => { required = value; }, setRespond: value => { respond = value; } };
}

test('construction is inert and detection is throttled', () => {
    const page = subject();
    assert.deepEqual(page.model.getSnapshot().preference, { timeZone: null, version: '0' });
    assert.equal(page.model.getSnapshot().prompt, null);
    assert.equal(page.detectCalls(), 0); assert.equal(page.requests.length, 0); assert.equal(page.storageReads.length, 0);
    page.model.detect();
    assert.equal(page.model.getSnapshot().prompt.timeZone, 'Europe/Madrid');
    page.model.detect(); assert.equal(page.detectCalls(), 1);
    page.setNow(60001); page.setDetected('Asia/Tokyo'); page.model.detect();
    assert.equal(page.model.getSnapshot().prompt.timeZone, 'Asia/Tokyo');
});

test('clock rollback triggers travel detection instead of throttling', () => {
    const page = subject();
    page.setNow(100000); page.model.detect();
    page.setNow(90000); page.setDetected('Asia/Tokyo'); page.model.detect();
    assert.equal(page.detectCalls(), 2);
    assert.equal(page.model.getSnapshot().prompt.timeZone, 'Asia/Tokyo');
    assert.equal(page.requests.length, 0);
});

test('canonical aliases do not prompt and null UTC can offer a choice', () => {
    const eastern = subject({ initial: { timeZone: 'US/Eastern', version: '1' }, detect: () => 'America/New_York' });
    eastern.model.detect(); assert.equal(eastern.model.getSnapshot().prompt, null);
    const utc = subject({ initial: { timeZone: 'UTC', version: '1' }, detect: () => 'Etc/UTC' });
    utc.model.detect(); assert.equal(utc.model.getSnapshot().prompt, null);
    const empty = subject({ detect: () => 'UTC' }); empty.model.detect(); assert.equal(empty.model.getSnapshot().prompt.timeZone, 'UTC');
});

test('dismissals are scoped to account, saved value and detected zone', () => {
    const page = subject(); page.model.detect(); const key = page.model.getSnapshot().prompt.key;
    page.model.dismiss(); assert.equal(page.values.get(key), '1'); assert.equal(page.requests.length, 0);
    assert.notEqual(timeZoneDismissalKey('account-b', null, 'Europe/Madrid'), key);
    assert.notEqual(timeZoneDismissalKey('account-a', null, 'Asia/Tokyo'), key);
});

test('one pending save commits once, refreshes once and never replays', async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const page = subject(); page.setRespond(() => pending);
    const first = page.model.save('Europe/Madrid');
    assert.equal(await page.model.save('Europe/Madrid'), false); assert.equal(page.requests.length, 1);
    release({ ok: true, status: 200, result: { timeZone: 'Europe/Madrid', version: '2' } });
    assert.equal(await first, true);
    assert.deepEqual(page.model.getSnapshot().preference, { timeZone: 'Europe/Madrid', version: '2' });
    assert.equal(page.refreshes.length, 1);
    assert.equal(await page.model.save('Europe/Madrid'), true); assert.equal(page.requests.length, 1);
});

test('errors retain preferences and require explicit retries', async () => {
    for (const response of [
        { ok: false, status: 503, result: null },
        { ok: true, status: 200, result: { timeZone: 'Bad/Zone', version: '2' } },
    ]) {
        const page = subject(); page.setRespond(async () => response);
        assert.equal(await page.model.save('Europe/Madrid'), false);
        assert.deepEqual(page.model.getSnapshot().preference, { timeZone: null, version: '0' });
        assert.equal(page.refreshes.length, 0); assert.ok(page.model.getSnapshot().error);
    }
});

test('auth and conflicts never replay writes', async () => {
    for (const status of [401, 428]) {
        const page = subject(); page.setRespond(async () => ({ ok: false, status, result: null }));
        await page.model.save('Europe/Madrid');
        assert.deepEqual(page.requiredCalls, [[status, 7, 'save']]); assert.equal(page.requests.length, 1);
        page.model.refreshAfterRecovery(); assert.equal(page.requests.length, 1);
    }
    const conflict = subject(); conflict.setRespond(async () => ({ ok: false, status: 409, result: null }));
    await conflict.model.save('Europe/Madrid'); assert.equal(conflict.model.getSnapshot().errorKind, 'conflict');
    conflict.model.receive({ timeZone: 'UTC', version: '2' }); assert.equal(conflict.model.getSnapshot().preference.version, '2');
});

test('deactivation ignores late responses and cannot refresh another account', async () => {
    let release;
    const page = subject(); page.setRespond(() => new Promise(resolve => { release = resolve; }));
    const saving = page.model.save('Europe/Madrid'); page.model.deactivate();
    release({ ok: true, status: 200, result: { timeZone: 'Europe/Madrid', version: '2' } });
    assert.equal(await saving, false); assert.equal(page.refreshes.length, 0);
    assert.deepEqual(page.model.getSnapshot().preference, { timeZone: null, version: '0' });
});

test('late success while access is lost queues one read after recovery, never another write', async () => {
    let release;
    const page = subject(); page.setRespond(() => new Promise(resolve => { release = resolve; }));
    const saving = page.model.save('Europe/Madrid');
    page.setRequired(true);
    release({ ok: true, status: 200, result: { timeZone: 'Europe/Madrid', version: '2' } });
    assert.equal(await saving, true);
    assert.equal(page.model.getSnapshot().preference.timeZone, 'Europe/Madrid');
    page.model.refreshAfterRecovery();
    assert.equal(page.refreshes.length, 0);
    page.setRequired(false);
    page.model.refreshAfterRecovery(); page.model.refreshAfterRecovery();
    assert.equal(page.refreshes.length, 1);
    assert.equal(page.requests.length, 1);
});

test('dismissal survives recreation and is not shared with another saved zone or account', () => {
    const values = new Map();
    const storage = () => ({ getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) });
    const first = subject({ storage }); first.model.detect(); first.model.dismiss();
    const reloaded = subject({ storage }); reloaded.model.detect();
    assert.equal(reloaded.model.getSnapshot().prompt, null);
    const other = subject({ storage, accountId: 'account-b' }); other.model.detect();
    assert.equal(other.model.getSnapshot().prompt.timeZone, 'Europe/Madrid');
    const changed = subject({ storage, initial: { timeZone: 'UTC', version: '2' } }); changed.model.detect();
    assert.equal(changed.model.getSnapshot().prompt.timeZone, 'Europe/Madrid');
    assert.equal(first.requests.length + reloaded.requests.length + other.requests.length + changed.requests.length, 0);
});

test('blocked browser storage retains the current-session dismissal', () => {
    const page = subject({ storage: () => { throw new Error('blocked storage'); } });
    page.model.detect(); page.model.dismiss(); page.setNow(60001); page.model.detect();
    assert.equal(page.model.getSnapshot().prompt, null);
    assert.equal(page.requests.length, 0);
});

test('transport failure and explicit retry preserve the old zone until success', async () => {
    const page = subject(); page.setRespond(async () => { throw new Error('offline'); });
    assert.equal(await page.model.save('Europe/Madrid'), false);
    assert.deepEqual(page.model.getSnapshot().preference, { timeZone: null, version: '0' });
    page.model.detect(); page.model.refreshAfterRecovery();
    assert.equal(page.requests.length, 1);
    assert.equal(page.refreshes.length, 0);
    page.setRespond(async body => ({ ok: true, status: 200, result: { timeZone: body.timeZone, version: '1' } }));
    assert.equal(await page.model.save('Europe/Madrid'), true);
    assert.equal(page.requests.length, 2);
    assert.equal(page.refreshes.length, 1);
    assert.deepEqual(page.requests[1].body, { timeZone: 'Europe/Madrid', expectedVersion: '0' });
});

test('stale server seeds cannot replace accepted preferences and conflict retries use the newer version', async () => {
    const page = subject();
    await page.model.save('Europe/Madrid');
    page.model.receive({ timeZone: 'UTC', version: '1' });
    assert.deepEqual(page.model.getSnapshot().preference, { timeZone: 'Europe/Madrid', version: '2' });
    assert.deepEqual(page.model.getServerSnapshot().preference, { timeZone: null, version: '0' });
    page.setRespond(async () => ({ ok: false, status: 409, result: null }));
    await page.model.save('Asia/Tokyo');
    page.model.receive({ timeZone: 'UTC', version: '3' });
    assert.equal(page.requests.length, 2);
    page.setRespond(async body => ({ ok: true, status: 200, result: { timeZone: body.timeZone, version: '4' } }));
    await page.model.save('Asia/Tokyo');
    assert.equal(page.requests[2].body.expectedVersion, '3');
});

test('manual selection dismisses only the new saved/device pair', async () => {
    const page = subject(); page.model.detect();
    await page.model.save('Asia/Tokyo', 'manual');
    assert.equal(page.values.get(timeZoneDismissalKey('account-a', 'Asia/Tokyo', 'Europe/Madrid')), '1');
    assert.equal(page.model.getSnapshot().prompt, null);
    assert.equal(page.requests.length, 1);
});

test('an account mismatch keeps the previous zone and requires a reload', async () => {
    const page = subject(); page.setRespond(async () => ({ ok: false, status: 409, code: 'ACCOUNT_CHANGED', result: null }));
    assert.equal(await page.model.save('Europe/Madrid'), false);
    assert.match(page.model.getSnapshot().error, /signed-in account changed/);
    assert.deepEqual(page.model.getSnapshot().preference, { timeZone: null, version: '0' });
    assert.equal(page.refreshes.length, 0);
});
