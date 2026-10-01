import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVault } from '../../services/telegram-connector/vault.mjs';
import { createHistoryWorker } from '../../services/telegram-connector/history-worker.mjs';
import { createHistoryAdapter, HistoryReadError, messageRecord } from '../../services/telegram-connector/history-adapter.mjs';
import { createHostClient } from '../../services/telegram-connector/http.mjs';

const connectionId = '11111111-1111-4111-8111-111111111111';
const workerId = '22222222-2222-4222-8222-222222222222';
const lease = '33333333-3333-4333-8333-333333333333';
const jobId = '44444444-4444-4444-8444-444444444444';
function fixture(t, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'telegram-history-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const vault = createVault({ root, workerId, server: 'https://synthetic.test' });
  const context = { connectionId, generation: 1, connectionLeaseToken: lease, accountUserId: '123456789012345678', connectionLeaseExpiresAt: new Date(Date.now() + 120000).toISOString(), isActive: () => true, telegram: {} };
  const job = { id: jobId, kind: 'history', connectionId, generation: 1, leaseToken: lease, leaseExpiresAt: context.connectionLeaseExpiresAt, accountUserId: context.accountUserId, pageNumber: 0, cursor: { beforeMessageId: null, upperMessageId: null }, peer: { kind: 'user', id: '99999999999999999' } };
  const calls = []; let providerCalls = 0; let nextId = 1;
  context.telegram.history = async () => { providerCalls++; return { records: [{ messageId: '9', text: 'private conversation' }], nextCursor: { beforeMessageId: '9', upperMessageId: '9' }, done: false }; };
  const host = async (action, body) => { calls.push({ action, body }); return action === 'claim' ? { job } : { ok: true, status: 'queued', replayed: false }; };
  const options = { host, vault, randomId: () => `55555555-5555-4555-8555-${String(nextId++).padStart(12, '0')}`, ...extra };
  return { root, vault, context, job, calls, options, worker: createHistoryWorker(options), providerCalls: () => providerCalls };
}

test('lost acknowledgement retries exactly the same durable page without another provider read', async (t) => {
  const f = fixture(t); let lose = true;
  const options = { ...f.options, host: async (action, body) => { const result = await f.options.host(action, body); if (action === 'complete' && lose) { lose = false; throw new Error('network'); } return result; } };
  const first = createHistoryWorker(options);
  await assert.rejects(first.tick(f.context), /network/);
  assert.equal(f.providerCalls(), 1);
  const restart = createHistoryWorker(options);
  await restart.tick(f.context);
  const writes = f.calls.filter((call) => call.action === 'complete');
  assert.deepEqual(writes[0].body, writes[1].body); assert.equal(f.providerCalls(), 1);
  assert.equal(f.vault.loadHistory(connectionId, f.context.accountUserId, 'pending-page'), null);
});

test('pending-page cache supports near-limit bytes, hides content and isolates Telegram accounts', (t) => {
  const f = fixture(t); const value = { text: 'private'.repeat(36000) };
  f.vault.saveHistory(connectionId, f.context.accountUserId, 'pending-page', value);
  assert.deepEqual(f.vault.loadHistory(connectionId, f.context.accountUserId, 'pending-page'), value);
  assert.equal(f.vault.loadHistory(connectionId, '987654321', 'pending-page'), null);
  const top = join(f.root, readdirSync(f.root)[0], 'history', connectionId);
  const folder = join(top, readdirSync(top)[0]);
  assert.ok(!readFileSync(join(folder, readdirSync(folder)[0]), 'utf8').includes('privateprivate'));
  f.vault.removeHistory(connectionId); assert.equal(f.vault.loadHistory(connectionId, f.context.accountUserId, 'pending-page'), null);
});

test('account and generation fences prevent provider access and discard former-generation pending data', async (t) => {
  const f = fixture(t); f.job.accountUserId = 'other';
  await assert.rejects(f.worker.tick(f.context), /INVALID_HISTORY_RESPONSE/); assert.equal(f.providerCalls(), 0);
  f.vault.saveHistory(connectionId, f.context.accountUserId, 'pending-page', { generation: 0, payload: { jobId } });
  assert.equal((await f.worker.tick(f.context)).status, 'stale'); assert.equal(f.providerCalls(), 0);
  f.context.isActive = () => false;
  assert.equal((await f.worker.tick(f.context)).status, 'stale');
});

