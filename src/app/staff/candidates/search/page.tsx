import { notFound } from 'next/navigation';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { ProfileSearchBrowser } from './profile-search-browser';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Search by meaning · Agora staff', robots: { index: false, follow: false } };
export default async function ProfileSearchPage({ searchParams }: { searchParams: Promise<{ scope?: string; queryId?: string }> }) {
    await requireStaffVerified();
    if (process.env.TELEGRAM_INTAKE_ENABLED !== '1') notFound();
    const params = await searchParams;
    const initialScope = ['approved', 'my_drafts'].includes(params.scope ?? '') ? params.scope as 'approved' | 'my_drafts' : 'all';
    const initialQueryId = typeof params.queryId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.queryId) ? params.queryId : undefined;
    return <ProfileSearchBrowser initialScope={initialScope} initialQueryId={initialQueryId} />;
}
