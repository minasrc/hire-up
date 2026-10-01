import { notFound } from 'next/navigation';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { TelegramIntakeBrowser } from './telegram-intake-browser';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Telegram intake · Agora staff', robots: { index: false, follow: false } };

export default async function TelegramIntakePage() {
    await requireStaffVerified();
    if (process.env.TELEGRAM_INTAKE_ENABLED !== '1') notFound();
    return <TelegramIntakeBrowser />;
}