test('expired job lease never starts a provider request', async (t) => {
  const f = fixture(t); f.job.leaseExpiresAt = new Date(Date.now() - 1000).toISOString();
  await assert.rejects(f.worker.tick(f.context), /INVALID_HISTORY_RESPONSE/); assert.equal(f.providerCalls(), 0);
});

test('page byte budget shrinks the next raw request without advancing the cursor', async (t) => {
  const f = fixture(t, { maxRequestBytes: 1400 }); const limits = [];
  f.context.telegram.history = async ({ limit }) => { limits.push(limit); return { records: Array.from({ length: limit }, (_, i) => ({ messageId: String(100 - i), text: 'x'.repeat(100) })), nextCursor: { beforeMessageId: String(101 - limit), upperMessageId: '100' }, done: false }; };
  for (let i = 0; i < 4; i++) assert.equal((await f.worker.tick(f.context)).status, 'resizing');
  assert.deepEqual(limits, [100, 50, 25, 12]);
  assert.equal(f.calls.filter((c) => c.action === 'complete').length, 0);
  assert.equal((await f.worker.tick(f.context)).status, 'queued');
  assert.equal(f.calls.at(-1).body.fromCursor.beforeMessageId, null);
});

test('single oversized record pauses the job instead of truncating or skipping', async (t) => {
  const f = fixture(t, { maxRequestBytes: 700 });
  f.context.telegram.history = async () => ({ records: [{ messageId: '9', text: 'x'.repeat(1000) }], nextCursor: { beforeMessageId: '9', upperMessageId: '9' }, done: false });
  let result;
  for (let i = 0; i < 8; i++) { result = await f.worker.tick(f.context); if (result.status === 'deferred') break; }
  assert.equal(result.status, 'deferred'); assert.equal(f.calls.at(-1).body.code, 'MESSAGE_TOO_LARGE');
  assert.equal(f.calls.filter((c) => c.action === 'complete').length, 0);
});

test('flood wait defers with a durable cooldown and releases the job without sleeping', async (t) => {
  const f = fixture(t);
  f.context.telegram.history = async () => { throw new HistoryReadError('FLOOD_WAIT', 180); };
  assert.equal((await f.worker.tick(f.context)).status, 'deferred');
  assert.equal(f.calls.at(-1).body.retryAfterSeconds, 180);
  assert.equal(f.calls.at(-1).body.code, 'FLOOD_WAIT');
});

test('capacity pause settles the page receipt but never pretends history completed', async (t) => {
  const f = fixture(t);
  const worker = createHistoryWorker({ ...f.options, host: async (action, body) => action === 'complete' ? { ok: true, status: 'capacity_paused' } : f.options.host(action, body) });
  assert.equal((await worker.tick(f.context)).status, 'capacity_paused');
  assert.equal(f.vault.loadHistory(connectionId, f.context.accountUserId, 'pending-page'), null);
});

test('expired page lease rebinds only after verifying the same authoritative cursor and page number', async (t) => {
  const f = fixture(t); let completeCalls = 0;
  const host = async (action, body) => {
    if (action === 'complete' && ++completeCalls === 1) { const error = new Error('stale'); error.status = 409; throw error; }
    if (action === 'claim') return { job: { ...f.job, leaseToken: workerId } };
    return f.options.host(action, body);
  };
  f.vault.saveHistory(connectionId, f.context.accountUserId, 'pending-page', { generation: 1, pageNumber: 0, payload: { jobId, jobLeaseToken: lease, pageId: connectionId, fromCursor: f.job.cursor, nextCursor: { beforeMessageId: '9', upperMessageId: '9' }, records: [{ messageId: '9' }], done: false } });
  const worker = createHistoryWorker({ ...f.options, host });
  assert.equal((await worker.tick(f.context)).status, 'resizing');
  const pending = f.vault.loadHistory(connectionId, f.context.accountUserId, 'pending-page');
  assert.equal(pending.payload.jobLeaseToken, workerId); assert.notEqual(pending.payload.pageId, connectionId);
  assert.equal((await worker.tick(f.context)).status, 'queued'); assert.equal(f.providerCalls(), 0);
});

