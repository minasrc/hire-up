import { notFound } from 'next/navigation';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { TelegramConnectionBrowser } from './telegram-connection-browser';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Connect Telegram · Agora staff', robots: { index: false, follow: false } };

export default async function TelegramConnectionPage() {
    await requireStaffVerified();
    if (process.env.TELEGRAM_INTAKE_ENABLED !== '1') notFound();
    return <TelegramConnectionBrowser />;
}
