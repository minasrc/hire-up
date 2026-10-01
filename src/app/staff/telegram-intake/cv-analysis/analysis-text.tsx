'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/staff-ui/button';
import { analysisEndpoint, analysisRequest, type Analysis, type Block, type Evidence } from './analysis-api';
import { blockLabel } from './analysis-model';
export function CvQuote({ analysisId, evidence }: { analysisId: string; evidence: Evidence }) {
    const [block, setBlock] = useState<Block | null>(null);
    const [error, setError] = useState('');
    const [open, setOpen] = useState(false);
    const [unavailable, setUnavailable] = useState(false);
    useEffect(() => {
        if (!open) return;
        const controller = new AbortController();
        analysisRequest(`${analysisEndpoint}?analysisId=${analysisId}${evidence.blockOrdinal > 0 ? `&blockAfter=${evidence.blockOrdinal - 1}` : ''}`, { signal: controller.signal }).then(body => { if (!controller.signal.aborted) { setError(''); setUnavailable(!body.textAvailable); setBlock(body.textAvailable ? body.blocks.find((item: Block) => item.ordinal === evidence.blockOrdinal) ?? null : null); } }).catch(failure => { if (!controller.signal.aborted) { setError(failure.message); setBlock(null); setUnavailable(true); } });
        return () => controller.abort();
    }, [open, analysisId, evidence.blockOrdinal]);
    return <div className="space-y-2">{!unavailable ? <blockquote className="whitespace-pre-wrap break-words border-l-2 border-border pl-3 text-sm">{evidence.quote}</blockquote> : <p className="text-xs">This private CV reference is no longer available.</p>}<Button variant="ghost" size="sm" onClick={() => setOpen(value => !value)}>{open ? 'Hide CV reference' : 'Show CV reference'}</Button>{open ? <p className="text-xs text-muted-foreground">{error || (block ? blockLabel(block) : 'Loading reference…')}</p> : null}</div>;
}
export function AnalysisText({ analysis, disabled, onDecision }: { analysis: Analysis; disabled: boolean; onDecision: (decision: 'include' | 'exclude') => Promise<void> }) {
    const [open, setOpen] = useState(false);
    const [pendingDecision, setPendingDecision] = useState<boolean | null>(null);
    const [blocks, setBlocks] = useState<Block[]>([]);
    const [after, setAfter] = useState<number | null>(null);
    const [next, setNext] = useState<number | null>(null);
    const [available, setAvailable] = useState(true);
    const [loaded, setLoaded] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    useEffect(() => {
        if (!open) return;
        const controller = new AbortController();
        analysisRequest(`${analysisEndpoint}?analysisId=${analysis.id}${after === null ? '' : `&blockAfter=${after}`}`, { signal: controller.signal }).then(body => {
            if (controller.signal.aborted) return;
            setBlocks(value => !body.textAvailable ? [] : after === null ? body.blocks : [...value, ...body.blocks.filter((item: Block) => !value.some(previous => previous.ordinal === item.ordinal))]); setNext(body.nextBlockAfter); setAvailable(body.textAvailable); setLoaded(true); setError('');
        }).catch(failure => { if (!controller.signal.aborted) { setError(failure.message); setBlocks([]); setAvailable(false); setLoaded(false); setAfter(null); } }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [open, analysis.id, after]);
    return <section aria-label="Review extracted CV text" className="space-y-3 border-t border-border pt-4">
        <h4 className="text-sm font-medium">Full CV text</h4>
        <p className="text-xs text-muted-foreground">Extracted text stays private until you approve the candidate. Kept text is retained for later use and is not searchable yet.</p>

        <Button variant="outline" size="sm" aria-expanded={open} onClick={() => { setOpen(value => !value); if (!loaded) setLoading(true); }}>{open ? 'Hide extracted CV text' : 'Review extracted CV text'}</Button>
        {open ? <div className="space-y-4">{blocks.map(block => <article key={block.ordinal} className="space-y-2 rounded-lg border border-border p-3"><h5 className="text-xs font-medium">{blockLabel(block)}</h5><p className="whitespace-pre-wrap break-words text-sm">{block.text || 'No readable text in this block.'}</p></article>)}{!available ? <p className="text-sm">Private extracted text is no longer retained here. Review the original CV.</p> : null}{loading ? <p role="status" className="text-sm">Loading CV text…</p> : null}{error ? <p role="alert" className="text-sm">{error}</p> : null}{next !== null ? <Button variant="outline" size="sm" disabled={loading} onClick={() => { setLoading(true); setAfter(next); }}>Load more CV text</Button> : null}</div> : null}
        {open ? <><label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={pendingDecision ?? analysis.textDecision === 'include'} disabled={disabled || !available} onChange={event => { const include = event.target.checked; setPendingDecision(include); void onDecision(include ? 'include' : 'exclude').finally(() => setPendingDecision(null)); }} />Keep extracted CV text with this profile</label>
        <p className="text-xs text-muted-foreground">Optional. Turning this off keeps the profile fields and CV file when you approve.</p></> : null}
    </section>;
}