function sdkFixture() {
  class Value { constructor(value) { Object.assign(this, value); } }
  class GetDialogs extends Value {}
  class GetHistory extends Value {}
  const Api = { messages: { GetDialogs, GetHistory }, InputPeerChat: Value, InputPeerUser: Value, InputPeerChannel: Value, InputPeerEmpty: Value, InputPeerSelf: Value };
  const queue = []; const calls = []; const peers = new Map();
  const client = { invoke: async (request, dc, options) => { calls.push({ request, dc, options }); const result = queue.shift(); if (result instanceof Error) throw result; return result; } };
  const common = { readPeer: (peer) => peers.get(`${peer.kind}:${peer.id}`), cachePeer: (peer, value) => peers.set(`${peer.kind}:${peer.id}`, value), accountUserId: '123', limit: 100 };
  return { adapter: createHistoryAdapter({ client, Api }), queue, calls, peers, common, Api };
}

test('SDK history reads are bounded, exclusive and retain attachment-only/service records with provenance', async () => {
  const f = sdkFixture();
  const document = { id: 700n, accessHash: 900n, fileReference: Buffer.from('secret'), mimeType: 'application/pdf', size: 1234n, attributes: [{ className: 'DocumentAttributeFilename', fileName: 'resume.pdf' }] };
  f.queue.push({ users: [{ className: 'User', id: 9n, accessHash: 42n, firstName: 'Synthetic', username: 'synthetic_user' }], chats: [], messages: [
    { id: 8, className: 'Message', date: 1700000000, fromId: { userId: 9n }, peerId: { chatId: 5n }, media: { className: 'MessageMediaDocument', document }, replyTo: { replyToMsgId: 7 }, fwdFrom: { fromId: { userId: 10n }, fromName: 'Original author' } },
    { id: 7, className: 'MessageService', date: 1700000000, peerId: { chatId: 5n } },
  ] });
  const result = await f.adapter.history({ ...f.common, peer: { kind: 'chat', id: '5' }, cursor: { beforeMessageId: '9', upperMessageId: '20' } });
  assert.equal(result.records.length, 2); assert.equal(result.records[0].text, '');
  assert.equal(result.records[0].attachments[0].filename, 'resume.pdf'); assert.equal(result.records[1].kind, 'service');
  assert.equal(result.records[0].replyToMessageId, '7'); assert.equal(result.records[0].forwardedFrom.peer.id, '10');
  assert.deepEqual(result.nextCursor, { beforeMessageId: '7', upperMessageId: '20' });
  assert.equal(result.done, false); assert.ok(!JSON.stringify(result).includes('accessHash')); assert.ok(!JSON.stringify(result).includes('fileReference'));
  assert.ok(f.calls[0].request instanceof f.Api.messages.GetHistory); assert.equal(f.calls[0].request.offsetId, 9);
  assert.deepEqual(f.calls[0].options, { abortSignal: undefined, timeout: 10000, maxRetryCount: 0, floodSleepThreshold: 0 });
});

test('SDK dialogs preserve archive folder, input peer hashes locally, and include migrated groups', async () => {
  const f = sdkFixture();
  f.queue.push({ users: [], chats: [{ className: 'Channel', id: 10n, accessHash: 777n, title: 'Private group' }, { className: 'Chat', id: 5n, title: 'Original group', migratedTo: { channelId: 10n } }], dialogs: [{ className: 'Dialog', peer: { channelId: 10n }, topMessage: 11 }, { className: 'Dialog', peer: { chatId: 5n }, topMessage: 9 }], messages: [{ id: 11, peerId: { channelId: 10n }, date: 1700000001 }, { id: 9, peerId: { chatId: 5n }, date: 1700000000 }] });
  const cursor = { folder: 1, offsetDate: 0, offsetId: '0', offsetPeer: null, excludePinned: false };
  const result = await f.adapter.dialogs({ ...f.common, cursor });
  assert.equal(result.records.length, 2); assert.equal(f.calls[0].request.folderId, 1);
  assert.equal(result.nextCursor.excludePinned, true); assert.equal(result.nextCursor.offsetId, '9');
  assert.equal(f.peers.get('channel:10').accessHash, '777'); assert.ok(!JSON.stringify(result).includes('777'));
  f.queue.push({ users: [], chats: [], dialogs: [], messages: [] });
  const empty = await f.adapter.dialogs({ ...f.common, cursor: result.nextCursor });
  assert.equal(empty.done, true); assert.deepEqual(empty.nextCursor, result.nextCursor);
});

