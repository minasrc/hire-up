import { createHmac, timingSafeEqual } from 'node:crypto';

export const STAFF_WORKSPACE_COOKIE = 'staff_workspace';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_AGE = 30 * 86400;
const signature = (secret, body) => createHmac('sha256', secret).update(`staff-workspace:v1:${body}`).digest();

export function signStaffWorkspace(secret, subject, organizationId, expiresAt, now = Date.now()) {
    if (typeof secret !== 'string' || !secret || typeof subject !== 'string' || !/^[1-9][0-9]{0,20}$/.test(subject)
        || !uuid.test(organizationId ?? '') || !Number.isFinite(expiresAt) || expiresAt <= now) throw new Error('INVALID_WORKSPACE_SELECTION');
    const expires = Math.min(Math.floor(expiresAt / 1000), Math.floor(now / 1000) + MAX_AGE);
    const body = Buffer.from(JSON.stringify({ v: 1, subject, organizationId, expires })).toString('base64url');
    return `${body}.${signature(secret, body).toString('base64url')}`;
}

export function readStaffWorkspace(secret, value, subject, now = Date.now()) {
    if (typeof secret !== 'string' || !secret || typeof value !== 'string' || value.length > 1024) return null;
    const parts = value.split('.');
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return null;
    const expected = signature(secret, parts[0]), actual = Buffer.from(parts[1], 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    try {
        const record = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        if (!record || Object.keys(record).length !== 4 || record.v !== 1 || record.subject !== subject
            || !uuid.test(record.organizationId ?? '') || !Number.isSafeInteger(record.expires)
            || record.expires <= Math.floor(now / 1000) || record.expires > Math.floor(now / 1000) + MAX_AGE) return null;
        return record.organizationId;
    } catch { return null; }
}
