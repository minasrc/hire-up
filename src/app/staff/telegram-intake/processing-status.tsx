'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, LoaderCircle } from 'lucide-react';
import { staffWorkspaceFetch } from '@/lib/staff-workspace-fetch';
import { Card } from '@/components/staff-ui/card';
import { Button } from '@/components/staff-ui/button';

type Counts = { queued: number; leased: number; waiting: number; failed: number; completed: number; needsReview: number };
export function ProcessingStatus() {
    const [counts, setCounts] = useState<Counts | null>(null);
    const [importing, setImporting] = useState(false);
    const [unavailable, setUnavailable] = useState(false);
    useEffect(() => {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout>;
        let controller: AbortController;
        async function poll() {
            if (document.hidden) return;
            controller?.abort(); controller = new AbortController();
            try {
                const response = await staffWorkspaceFetch('/api/staff/telegram-extraction', { cache: 'no-store', signal: controller.signal });
                if (!response.ok) throw new Error('unavailable');
                const result = await response.json();
                const history = await staffWorkspaceFetch('/api/staff/telegram-history?view=active', { cache: 'no-store', signal: controller.signal });
                const chats = history.ok ? await history.json() : null;
                if (!stopped) setImporting(Boolean(chats?.chats?.length));
                if (!stopped) { setCounts(result.counts); setUnavailable(false); }
            } catch { if (!stopped && !controller.signal.aborted) setUnavailable(true); }
            if (!stopped) timer = setTimeout(() => void poll(), 8000);
        }
        const visibility = () => { clearTimeout(timer); if (document.hidden) controller?.abort(); else void poll(); };
        void poll(); document.addEventListener('visibilitychange', visibility);
        return () => { stopped = true; clearTimeout(timer); controller?.abort(); document.removeEventListener('visibilitychange', visibility); };
    }, []);
    const working = importing || !counts || counts.queued + counts.leased + counts.waiting > 0;
    return <Card className="flex flex-wrap items-center gap-4 p-5" aria-live="polite">
        {working ? <LoaderCircle className="h-6 w-6 shrink-0 text-primary motion-safe:animate-spin" /> : <CheckCircle2 className="h-6 w-6 shrink-0 text-primary" />}
        <div className="min-w-40 flex-1"><p className="text-sm font-medium">{unavailable ? 'Reconnecting…' : working ? 'Finding candidates…' : counts?.failed ? 'Some chats need attention' : counts?.needsReview ? 'Proposals ready' : 'Watching for candidate updates'}</p><p className="mt-1 text-xs text-muted-foreground">{working ? 'You can leave this page.' : 'Approved information is saved to candidate profiles.'}</p></div>
        <Button asChild variant="outline" size="sm" className="w-full sm:w-auto"><Link href="/staff/telegram-intake">Review proposals</Link></Button>
        {working ? <div role="progressbar" aria-label="Processing Telegram information" className="h-1.5 w-full overflow-hidden rounded-full bg-muted"><div className="h-full w-1/3 rounded-full bg-primary motion-safe:animate-pulse" /></div> : null}
    </Card>;
}
