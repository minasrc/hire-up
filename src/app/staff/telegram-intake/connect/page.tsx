import { notFound, redirect } from 'next/navigation';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { multiWorkspaceEnabled } from '@/lib/staff-workspace-context.server';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Connect Telegram · Agora staff', robots: { index: false, follow: false } };

export default async function TelegramConnectionPage() {
    const gate = await requireStaffVerified();
    if (process.env.TELEGRAM_INTAKE_ENABLED !== '1') notFound();
    redirect(`/staff/telegram-intake/chats${multiWorkspaceEnabled() ? `?_workspace=${gate.organizationId}` : ''}#telegram-connection`);
}
