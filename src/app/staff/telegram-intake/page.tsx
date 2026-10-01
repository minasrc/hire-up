import { notFound } from 'next/navigation';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { TelegramIntakeBrowser } from './telegram-intake-browser';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Telegram intake · Agora staff', robots: { index: false, follow: false } };

export default async function TelegramIntakePage({ searchParams }: { searchParams: Promise<{ draft?: string | string[] }> }) {
    await requireStaffVerified();
    if (process.env.TELEGRAM_INTAKE_ENABLED !== '1') notFound();
    const query = await searchParams;
    const initialDraftId = typeof query.draft === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query.draft) ? query.draft : undefined;
    return <TelegramIntakeBrowser key={initialDraftId ?? 'inbox'} initialDraftId={initialDraftId} />;
}
