import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import {
    DEFAULT_STAFF_TIME_ZONE,
    formatStaffCalendarDate,
    formatStaffDate,
    formatStaffTimestamp,
    normalizeStaffTimeZone,
    staffTimeZone,
} from '../../src/lib/staff-dates.js';

test('time zone normalization accepts canonical and legacy IANA names only', () => {
    assert.equal(DEFAULT_STAFF_TIME_ZONE, 'UTC');
    assert.equal(normalizeStaffTimeZone(null), null);
    assert.equal(normalizeStaffTimeZone('UTC'), 'UTC');
    assert.equal(normalizeStaffTimeZone('Etc/UTC'), 'UTC');
    assert.equal(normalizeStaffTimeZone('GMT'), 'UTC');
    assert.equal(normalizeStaffTimeZone('US/Eastern'), 'America/New_York');
    assert.equal(normalizeStaffTimeZone('Asia/Calcutta'), normalizeStaffTimeZone('Asia/Kolkata'));
    for (const invalid of ['', ' UTC', '+02:00', 'Invalid/Zone', 'x'.repeat(101)]) {
        assert.equal(normalizeStaffTimeZone(invalid), null);
    }
    assert.equal(staffTimeZone(null), 'UTC');
    assert.throws(() => staffTimeZone('Invalid/Zone'), RangeError);
});

test('instant dates and timestamps honor explicit zones and DST offsets', () => {
    assert.equal(formatStaffDate('2026-09-30T23:30:00Z', 'UTC'), '30 Sept 2026');
    assert.equal(formatStaffDate('2026-09-30T23:30:00Z', 'Europe/Madrid'), '1 Oct 2026');
    assert.equal(formatStaffTimestamp('2026-03-29T00:30:00Z', 'Europe/Madrid'), '29 Mar 2026, 01:30:00 GMT+1');
    assert.equal(formatStaffTimestamp('2026-03-29T01:30:00Z', 'Europe/Madrid'), '29 Mar 2026, 03:30:00 GMT+2');
    assert.equal(formatStaffTimestamp('2026-10-25T00:30:00Z', 'Europe/Madrid'), '25 Oct 2026, 02:30:00 GMT+2');
    assert.equal(formatStaffTimestamp('2026-10-25T01:30:00Z', 'Europe/Madrid'), '25 Oct 2026, 02:30:00 GMT+1');
    assert.throws(() => formatStaffTimestamp('2026-10-10T00:00:00Z'), RangeError);
});

test('calendar dates stay calendar dates and invalid instants fail closed', () => {
    assert.equal(formatStaffCalendarDate('2026-10-10'), '10 Oct 2026');
    assert.equal(formatStaffCalendarDate('2026-02-30'), '—');
    assert.equal(formatStaffTimestamp('2026-10-10', 'UTC'), '—');
    assert.equal(formatStaffTimestamp('2026-10-10T10:00:00', 'UTC'), '—');
    assert.equal(formatStaffTimestamp(true, 'UTC'), '—');
    assert.equal(formatStaffTimestamp([], 'UTC'), '—');
    assert.equal(formatStaffTimestamp(1n, 'UTC'), '—');
});

test('repeated rendering reuses zone normalization and date formatters', () => {
    const Original = Intl.DateTimeFormat;
    let constructions = 0;
    Intl.DateTimeFormat = class extends Original {
        constructor(...args) { super(...args); constructions++; }
    };
    try {
        formatStaffDate('2026-10-10T00:00:00Z', 'Pacific/Fiji');
        formatStaffDate('2026-10-11T00:00:00Z', 'Pacific/Fiji');
        formatStaffTimestamp('2026-10-10T00:00:00Z', 'Pacific/Fiji');
        assert.equal(constructions, 3);
    } finally { Intl.DateTimeFormat = Original; }
});

test('formatting is independent of the process time zone', () => {
    const script = `import { formatStaffDate, formatStaffTimestamp } from './src/lib/staff-dates.js'; console.log(JSON.stringify([formatStaffDate('2026-09-30T23:30:00Z','Europe/Madrid'),formatStaffTimestamp('2026-10-25T01:30:00Z','Europe/Madrid')]));`;
    const outputs = ['Pacific/Honolulu', 'Europe/Madrid'].map(TZ => execFileSync(
        process.execPath, ['--input-type=module', '-e', script], {
            cwd: new URL('../../', import.meta.url), encoding: 'utf8',
            env: { ...process.env, TZ },
        },
    ).trim());
    assert.equal(outputs[0], outputs[1]);
});

test('UTC labels stay identical across ICU zero-offset spellings', async () => {
    const Original = Intl.DateTimeFormat;
    let zeroOffsetLabel = 'GMT+0';
    Intl.DateTimeFormat = class extends Original {
        format(value) { return super.format(value).replace(/ GMT$/, ` ${zeroOffsetLabel}`); }
        formatToParts(value) {
            return super.formatToParts(value).map(part =>
                part.type === 'timeZoneName' && part.value === 'GMT'
                    ? { ...part, value: zeroOffsetLabel } : part);
        }
    };
    try {
        const { formatStaffTimestamp: formatAcrossRuntimes } = await import(
            '../../src/lib/staff-dates.js?icu-zero-offset-regression');
        for (zeroOffsetLabel of ['GMT', 'GMT+0', 'GMT-0', 'GMT+0:00']) {
            assert.equal(formatAcrossRuntimes('2026-01-10T12:34:56Z', 'UTC'),
                '10 Jan 2026, 12:34:56 GMT');
            assert.equal(formatAcrossRuntimes('2026-01-10T12:34:56Z', 'Europe/London'),
                '10 Jan 2026, 12:34:56 GMT');
        }
        assert.equal(formatAcrossRuntimes('2026-01-10T12:34:56Z', 'America/New_York'),
            '10 Jan 2026, 07:34:56 GMT-5');
        assert.equal(formatAcrossRuntimes('2026-01-10T12:34:56Z', 'Asia/Kolkata'),
            '10 Jan 2026, 18:04:56 GMT+5:30');
    } finally {
        Intl.DateTimeFormat = Original;
    }
});
