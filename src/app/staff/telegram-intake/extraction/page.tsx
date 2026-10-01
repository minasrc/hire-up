import { notFound } from 'next/navigation';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { ExtractionQueueBrowser } from './extraction-queue-browser';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Candidate extraction · Agora staff', robots: { index: false, follow: false } };
export default async function ExtractionPage() {
    await requireStaffVerified();
    if (process.env.TELEGRAM_INTAKE_ENABLED !== '1') notFound();
    return <ExtractionQueueBrowser />;
}
