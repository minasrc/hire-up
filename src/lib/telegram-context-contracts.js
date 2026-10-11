import { ClientJobContractError } from './client-job-contracts.js';
import { assertUuid } from './candidate-profile-contracts.js';
const fail = (key, message = 'Invalid conversation request.') => { throw new ClientJobContractError({ [key]: message }); };
const exact = (v, keys) => { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) fail('input'); };
const text = (v, max, key) => { if (typeof v !== 'string' || !v.isWellFormed() || v.length > max || /[\x00-\x1f\x7f]/.test(v)) fail(key); return v.trim(); };
const day = (v, key) => { if (v == null) return null; if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || v < '0001-01-01' || !Number.isFinite(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) fail(key, 'Use a real date in YYYY-MM-DD format.'); return v; };
export function contextCursor(v, action) {
    if (v == null) return null;
    if (typeof v !== 'string' || v.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(v)) fail('after');
    try {
        const decoded = Buffer.from(v, 'base64url');
        if (decoded.toString('base64url') !== v) fail('after');
        const cursor = JSON.parse(decoded.toString('utf8'));
        const keys = action === 'chats' ? ['digest', 'title', 'id'] : ['digest', 'sentAt', 'chatId', 'messageId'];
        exact(cursor, keys);
        if (Object.keys(cursor).length !== keys.length || typeof cursor.digest !== 'string' || !/^[a-f0-9]{64}$/.test(cursor.digest)) fail('after');
        if (action === 'chats') {
            text(cursor.title, 200, 'after');
            if (!cursor.title.length) fail('after');
            assertUuid(cursor.id, 'after');
        } else {
            assertUuid(cursor.chatId, 'after');
            contextMessageId(cursor.messageId, 'after');
            if (typeof cursor.sentAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(cursor.sentAt) || !Number.isFinite(Date.parse(cursor.sentAt))) fail('after');
            day(cursor.sentAt.slice(0, 10), 'after');
        }
        return cursor;
    } catch { fail('after'); }
}
export function contextMessageId(v, key) { if (typeof v !== 'string' || !/^[1-9][0-9]{0,9}$/.test(v) || BigInt(v) > 2147483647n) fail(key); return v; }
export function contextPost(input) {
    if (input?.action === 'chats') { exact(input, ['action', 'query', 'after']); return { action: 'chats', query: text(input.query ?? '', 100, 'query'), after: contextCursor(input.after, 'chats') }; }
    exact(input, ['action', 'query', 'chatId', 'sender', 'from', 'to', 'attachmentsOnly', 'after']);
    if (input.action !== 'search') fail('action');
    const query = text(input.query, 500, 'query');
    if (!query) fail('query', 'Enter at least one positive search term.');
    let sender = input.sender == null || input.sender === '' ? null : text(input.sender, 33, 'sender').replace(/^@/, '').toLowerCase();
    if (sender !== null && !/^[a-z0-9_]{1,32}$/.test(sender)) fail('sender', 'Use an exact Telegram username.');
    const from = day(input.from, 'from'), to = day(input.to, 'to');
    if (from && to && from > to) fail('to', 'End date must be on or after the start date.');
    if (input.attachmentsOnly != null && typeof input.attachmentsOnly !== 'boolean') fail('attachmentsOnly');
    return { action: 'search', query, chatId: input.chatId == null ? null : assertUuid(input.chatId, 'chatId'), sender, from, to, attachmentsOnly: input.attachmentsOnly ?? false, after: contextCursor(input.after, 'search') };
}
export function contextGet(input) {
    exact(input, ['chatId', 'anchor', 'before', 'after']);
    const directions = ['anchor', 'before', 'after'].filter(k => input[k] != null);
    if (directions.length > 1) fail('input');
    return { chatId: assertUuid(input.chatId, 'chatId'), ...Object.fromEntries(directions.map(k => [k, contextMessageId(input[k], k)])) };
}
