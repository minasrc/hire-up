'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/staff-ui/button';
import { extractionEndpoint, extractionRequest } from './extraction-api';

type Source = { chat: { title: string }; messages: { messageId: string; kind: string; text: string | null; sender?: { firstName?: string | null; lastName?: string | null; username?: string | null } | null; attachments: { kind: string; filename?: string | null }[] }[] };

export function BatchSource({ jobId }: { jobId: string }) {
    const [open, setOpen] = useState(false);
    const [source, setSource] = useState<Source | null>(null);
    const [error, setError] = useState('');
    const [revision, setRevision] = useState(0);
    useEffect(() => {
        if (!open) return;
        const controller = new AbortController();
        extractionRequest(`${extractionEndpoint}?jobId=${encodeURIComponent(jobId)}`, { signal: controller.signal })
            .then(result => { if (!controller.signal.aborted) { setSource(result.source); setError(''); } })
            .catch(failure => { if (!controller.signal.aborted) { setSource(null); setError(failure instanceof Error ? failure.message : 'Unable to load source messages.'); } });
        return () => controller.abort();
    }, [open, jobId, revision]);
    return <div className="space-y-3">
        <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => { setOpen(value => !value); setSource(null); }}> {open ? 'Hide source messages' : 'Review source messages'}</Button>
        {open ? <section aria-label="Private batch source" className="space-y-4 rounded-lg border border-border p-4">
            <p className="text-xs text-muted-foreground">These are the private messages supplied for this batch. Check for missed candidates and incorrect interpretations. Attachments are metadata only; their files were not read.</p>
            {error ? <div role="alert" className="space-y-2 text-sm"><p>{error}</p><Button variant="outline" size="sm" onClick={() => setRevision(value => value + 1)}>Retry source messages</Button></div> : !source ? <p role="status" className="text-sm">Loading source messages…</p> : null}
            {source?.messages.map(message => <article key={message.messageId} className="space-y-2 border-t border-border pt-3">
                <p className="text-xs text-muted-foreground">Message {message.messageId}{message.sender?.username ? ` · @${message.sender.username}` : ''}</p>
                <p className="whitespace-pre-wrap break-words text-sm">{message.kind === 'unavailable' ? 'This message is unavailable.' : message.text || 'No text in this message.'}</p>
                {message.attachments.length ? <ul className="space-y-1 text-xs text-muted-foreground">{message.attachments.map((item, index) => <li key={index} className="break-words">{item.filename || item.kind} · Metadata only</li>)}</ul> : null}
            </article>)}
            {source && !source.messages.length ? <p className="text-sm">No messages are available in this batch snapshot.</p> : null}
        </section> : null}
    </div>;
}
