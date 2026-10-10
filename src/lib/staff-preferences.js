import { withStaffActor } from './staff-authorization.js';
import { StaffOperationsError } from './staff-operations.js';
import { normalizeStaffTimeZone } from './staff-dates.js';
export async function saveStaffTimeZone(pool, identity, organizationId, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['timeZone', 'expectedVersion'].includes(key))) {
        throw new StaffOperationsError({ input: 'Only timeZone and expectedVersion are accepted' });
    }
    const timeZone = input.timeZone === null ? null : normalizeStaffTimeZone(input.timeZone);
    if (input.timeZone !== null && timeZone === null) throw new StaffOperationsError({ timeZone: 'Choose a supported IANA time zone' });
    if (typeof input.expectedVersion !== 'string' || !/^(0|[1-9]\d{0,18})$/.test(input.expectedVersion)
        || BigInt(input.expectedVersion) > 9223372036854775807n) {
        throw new StaffOperationsError({ expectedVersion: 'A nonnegative version string is required' });
    }
    return withStaffActor(pool, identity, organizationId, async ({ client, auditId, correlationId }) => {
        const result = await client.query('select app.set_staff_time_zone_v1($1::text,$2::bigint,$3::uuid,$4::uuid) as result',
            [timeZone, input.expectedVersion, auditId, correlationId]);
        return result.rows[0]?.result ?? null;
    });
}
