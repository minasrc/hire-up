import { notFound } from 'next/navigation';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { TelegramHistoryBrowser } from './telegram-history-browser';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Telegram chats · Agora staff', robots: { index: false, follow: false } };

export default async function TelegramHistoryPage() {
    await requireStaffVerified();
    if (process.env.TELEGRAM_INTAKE_ENABLED !== '1') notFound();
    return <TelegramHistoryBrowser />;
}
