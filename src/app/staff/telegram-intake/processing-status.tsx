'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, CheckCircle2, LoaderCircle, PauseCircle } from 'lucide-react';
import { staffWorkspaceFetch } from '@/lib/staff-workspace-fetch';
import { activeExtractionCount, telegramImportInProgress } from './telegram-activity-model';
import { Button } from '@/components/staff-ui/button';

type Counts = { queued: number; leased: number; waiting: number; failed: number; completed: number; needsReview: number; active?: number; paused?: number };
export function ProcessingStatus({ reviewLink = true, starting = false, imported = false, onProposalCount }: { reviewLink?: boolean; starting?: boolean; imported?: boolean; onProposalCount?: (count: number) => void }) {
    const [counts, setCounts] = useState<Counts | null>(null);
    const [proposals, setProposals] = useState(0);
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
                if (!history.ok) throw new Error('unavailable');
                const chats = await history.json();
                if (reviewLink) {
                    const inbox = await staffWorkspaceFetch('/api/staff/telegram-intake/drafts?view=all', { cache: 'no-store', signal: controller.signal });
                    if (!inbox.ok) throw new Error('unavailable');
                    const count = (await inbox.json()).result.counts.all;
                    if (!stopped && !controller.signal.aborted) { setProposals(count); onProposalCount?.(count); }
                }
                if (!stopped) setImporting(telegramImportInProgress(chats?.chats ?? []));
                if (!stopped) { setCounts({ ...result.counts, active: activeExtractionCount(result), paused: result.counts.paused ?? result.jobs?.filter((job: { extractionEnabled: boolean; status: string }) => job.extractionEnabled === false && ['queued', 'waiting'].includes(job.status)).length ?? 0 }); setUnavailable(false); }
            } catch { if (!stopped && !controller.signal.aborted) setUnavailable(true); }
            if (!stopped) timer = setTimeout(() => void poll(), 3000);
        }
        const visibility = () => { clearTimeout(timer); if (document.hidden) controller?.abort(); else void poll(); };
        void poll(); document.addEventListener('visibilitychange', visibility);
        return () => { stopped = true; clearTimeout(timer); controller?.abort(); document.removeEventListener('visibilitychange', visibility); };
    }, [reviewLink, onProposalCount]);
    const working = !unavailable && (starting || importing || (counts?.active ?? 0) > 0);
    const paused = (counts?.paused ?? 0) > 0;
    return <div role="status" aria-label="Telegram activity" className="flex min-h-9 flex-wrap items-center gap-2 rounded-lg bg-card px-3 py-2" aria-live="polite">
        {unavailable ? <AlertCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : working || !counts ? <LoaderCircle className="h-3.5 w-3.5 shrink-0 text-primary motion-safe:animate-spin" /> : paused ? <PauseCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-primary" />}
        <span className="text-xs text-muted-foreground">{starting ? 'Starting…' : unavailable ? 'Status unavailable' : reviewLink && proposals > 0 ? `${proposals} proposal${proposals === 1 ? '' : 's'} ready${working ? ' · Finding more…' : paused ? ' · Processing paused' : ''}` : working ? `Finding candidates…${paused ? ' · Some chats paused' : ''}` : paused ? 'Processing paused' : !counts ? 'Checking status…' : counts?.failed ? 'Some chats need attention' : counts?.needsReview && !reviewLink ? 'Proposals ready' : imported ? 'No new candidates found' : 'Watching for updates'}</span>
        {working ? <div role="progressbar" aria-label="Processing Telegram information" className="h-1.5 min-w-24 max-w-sm flex-1 overflow-hidden rounded-full bg-secondary"><div className={`h-full rounded-full w-1/3 bg-attention motion-safe:animate-pulse`} /></div> : null}
        {paused && !starting && !unavailable ? <Button asChild variant="outline" size="sm" className="ml-auto"><Link href="/staff/telegram-intake/chats?group=connected">View paused chats</Link></Button> : null}
        {reviewLink && proposals > 0 && !starting && !unavailable ? <Button asChild size="sm" className="ml-auto"><Link href="/staff/telegram-intake">Review proposals</Link></Button> : null}
    </div>;
}
