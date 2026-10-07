import { ClientJobContractError } from './client-job-contracts.js';
import { assertUuid } from './candidate-profile-contracts.js';
const fail = key => { throw new ClientJobContractError({ [key]: 'Invalid Telegram history request.' }); };
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => { if (!object(v) || Object.keys(v).some(k => !keys.includes(k))) fail('input'); };
const number = (v, min, max, key) => { if (!Number.isSafeInteger(v) || v < min || v > max) fail(key); return v; };
const id = (v, key = 'id') => { if (typeof v !== 'string' || !/^[1-9][0-9]{0,29}$/.test(v)) fail(key); return v; };
const messageId = (v, zero = false) => { if (zero && v === '0') return v; id(v, 'messageId'); if (BigInt(v) > 2147483647n) fail('messageId'); return v; };
const text = (v, max, key, nullable = false) => { if (nullable && v == null) return null; if (typeof v !== 'string' || !v.isWellFormed() || v.length > max || (key !== 'text' && /[\x00-\x1f\x7f]/.test(v))) fail(key); return v; };
const date = (v, nullable = false) => { if (nullable && v == null) return null; if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(v) || !Number.isFinite(Date.parse(v))) fail('date'); return new Date(v).toISOString(); };
export const HISTORY_BODY_LIMIT = 262144;
export function historyPeer(v) { exact(v, ['kind', 'id']); if (!['user', 'chat', 'channel'].includes(v.kind)) fail('peer'); return { kind: v.kind, id: id(v.id) }; }
export function historyCursor(v, kind) {
    if (kind === 'dialogs') {
        exact(v, ['folder', 'offsetDate', 'offsetId', 'offsetPeer', 'excludePinned']);
        if (typeof v.excludePinned !== 'boolean') fail('cursor');
        return { folder: number(v.folder, 0, 1, 'folder'), offsetDate: number(v.offsetDate, 0, 4102444800, 'offsetDate'), offsetId: messageId(v.offsetId, true), offsetPeer: v.offsetPeer === null ? null : historyPeer(v.offsetPeer), excludePinned: v.excludePinned };
    }
    exact(v, ['beforeMessageId', 'upperMessageId']);
    return { beforeMessageId: v.beforeMessageId === null ? null : messageId(v.beforeMessageId), upperMessageId: v.upperMessageId === null ? null : messageId(v.upperMessageId) };
}
const username = v => { if (v == null) return null; if (typeof v !== 'string' || !/^[A-Za-z0-9_]{1,32}$/.test(v)) fail('username'); return v; };
function dialog(v) {
    exact(v, ['peer', 'title', 'username', 'lastMessageAt']);
    const title = text(v.title, 200, 'title'); if (!title.trim()) fail('title');
    return { peer: historyPeer(v.peer), title, username: username(v.username), lastMessageAt: date(v.lastMessageAt, true) };
}
function message(v) {
    exact(v, ['messageId', 'kind', 'sentAt', 'editedAt', 'sender', 'replyToMessageId', 'forwardedFrom', 'text', 'attachments']);
    if (!['message', 'service', 'unavailable'].includes(v.kind) || !Array.isArray(v.attachments) || v.attachments.length > 16) fail('message');
    if (v.kind === 'unavailable' && (v.sentAt !== null || v.editedAt !== null || v.sender !== null || v.replyToMessageId !== null || v.forwardedFrom !== null || v.text !== '' || v.attachments.length !== 0)) fail('message');
    const body = text(v.text, 32768, 'text'); if (Buffer.byteLength(body) > 32768) fail('text');
    let sender = null; let forwardedFrom = null;
    if (v.sender != null) { exact(v.sender, ['peer', 'username', 'displayName']); sender = { peer: historyPeer(v.sender.peer), username: username(v.sender.username), displayName: text(v.sender.displayName, 200, 'displayName', true) }; }
    if (v.forwardedFrom != null) { exact(v.forwardedFrom, ['peer', 'displayName']); forwardedFrom = { peer: v.forwardedFrom.peer === null ? null : historyPeer(v.forwardedFrom.peer), displayName: text(v.forwardedFrom.displayName, 200, 'displayName', true) }; }
    const attachments = v.attachments.map(a => {
        exact(a, ['id', 'kind', 'filename', 'mimeType', 'sizeBytes']);
        if (!['document', 'photo', 'other'].includes(a.kind)) fail('attachment');
        return { id: a.id == null ? null : id(a.id), kind: a.kind, filename: text(a.filename, 200, 'filename', true), mimeType: text(a.mimeType, 100, 'mimeType', true), sizeBytes: a.sizeBytes == null ? null : number(a.sizeBytes, 0, Number.MAX_SAFE_INTEGER, 'sizeBytes') };
    });
    return { messageId: messageId(v.messageId), kind: v.kind, sentAt: date(v.sentAt, v.kind === 'unavailable'), editedAt: date(v.editedAt, true), sender,
        replyToMessageId: v.replyToMessageId == null ? null : messageId(v.replyToMessageId), forwardedFrom, text: body, attachments };
}
const proofKeys = ['connectionId', 'generation', 'connectionLeaseToken', 'accountUserId'];
export function historyProof(input) { if (!object(input)) fail('input'); return { connectionId: assertUuid(input.connectionId, 'connectionId'), generation: number(input.generation, 1, Number.MAX_SAFE_INTEGER, 'generation'), connectionLeaseToken: assertUuid(input.connectionLeaseToken, 'connectionLeaseToken'), accountUserId: id(input.accountUserId, 'accountUserId') }; }
export function historyWorkerInput(action, input) {
    const proof = historyProof(input);
    if (action === 'claim') { exact(input, proofKeys); return { proof }; }
    if (action === 'defer') {
        exact(input, [...proofKeys, 'jobId', 'jobLeaseToken', 'code', 'retryAfterSeconds']);
        if (!['FLOOD_WAIT', 'TELEGRAM_UNAVAILABLE', 'PEER_UNAVAILABLE', 'PEER_CACHE_MISSING', 'MESSAGE_TOO_LARGE'].includes(input.code)) fail('code');
        return { proof, jobId: assertUuid(input.jobId, 'jobId'), jobLeaseToken: assertUuid(input.jobLeaseToken, 'jobLeaseToken'), code: input.code,
            retryAfterSeconds: input.code === 'FLOOD_WAIT' ? number(input.retryAfterSeconds, 1, 604800, 'retryAfterSeconds') : null };
    }
    if (action !== 'complete') fail('action');
    exact(input, [...proofKeys, 'jobId', 'jobLeaseToken', 'pageId', 'fromCursor', 'nextCursor', 'done', 'records']);
    if (!Array.isArray(input.records) || input.records.length > 100 || typeof input.done !== 'boolean' || input.done !== (input.records.length === 0)) fail('records');
    const kind = Object.hasOwn(input.fromCursor ?? {}, 'folder') ? 'dialogs' : 'history';
    const payload = { pageId: assertUuid(input.pageId, 'pageId'), fromCursor: historyCursor(input.fromCursor, kind), nextCursor: historyCursor(input.nextCursor, kind), done: input.done, records: input.records.map(kind === 'dialogs' ? dialog : message) };
    if (Buffer.byteLength(JSON.stringify(input)) > HISTORY_BODY_LIMIT) fail('input');
    return { proof, jobId: assertUuid(input.jobId, 'jobId'), jobLeaseToken: assertUuid(input.jobLeaseToken, 'jobLeaseToken'), payload };
}
export function historyStaffAction(input) {
    if (input?.action === 'discover') { exact(input, ['action']); return input; }
    if (input?.action === 'selectMany') {
        exact(input, ['action', 'chats', 'selected']);
        if (!Array.isArray(input.chats) || !input.chats.length || input.chats.length > 50 || typeof input.selected !== 'boolean') fail('chats');
        const chats = input.chats.map(c => { exact(c, ['chatId', 'expectedVersion']); return { chatId: assertUuid(c.chatId, 'chatId'), expectedVersion: number(c.expectedVersion, 1, Number.MAX_SAFE_INTEGER, 'expectedVersion') }; });
        if (new Set(chats.map(c => c.chatId)).size !== chats.length) fail('chats');
        return { action: input.action, chats, selected: input.selected };
    }
    exact(input, input?.action === 'select' ? ['action', 'chatId', 'expectedVersion', 'selected'] : ['action', 'chatId', 'expectedVersion']);
    if (!['select', 'pause', 'resume', 'cancel'].includes(input.action) || (input.action === 'select' && typeof input.selected !== 'boolean')) fail('action');
    return { action: input.action, chatId: assertUuid(input.chatId, 'chatId'), expectedVersion: number(input.expectedVersion, 1, Number.MAX_SAFE_INTEGER, 'expectedVersion'), ...(input.action === 'select' ? { selected: input.selected } : {}) };
}
