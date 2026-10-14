import { notFound } from 'next/navigation';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { telegramOnboardingComplete } from '@/lib/telegram-history-operations';
import { TelegramHistoryBrowser } from './telegram-history-browser';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Telegram · Agora staff', robots: { index: false, follow: false } };

export default async function TelegramHistoryPage() {
    const gate = await requireStaffVerified();
    if (process.env.TELEGRAM_INTAKE_ENABLED !== '1') notFound();
    const onboarding = !await telegramOnboardingComplete(gate.pool, gate.identity, gate.organizationId);
    return <TelegramHistoryBrowser onboarding={onboarding} key={gate.organizationId} workspaceId={gate.organizationId} hostedEnabled={process.env.TELEGRAM_HOSTED_ENABLED === '1'} />;
}
