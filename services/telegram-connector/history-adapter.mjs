// Read-only Telegram RPCs. No mark-as-read, download, join, or send methods.
export class HistoryReadError extends Error {
  constructor(code, retryAfterSeconds) { super(code); this.code = code; this.retryAfterSeconds = retryAfterSeconds; }
}
const positive = /^[1-9][0-9]{0,29}$/;
export function peerLocator(value) {
  if (!value) return null;
  const kind = value.userId != null || value.className === 'User' ? 'user' : value.chatId != null || ['Chat', 'ChatForbidden', 'ChatEmpty'].includes(value.className) ? 'chat' : value.channelId != null || ['Channel', 'ChannelForbidden'].includes(value.className) ? 'channel' : null;
  const id = String(value.userId ?? value.chatId ?? value.channelId ?? value.id ?? '');
  return kind && positive.test(id) ? { kind, id } : null;
}
export const peerKey = (peer) => `${peer.kind}:${peer.id}`;
function text(value, max, nullable = false) {
  if (value == null && nullable) return null;
  const result = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '');
  if (result.length > max) throw new HistoryReadError('MESSAGE_TOO_LARGE');
  return result;
}
function iso(value, nullable = false) {
  if (value == null && nullable) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new HistoryReadError('PEER_UNAVAILABLE');
  return new Date(value * 1000).toISOString();
}
function messageId(value, nullable = false) {
  if (value == null && nullable) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 2147483647) throw new HistoryReadError('PEER_UNAVAILABLE');
  return String(number);
}
const display = (entity) => entity ? text(entity.title ?? `${entity.firstName ?? ''} ${entity.lastName ?? ''}`.trim(), 200, true) : null;
function sender(peer, entities) {
  if (!peer) return null;
  const entity = entities.get(peerKey(peer));
  return { peer, username: text(entity?.username, 32, true), displayName: display(entity) };
}
export function messageRecord(message, entities, accountUserId) {
  if (message.className === 'MessageEmpty') return { messageId: messageId(message.id), kind: 'unavailable', sentAt: null, editedAt: null, sender: null, text: '', attachments: [], replyToMessageId: null, forwardedFrom: null };
  const media = message.media;
  const attachments = [];
  if (media && media.className !== 'MessageMediaEmpty') {
    const file = media.document ?? media.photo;
    const filename = file?.attributes?.find((attribute) => attribute.className === 'DocumentAttributeFilename')?.fileName;
    const size = file?.size == null ? null : Number(String(file.size));
    if (size != null && (!Number.isSafeInteger(size) || size < 0)) throw new HistoryReadError('MESSAGE_TOO_LARGE');
    const fileId = file?.id == null ? null : String(file.id);
    if (fileId != null && !positive.test(fileId)) throw new HistoryReadError('PEER_UNAVAILABLE');
    attachments.push({ id: fileId, kind: media.document ? 'document' : media.photo ? 'photo' : 'other', filename: text(filename, 200, true), mimeType: text(file?.mimeType, 100, true), sizeBytes: size });
  }
  const content = String(message.message ?? '');
  if (Buffer.byteLength(content) > 32768 || content.includes('\u0000')) throw new HistoryReadError('MESSAGE_TOO_LARGE');
  const destination = peerLocator(message.peerId);
  const from = peerLocator(message.fromId) ?? (message.out ? { kind: 'user', id: accountUserId } : destination?.kind === 'user' ? destination : null);
  const forwardPeer = peerLocator(message.fwdFrom?.fromId);
  return {
    messageId: messageId(message.id), kind: message.className === 'MessageService' ? 'service' : 'message',
    sentAt: iso(message.date), editedAt: iso(message.editDate, true), sender: sender(from, entities), text: content, attachments,
    replyToMessageId: messageId(message.replyTo?.replyToMsgId, true),
    forwardedFrom: message.fwdFrom ? { peer: forwardPeer, displayName: text(message.fwdFrom.fromName ?? display(forwardPeer ? entities.get(peerKey(forwardPeer)) : null), 200, true) } : null,
  };
}
export function createHistoryAdapter({ client, Api }) {
  function inputPeer(peer, readPeer) {
    if (!peer || !positive.test(peer.id) || !['user', 'chat', 'channel'].includes(peer.kind)) throw new HistoryReadError('PEER_UNAVAILABLE');
    if (peer.kind === 'chat') return new Api.InputPeerChat({ chatId: BigInt(peer.id) });
    const cached = readPeer(peer);
    if (!cached || cached.kind !== peer.kind || cached.id !== peer.id || !/^-?[0-9]{1,20}$/.test(cached.accessHash ?? '')) throw new HistoryReadError('PEER_CACHE_MISSING');
    if (cached.self) return new Api.InputPeerSelf();
    return peer.kind === 'user' ? new Api.InputPeerUser({ userId: BigInt(peer.id), accessHash: BigInt(cached.accessHash) }) : new Api.InputPeerChannel({ channelId: BigInt(peer.id), accessHash: BigInt(cached.accessHash) });
  }
  function entitiesOf(response, cachePeer, wantedPeers) {
    const result = new Map();
    for (const entity of [...(response.users ?? []), ...(response.chats ?? [])]) {
      const peer = peerLocator(entity);
      if (!peer) continue;
      result.set(peerKey(peer), entity);
      if (wantedPeers.has(peerKey(peer)) && !entity.min && (peer.kind === 'chat' || entity.accessHash != null || entity.self)) cachePeer(peer, { ...peer, accessHash: entity.accessHash == null ? '0' : String(entity.accessHash), self: entity.self === true });
    }
    return result;
  }
  async function invoke(request, signal) {
    try { return await client.invoke(request, undefined, { abortSignal: signal, timeout: 10000, maxRetryCount: 0, floodSleepThreshold: 0 }); }
    catch (error) {
      if (signal?.aborted) throw new HistoryReadError('CONNECTION_CHANGED');
      if (Number.isInteger(error.seconds) && error.seconds > 0) throw new HistoryReadError('FLOOD_WAIT', Math.min(604800, error.seconds));
      if (['CHANNEL_PRIVATE', 'CHANNEL_INVALID', 'CHAT_ID_INVALID', 'PEER_ID_INVALID', 'USER_ID_INVALID', 'CHAT_ADMIN_REQUIRED'].includes(error.errorMessage)) throw new HistoryReadError('PEER_UNAVAILABLE');
      throw new HistoryReadError('TELEGRAM_UNAVAILABLE');
    }
  }
  return {
    async dialogs({ cursor, limit, readPeer, cachePeer, signal }) {
      const response = await invoke(new Api.messages.GetDialogs({ folderId: cursor.folder, offsetDate: cursor.offsetDate, offsetId: Number(cursor.offsetId), offsetPeer: cursor.offsetPeer ? inputPeer(cursor.offsetPeer, readPeer) : new Api.InputPeerEmpty(), excludePinned: cursor.excludePinned, limit, hash: 0n }), signal);
      if (!Array.isArray(response.dialogs) || !Array.isArray(response.messages)) throw new HistoryReadError('TELEGRAM_UNAVAILABLE');
      const entities = entitiesOf(response, cachePeer, new Set(response.dialogs.map((dialog) => peerLocator(dialog.peer)).filter(Boolean).map(peerKey)));
      if (!response.dialogs.length) return { records: [], nextCursor: cursor, done: true };
      const records = []; const seen = new Set();
      let boundary = null;
      for (const dialog of response.dialogs) {
        if (dialog.className === 'DialogFolder') continue;
        const peer = peerLocator(dialog.peer);
        if (!peer) throw new HistoryReadError('PEER_UNAVAILABLE');
        const entity = entities.get(peerKey(peer));
        const lastMessage = response.messages.find((message) => message.id === dialog.topMessage && peerKey(peerLocator(message.peerId) ?? {}) === peerKey(peer));
        try {
          inputPeer(peer, readPeer);
          boundary = { folder: cursor.folder, offsetDate: lastMessage?.date ?? 0, offsetId: String(dialog.topMessage ?? 0), offsetPeer: peer, excludePinned: true };
        } catch (error) { if (!['PEER_UNAVAILABLE', 'PEER_CACHE_MISSING'].includes(error.code)) throw error; }
        // Public inaccessible peers still appear for review. A following page
        // may repeat rows after the last resolvable boundary; server dedup is safe.
        if (seen.has(peerKey(peer))) continue;
        seen.add(peerKey(peer));
        records.push({ peer, title: display(entity) || 'Unavailable chat', username: text(entity?.username, 32, true), lastMessageAt: iso(lastMessage?.date, true) });
      }
      if (!boundary || JSON.stringify(boundary) === JSON.stringify(cursor)) throw new HistoryReadError('PEER_UNAVAILABLE');
      return { records, nextCursor: boundary, done: false };
    },
    async history({ peer, cursor, limit, readPeer, cachePeer, accountUserId, signal }) {
      const response = await invoke(new Api.messages.GetHistory({ peer: inputPeer(peer, readPeer), offsetId: cursor.beforeMessageId == null ? 0 : Number(cursor.beforeMessageId), offsetDate: 0, addOffset: 0, limit, maxId: 0, minId: 0, hash: 0n }), signal);
      if (!Array.isArray(response.messages)) throw new HistoryReadError('TELEGRAM_UNAVAILABLE');
      const entities = entitiesOf(response, cachePeer, new Set([peerKey(peer)]));
      if (!response.messages.length) return { records: [], nextCursor: cursor, done: true };
      const records = response.messages.map((message) => messageRecord(message, entities, accountUserId));
      const ids = records.map((record) => Number(record.messageId));
      if (new Set(ids).size !== ids.length || ids.some((id) => cursor.beforeMessageId != null && id >= Number(cursor.beforeMessageId))) throw new HistoryReadError('PEER_UNAVAILABLE');
      return { records, nextCursor: { beforeMessageId: String(Math.min(...ids)), upperMessageId: cursor.upperMessageId ?? String(Math.max(...ids)) }, done: false };
    },
  };
}
