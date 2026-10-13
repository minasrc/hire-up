'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, LoaderCircle } from 'lucide-react';
import { staffWorkspaceFetch } from '@/lib/staff-workspace-fetch';
import { Button } from '@/components/staff-ui/button';

type Counts = { queued: number; leased: number; waiting: number; failed: number; completed: number; needsReview: number };
export function ProcessingStatus({ reviewLink = true, starting = false }: { reviewLink?: boolean; starting?: boolean }) {
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
    const working = starting || importing || !counts || counts.queued + counts.leased + counts.waiting > 0;
    return <div role="status" aria-label="Telegram activity" className="flex min-h-9 flex-wrap items-center gap-2 rounded-lg bg-muted/50 px-3 py-2" aria-live="polite">
        {working ? <LoaderCircle className="h-3.5 w-3.5 shrink-0 text-primary motion-safe:animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-primary" />}
        <span className="text-xs text-muted-foreground">{starting ? 'Starting…' : unavailable ? 'Reconnecting…' : working ? 'Finding candidates…' : counts?.failed ? 'Some chats need attention' : counts?.needsReview ? 'Proposals ready' : 'Watching for updates'}</span>
        <div role={working ? 'progressbar' : undefined} aria-label={working ? 'Processing Telegram information' : undefined} className="h-1.5 min-w-24 max-w-sm flex-1 overflow-hidden rounded-full bg-foreground/10"><div className={`h-full rounded-full ${working ? 'w-1/3 bg-primary motion-safe:animate-pulse' : 'w-full bg-primary/30'}`} /></div>
        {reviewLink ? <Button asChild variant="ghost" size="sm" className="ml-auto h-6 px-2 text-xs"><Link href="/staff/telegram-intake">Review proposals</Link></Button> : null}
    </div>;
}