test('missing private peer cache, inaccessible messages and oversized text pause instead of advancing', async () => {
  const f = sdkFixture();
  await assert.rejects(f.adapter.history({ ...f.common, peer: { kind: 'channel', id: '5' }, cursor: {} }), /PEER_CACHE_MISSING/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(messageRecord({ id: 7, className: 'MessageEmpty' }, new Map(), '123'), { messageId: '7', kind: 'unavailable', sentAt: null, editedAt: null, sender: null, text: '', attachments: [], replyToMessageId: null, forwardedFrom: null });
  assert.throws(() => messageRecord({ id: 7, date: 1700000000, message: 'x'.repeat(32769) }, new Map(), '123'), /MESSAGE_TOO_LARGE/);
});

test('history HTTP keeps larger bounded request separate from connection API limits', async () => {
  const calls = [];
  const host = createHostClient({ server: 'https://synthetic.test', token: 'x'.repeat(64), service: 'history', fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response('{"ok":true}'); } });
  await host('complete', { records: 'x'.repeat(200000) });
  assert.match(calls[0].url, /telegram-history\/worker\/complete$/);
  await assert.rejects(host('complete', { records: 'x'.repeat(262144) }), /REQUEST_TOO_LARGE/);
  await assert.rejects(host('heartbeat'), /INVALID_ACTION/);
});

test('mixed accessible and inaccessible dialogs remain visible without blocking discovery', async () => {
  const f = sdkFixture();
  f.queue.push({ users: [{ className: 'User', id: 20n, min: true, firstName: 'Limited user' }], chats: [{ className: 'Chat', id: 5n, title: 'Accessible group' }], dialogs: [
    { className: 'Dialog', peer: { userId: 20n }, topMessage: 100 },
    { className: 'Dialog', peer: { chatId: 5n }, topMessage: 90 },
    { className: 'Dialog', peer: { userId: 30n }, topMessage: 80 },
  ], messages: [{ id: 90, peerId: { chatId: 5n }, date: 1700000000 }] });
  const result = await f.adapter.dialogs({ ...f.common, cursor: { folder: 0, offsetDate: 0, offsetId: '0', offsetPeer: null, excludePinned: false } });
  assert.equal(result.records.length, 3); assert.equal(result.records[2].title, 'Unavailable chat');
  assert.equal(result.nextCursor.offsetId, '90'); assert.deepEqual(result.nextCursor.offsetPeer, { kind: 'chat', id: '5' });
  assert.equal(f.peers.has('user:20'), false); assert.equal(f.peers.has('user:30'), false);
});

test('unavailable message tombstones preserve IDs and cursor progress without fabricated dates', async () => {
  const f = sdkFixture();
  f.queue.push({ users: [], chats: [], messages: [{ className: 'MessageEmpty', id: 5 }] });
  const result = await f.adapter.history({ ...f.common, peer: { kind: 'chat', id: '5' }, cursor: { beforeMessageId: '6', upperMessageId: '20' } });
  assert.equal(result.records[0].kind, 'unavailable'); assert.equal(result.records[0].sentAt, null);
  assert.equal(result.nextCursor.beforeMessageId, '5'); assert.equal(result.done, false);
});

test('connector runs history only after connected account verification with its current lease', async (t) => {
  const { createConnector } = await import('../../services/telegram-connector/connector.mjs');
  const f = fixture(t); let time = Date.now(); let status = 'requested'; let nextStatus = 'qr_pending'; let reads = 0;
  const profile = { telegramUserId: f.context.accountUserId, username: null, displayName: 'Synthetic' };
  const connector = createConnector({
    vault: f.vault, now: () => time,
    host: async (action, body) => {
      if (action === 'claim') return { connection: { id: connectionId, generation: 1, challengeId: jobId, status, leaseToken: lease, leaseExpiresAt: new Date(time + 120000).toISOString() } };
      if (action === 'update') status = body.status;
      return { ok: true };
    },
    createTelegram: async () => ({ session: () => 'synthetic-session', close: async () => {}, profile: async () => profile, history: { marker: true }, poll: async () => nextStatus === 'connected' ? { status: 'connected', profile } : { status: 'qr_pending', qrLoginUrl: 'tg://login?token=synthetic', qrExpiresAt: new Date(time + 60000).toISOString() } }),
    onConnectedTick: async (context) => { reads++; assert.equal(context.connectionLeaseToken, lease); assert.equal(context.accountUserId, profile.telegramUserId); assert.equal(context.telegram.marker, true); assert.equal(context.isActive(), true); assert.equal(context.signal.aborted, false); },
  });
  await connector.tick(); assert.equal(reads, 0);
  nextStatus = 'connected'; await connector.tick(); assert.equal(reads, 0);
  await connector.tick(); assert.equal(reads, 1);
  time += 21000; await connector.tick(); assert.equal(reads, 2);
  await connector.stop(); await connector.tick(); assert.equal(reads, 2);
});

