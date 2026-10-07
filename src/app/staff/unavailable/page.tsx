import { redirect } from 'next/navigation';
import { staffGate } from '@/lib/staff-gate.server';
import { SummaryRetry } from '../summary-retry';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Workspace unavailable · Agora staff' };

export default async function StaffUnavailablePage() {
    const gate = await staffGate();
    if (gate.stage !== 'unavailable') redirect('/staff');
    return (
        <section className="mx-auto max-w-xl px-6 py-24">
            <h1 className="text-2xl font-semibold">Workspace temporarily unavailable</h1>
            <p className="my-6 text-sm text-muted-foreground">
                We could not check your workspace access. Please retry in a moment.
                This does not mean your membership has been removed.
            </p>
            <SummaryRetry />
        </section>
    );
}
