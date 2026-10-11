'use client';
import { formatStaffCalendarDate, formatStaffDate, formatStaffTimestamp } from '@/lib/staff-dates';
import { useStaffTimeZone } from './time-zone-provider';
export function StaffDate({ value, kind = 'date' }: { value: string | number | Date | null | undefined; kind?: 'date' | 'timestamp' | 'calendar' }) {
    const { timeZone } = useStaffTimeZone();
    const text = kind === 'calendar' ? formatStaffCalendarDate(value)
        : kind === 'timestamp' ? formatStaffTimestamp(value, timeZone) : formatStaffDate(value, timeZone);
    const dateTime = text === '—' ? undefined : kind === 'calendar' ? String(value)
        : value instanceof Date ? value.toISOString() : new Date(value as string | number).toISOString();
    return <time dateTime={dateTime} title={kind === 'calendar' ? undefined : timeZone}>{text}</time>;
}