test('provider metadata strips all controls while conversation text keeps its formatting', async () => {
  const f = sdkFixture();
  f.queue.push({ users: [], chats: [{ className: 'Chat', id: 5n, title: 'Recruiting\n\tteam\r\u007f' }], dialogs: [{ className: 'Dialog', peer: { chatId: 5n }, topMessage: 9 }], messages: [{ id: 9, peerId: { chatId: 5n }, date: 1700000000 }] });
  const page = await f.adapter.dialogs({ ...f.common, cursor: { folder: 0, offsetDate: 0, offsetId: '0', offsetPeer: null, excludePinned: false } });
  assert.equal(page.records[0].title, 'Recruitingteam');
  const record = messageRecord({ id: 10, date: 1700000000, message: 'Hello\n\tworld\r\n', fromId: { userId: 9n }, fwdFrom: { fromName: 'Original\nauthor' }, media: { className: 'MessageMediaDocument', document: { id: 1n, mimeType: 'application/\npdf', attributes: [{ className: 'DocumentAttributeFilename', fileName: 'Candidate\nResume\t.pdf\r' }] } } }, new Map([['user:9', { firstName: 'Synthetic\n', lastName: 'Recruiter\t' }]]), '123');
  assert.equal(record.text, 'Hello\n\tworld\r\n');
  assert.equal(record.attachments[0].filename, 'CandidateResume.pdf');
  assert.equal(record.attachments[0].mimeType, 'application/pdf');
  assert.equal(record.sender.displayName, 'Synthetic Recruiter');
  assert.equal(record.forwardedFrom.displayName, 'Originalauthor');
});

for (const [httpStatus, code] of [[400, 'PEER_UNAVAILABLE'], [422, 'MESSAGE_TOO_LARGE']]) {
  test(`definitive completion ${httpStatus} defers explicitly without advancing the server cursor`, async (t) => {
    const f = fixture(t); const initialCursor = structuredClone(f.job.cursor);
    const worker = createHistoryWorker({ ...f.options, host: async (action, body) => {
      if (action === 'complete') { const error = new Error('validation'); error.status = httpStatus; throw error; }
      return f.options.host(action, body);
    } });
    assert.equal((await worker.tick(f.context)).status, 'deferred');
    assert.equal(f.calls.at(-1).action, 'defer'); assert.equal(f.calls.at(-1).body.code, code);
    assert.deepEqual(f.job.cursor, initialCursor);
    assert.equal(f.vault.loadHistory(connectionId, f.context.accountUserId, 'pending-page'), null);
  });
}

test('lost validation-defer acknowledgement retains encrypted page and retries only defer after restart', async (t) => {
  const f = fixture(t); let completeCalls = 0; let deferCalls = 0;
  const options = { ...f.options, host: async (action, body) => {
    if (action === 'complete') { completeCalls++; const error = new Error('validation'); error.status = 400; throw error; }
    if (action === 'defer') { deferCalls++; const error = new Error('uncertain'); error.status = deferCalls === 1 ? 503 : 409; throw error; }
    return f.options.host(action, body);
  } };
  await assert.rejects(createHistoryWorker(options).tick(f.context), /uncertain/);
  const pending = f.vault.loadHistory(connectionId, f.context.accountUserId, 'pending-page');
  assert.equal(pending.rejectionCode, 'PEER_UNAVAILABLE');
  assert.equal((await createHistoryWorker(options).tick(f.context)).status, 'stale');
  assert.equal(completeCalls, 1); assert.equal(deferCalls, 2); assert.equal(f.providerCalls(), 1);
  assert.equal(f.vault.loadHistory(connectionId, f.context.accountUserId, 'pending-page'), null);
});

test('completion 5xx remains uncertain and never drops or defers its pending page', async (t) => {
  const f = fixture(t);
  const worker = createHistoryWorker({ ...f.options, host: async (action, body) => {
    if (action === 'complete') { const error = new Error('uncertain'); error.status = 503; throw error; }
    return f.options.host(action, body);
  } });
  await assert.rejects(worker.tick(f.context), /uncertain/);
  assert.equal(f.vault.loadHistory(connectionId, f.context.accountUserId, 'pending-page').rejectionCode, undefined);
  assert.equal(f.calls.filter((call) => call.action === 'defer').length, 0);
});
