export const DEFAULT_STAFF_TIME_ZONE = 'UTC';
const normalizedZones = new Map();
export function normalizeStaffTimeZone(value) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 100 || value !== value.trim()) return null;
    if (normalizedZones.has(value)) return normalizedZones.get(value);
    let normalized = null;
    try {
        const zone = new Intl.DateTimeFormat('en-GB', { timeZone: value }).resolvedOptions().timeZone;
        if (zone === 'UTC' || zone.includes('/')) normalized = zone;
    } catch {}
    if (normalizedZones.size >= 64) normalizedZones.delete(normalizedZones.keys().next().value);
    normalizedZones.set(value, normalized);
    return normalized;
}
export function staffTimeZone(preference) {
    if (preference === null) return DEFAULT_STAFF_TIME_ZONE;
    const zone = normalizeStaffTimeZone(preference);
    if (!zone) throw new RangeError('An explicit supported time zone is required');
    return zone;
}
const formatters = new Map();
function formatter(zone, full) {
    const canonical = normalizeStaffTimeZone(zone);
    if (!canonical) throw new RangeError('An explicit supported time zone is required');
    const key = `${canonical}:${full}`;
    if (!formatters.has(key)) {
        if (formatters.size >= 64) formatters.delete(formatters.keys().next().value);
        formatters.set(key, new Intl.DateTimeFormat('en-GB', {
            timeZone: canonical, day: 'numeric', month: 'short', year: 'numeric',
            ...(full ? { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' } : {}),
        }));
    }
    return formatters.get(key);
}
function instant(value) {
    if (value == null || value === '' || typeof value === 'boolean') return null;
    if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) return null;
    if (typeof value === 'string' && !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
}
export function formatStaffDate(value, zone) {
    const output = formatter(zone, false);
    const date = instant(value);
    return date ? output.format(date) : '—';
}
export function formatStaffTimestamp(value, zone) {
    const output = formatter(zone, true);
    const date = instant(value);
    return date ? output.format(date) : '—';
}
export function formatStaffCalendarDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return '—';
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
        ? formatter('UTC', false).format(date) : '—';
}
