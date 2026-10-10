import { PageHeader } from '@/components/staff-preview/shared';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { TimeZoneSettings } from '../time-zone-settings';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Account settings · Agora staff' };
export default async function StaffSettingsPage() {
    await requireStaffVerified();
    return <section className="mx-auto flex w-full max-w-5xl flex-col gap-6"><PageHeader eyebrow="Account" title="Account settings" /><TimeZoneSettings /></section>;
}
