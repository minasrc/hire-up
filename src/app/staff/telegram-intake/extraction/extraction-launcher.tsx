'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/staff-ui/button';
import { extractionAction } from './extraction-api';

export function ExtractionLauncher({ chatIds, disabled = false, label = 'Start automatic extraction' }: { chatIds: string[]; disabled?: boolean; label?: string }) {
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState('');
    const [error, setError] = useState('');
    async function enqueue() {
        if (busy || disabled || !chatIds.length) return;
        setBusy(true); setNotice(''); setError('');
        try {
            const result = await extractionAction({ action: 'enqueue', chatIds });
            setNotice(result.queued ? `${result.queued} extraction ${result.queued === 1 ? 'batch' : 'batches'} queued. Automatic extraction will continue as imported messages arrive.` : 'Automatic extraction is on. New imported messages will be processed as they arrive.');
        } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to queue extraction.'); }
        finally { setBusy(false); }
    }
    return <div className="space-y-2"><Button variant="outline" size="sm" disabled={busy || disabled || !chatIds.length} onClick={() => void enqueue()}>{busy ? 'Queuing…' : label}</Button>
        {notice ? <p role="status" className="max-w-sm text-xs">{notice} <Link className="underline underline-offset-4" href="/staff/telegram-intake/extraction">View extraction progress</Link></p> : null}
        {error ? <p role="alert" className="max-w-sm text-xs">{error}</p> : null}
    </div>;
}
