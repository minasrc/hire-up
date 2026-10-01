import { peerLocator, peerKey } from './history-adapter.mjs';

export const CV_CHUNK_BYTES = 512 * 1024;
export const CV_MAX_BYTES = 4 * 1024 * 1024;
export class CvReadError extends Error {
  constructor(code, retryAfterSeconds, dcId) { super(code); this.code = code; this.retryAfterSeconds = retryAfterSeconds; this.dcId = dcId; }
}
const positive = /^[1-9][0-9]{0,29}$/;
const safeMetadata = value => value == null ? null : String(value).replace(/[\u0000-\u001f\u007f]/g, '');

// Never use downloadMedia/iterDownload here: their internal retry, concurrency
// and cancellation behavior is unsuitable for one bounded leased read per tick.
export function createCvAdapter({ client, Api }) {
  async function invoke(request, signal, dcId) {
    try {
      signal?.throwIfAborted();
      const value = await client.invoke(request, dcId, { abortSignal: signal, timeout: 10000, maxRetryCount: 0, floodSleepThreshold: 0 });
      signal?.throwIfAborted();
      return value;
    } catch (error) {
      if (signal?.aborted) throw new CvReadError('CONNECTION_CHANGED');
      if (Number.isInteger(error.seconds) && error.seconds > 0) throw new CvReadError('FLOOD_WAIT', Math.min(error.seconds, 604800));
      if (/^FILE_REFERENCE_(EXPIRED|EMPTY|INVALID|[0-9]+_EXPIRED)$/.test(error.errorMessage ?? '')) throw new CvReadError('FILE_REFERENCE_EXPIRED');
      if (/^FILE_MIGRATE_[0-9]+$/.test(error.errorMessage ?? '') && Number.isInteger(error.newDc) && error.newDc > 0 && error.newDc <= 100) throw new CvReadError('FILE_MIGRATE', undefined, error.newDc);
      if (['CHANNEL_PRIVATE', 'CHANNEL_INVALID', 'CHAT_ID_INVALID', 'PEER_ID_INVALID', 'USER_ID_INVALID', 'CHAT_ADMIN_REQUIRED', 'MESSAGE_ID_INVALID', 'MEDIA_EMPTY', 'FILE_ID_INVALID', 'LOCATION_INVALID'].includes(error.errorMessage)) throw new CvReadError('SOURCE_UNAVAILABLE');
      throw new CvReadError('TELEGRAM_UNAVAILABLE');
    }
  }
  return {
    async inspect({ peer, messageId, attachment, readPeer, signal }) {
      if (!peer || !positive.test(peer.id) || !['user', 'chat', 'channel'].includes(peer.kind) || !/^[1-9][0-9]{0,9}$/.test(messageId) || Number(messageId) > 2147483647) throw new CvReadError('SOURCE_UNAVAILABLE');
      const id = [new Api.InputMessageID({ id: Number(messageId) })];
      let request;
      if (peer.kind === 'channel') {
        const cached = readPeer(peer);
        if (cached?.kind !== peer.kind || cached.id !== peer.id || !/^-?[0-9]{1,20}$/.test(cached.accessHash ?? '')) throw new CvReadError('PEER_CACHE_MISSING');
        request = new Api.channels.GetMessages({ channel: new Api.InputChannel({ channelId: BigInt(peer.id), accessHash: BigInt(cached.accessHash) }), id });
      } else request = new Api.messages.GetMessages({ id });
      const response = await invoke(request, signal);
      if (!Array.isArray(response.messages)) throw new CvReadError('TELEGRAM_UNAVAILABLE');
      const message = response.messages.find(item => String(item.id) === messageId);
      if (!message || message.className === 'MessageEmpty') throw new CvReadError('SOURCE_UNAVAILABLE');
      if (peerKey(peerLocator(message.peerId) ?? {}) !== peerKey(peer)) throw new CvReadError('SOURCE_CHANGED');
      const document = message.media?.document;
      if (!document || document.className !== 'Document' || !positive.test(String(document.id))) throw new CvReadError('SOURCE_CHANGED');
      const sizeBytes = Number(String(document.size));
      const filename = safeMetadata(document.attributes?.find(value => value.className === 'DocumentAttributeFilename')?.fileName);
      const mimeType = safeMetadata(document.mimeType);
      if (!attachment || attachment.kind !== 'document' || String(document.id) !== attachment.id || (attachment.sizeBytes != null && sizeBytes !== attachment.sizeBytes) || (attachment.filename != null && filename !== attachment.filename)) throw new CvReadError('SOURCE_CHANGED');
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > CV_MAX_BYTES) throw new CvReadError('FILE_TOO_LARGE');
      if (!filename || filename.length > 200 || !/\.(pdf|docx)$/i.test(filename) || (mimeType != null && mimeType.length > 100)) throw new CvReadError('INVALID_FILE');
      if (!/^-?[0-9]{1,20}$/.test(String(document.accessHash)) || !Number.isInteger(document.dcId) || document.dcId < 1 || document.dcId > 100 || !Buffer.isBuffer(document.fileReference) || document.fileReference.length < 1 || document.fileReference.length > 4096) throw new CvReadError('SOURCE_UNAVAILABLE');
      // This object is a private locator and must only enter the encrypted vault.
      return { id: String(document.id), accessHash: String(document.accessHash), fileReference: document.fileReference.toString('base64'), dcId: document.dcId, sizeBytes };
    },
    async chunk({ location, offset, signal }) {
      if (!location || !positive.test(location.id) || !/^-?[0-9]{1,20}$/.test(location.accessHash ?? '') || typeof location.fileReference !== 'string' || location.fileReference.length > 5464 || !/^[A-Za-z0-9+/]+={0,2}$/.test(location.fileReference) || !Number.isInteger(location.dcId) || location.dcId < 1 || location.dcId > 100 || !Number.isInteger(location.sizeBytes) || location.sizeBytes < 1 || location.sizeBytes > CV_MAX_BYTES || !Number.isInteger(offset) || offset < 0 || offset >= location.sizeBytes || offset % CV_CHUNK_BYTES !== 0) throw new CvReadError('SOURCE_UNAVAILABLE');
      const request = new Api.upload.GetFile({ location: new Api.InputDocumentFileLocation({ id: BigInt(location.id), accessHash: BigInt(location.accessHash), fileReference: Buffer.from(location.fileReference, 'base64'), thumbSize: '' }), offset: BigInt(offset), limit: CV_CHUNK_BYTES, precise: false, cdnSupported: false });
      const result = await invoke(request, signal, location.dcId);
      if (result.className === 'upload.FileCdnRedirect') throw new CvReadError('SOURCE_UNAVAILABLE');
      const bytes = result.bytes;
      if (!Buffer.isBuffer(bytes) || bytes.length !== Math.min(CV_CHUNK_BYTES, location.sizeBytes - offset)) throw new CvReadError('INVALID_FILE');
      return bytes;
    },
  };
}
