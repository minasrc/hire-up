import { notFound } from 'next/navigation';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { TelegramContextBrowser } from './telegram-context-browser';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Search conversations · Agora staff', robots: { index: false, follow: false } };

export default async function TelegramContextPage() {
    await requireStaffVerified();
    if (process.env.TELEGRAM_INTAKE_ENABLED !== '1') notFound();
    return <TelegramContextBrowser />;
}
