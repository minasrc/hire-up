import test from 'node:test';
import assert from 'node:assert/strict';
import { createCvAdapter, CV_CHUNK_BYTES } from '../../services/telegram-connector/cv-adapter.mjs';

const type = name => class { constructor(fields) { Object.assign(this, fields); this.className = name; } };
const Api = { InputMessageID: type('InputMessageID'), InputChannel: type('InputChannel'), InputDocumentFileLocation: type('InputDocumentFileLocation'), messages: { GetMessages: type('messages.GetMessages') }, channels: { GetMessages: type('channels.GetMessages') }, upload: { GetFile: type('upload.GetFile') } };
const peer = { kind: 'user', id: '42' };
const attachment = { id: '100', kind: 'document', filename: 'Candidate.pdf', mimeType: 'application/pdf', sizeBytes: CV_CHUNK_BYTES + 3 };
const message = () => ({ id: 77, className: 'Message', peerId: { userId: 42n }, media: { document: { id: 100n, className: 'Document', accessHash: -123n, fileReference: Buffer.from('private-reference'), dcId: 2, size: BigInt(attachment.sizeBytes), mimeType: attachment.mimeType, attributes: [{ className: 'DocumentAttributeFilename', fileName: attachment.filename }] } } });
const inspectArgs = () => ({ peer, messageId: '77', attachment, readPeer: () => null });

test('CV adapter refetches exact private source, retains secrets locally and bounds chunk RPCs', async () => {
  const calls = [];
  const adapter = createCvAdapter({ Api, client: { invoke: async (request, dc, options) => { calls.push({ request, dc, options }); return request.className === 'messages.GetMessages' ? { messages: [message()] } : { bytes: Buffer.alloc(Number(request.offset) ? 3 : CV_CHUNK_BYTES) }; } } });
  const signal = new AbortController().signal;
  const location = await adapter.inspect({ ...inspectArgs(), signal });
  assert.equal(location.accessHash, '-123'); assert.equal(location.fileReference, Buffer.from('private-reference').toString('base64'));
  assert.equal((await adapter.chunk({ location, offset: 0, signal })).length, CV_CHUNK_BYTES);
  assert.equal((await adapter.chunk({ location, offset: CV_CHUNK_BYTES, signal })).length, 3);
  assert.equal(calls[1].dc, 2); assert.equal(calls[1].request.cdnSupported, false); assert.equal(calls[1].request.location.thumbSize, '');
  for (const { options } of calls) assert.deepEqual(options, { abortSignal: signal, timeout: 10000, maxRetryCount: 0, floodSleepThreshold: 0 });
});

test('channels use account-private access hash and returned source peer must match', async () => {
  const channel = { kind: 'channel', id: '99' }; let request;
  const adapter = createCvAdapter({ Api, client: { invoke: async value => { request = value; return { messages: [{ ...message(), peerId: { channelId: 99n } }] }; } } });
  await assert.rejects(adapter.inspect({ ...inspectArgs(), peer: channel }), error => error.code === 'PEER_CACHE_MISSING');
  await adapter.inspect({ ...inspectArgs(), peer: channel, readPeer: () => ({ ...channel, accessHash: '123' }) });
  assert.equal(request.className, 'channels.GetMessages'); assert.equal(request.channel.channelId, 99n);
  await assert.rejects(adapter.inspect(inspectArgs()), error => error.code === 'SOURCE_CHANGED');
});

test('deleted/replaced documents and modified metadata never silently download another attachment', async () => {
  for (const update of [m => ({ ...m, className: 'MessageEmpty' }), m => ({ ...m, media: null }), m => { m.media.document.id = 101n; return m; }, m => { m.media.document.size = 7n; return m; }, m => { m.media.document.attributes[0].fileName = 'Other.pdf'; return m; }]) {
    const adapter = createCvAdapter({ Api, client: { invoke: async () => ({ messages: [update(message())] }) } });
    await assert.rejects(adapter.inspect(inspectArgs()), error => ['SOURCE_UNAVAILABLE', 'SOURCE_CHANGED'].includes(error.code));
  }
});

test('adapter surfaces flood wait, expired references and file-DC migration without sleeping or retrying', async () => {
  for (const [rpcError, code] of [[{ seconds: 100, errorMessage: 'FLOOD_WAIT_100' }, 'FLOOD_WAIT'], [{ errorMessage: 'FILE_REFERENCE_EXPIRED' }, 'FILE_REFERENCE_EXPIRED'], [{ errorMessage: 'FILE_MIGRATE_4', newDc: 4 }, 'FILE_MIGRATE'], [new Error('secret raw response'), 'TELEGRAM_UNAVAILABLE']]) {
    let calls = 0;
    const adapter = createCvAdapter({ Api, client: { invoke: async () => { calls++; throw rpcError; } } });
    await assert.rejects(adapter.inspect(inspectArgs()), error => error.code === code && error.message === code && (code !== 'FLOOD_WAIT' || error.retryAfterSeconds === 100) && (code !== 'FILE_MIGRATE' || error.dcId === 4));
    assert.equal(calls, 1);
  }
});

test('short/oversized chunks and cancelled responses cannot become successful partial CVs', async () => {
  const adapter = createCvAdapter({ Api, client: { invoke: async () => ({ messages: [message()] }) } });
  const location = await adapter.inspect(inspectArgs());
  for (const size of [0, CV_CHUNK_BYTES - 1, CV_CHUNK_BYTES + 1]) {
    const partial = createCvAdapter({ Api, client: { invoke: async () => ({ bytes: Buffer.alloc(size) }) } });
    await assert.rejects(partial.chunk({ location, offset: 0 }), error => error.code === 'INVALID_FILE');
  }
  const control = new AbortController();
  const late = createCvAdapter({ Api, client: { invoke: async () => { control.abort('private reason'); return { messages: [message()] }; } } });
  await assert.rejects(late.inspect({ ...inspectArgs(), signal: control.signal }), error => error.code === 'CONNECTION_CHANGED' && error.message === 'CONNECTION_CHANGED');
});
