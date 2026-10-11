'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/staff-ui/button';
import { Card } from '@/components/staff-ui/card';
import { staffAuthRecovery } from '@/lib/staff-auth-recovery';
import { StaffAuthRecoveryPrompt } from '../../auth-recovery';
import { TelegramProvenance, provenanceLink, provenanceSourceLabel, provenanceVisible } from './telegram-provenance-model';

export function PrivateTelegramProvenance({ candidateId }: { candidateId: string }) {
    const [snapshot, setSnapshot] = useState<TelegramProvenance | null>(null);
    const [cursors, setCursors] = useState<(string | null)[]>([null]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [hidden, setHidden] = useState(false);
    const [blocked, setBlocked] = useState(false);
    const currentRequest = useRef<{ controller: AbortController | null; blocked: boolean }>({ controller: null, blocked: false });
    const clearPrivate = useCallback(() => {
        currentRequest.current.blocked = true; currentRequest.current.controller?.abort();
        setSnapshot(null); setCursors([null]); setLoading(false); setBlocked(true); setError('');
    }, []);
    const load = useCallback(async (stack: (string | null)[] = [null]) => {
        const active = currentRequest.current;
        if (active.blocked) return;
        active.controller?.abort();
        const controller = new AbortController(); active.controller = controller;
        const epoch = staffAuthRecovery.requestEpoch();
        setLoading(true); setError(''); setSnapshot(null); setCursors(stack);
        try {
            const params = new URLSearchParams(); const after = stack.at(-1); if (after) params.set('after', after);
            const response = await fetch(`/api/staff/candidates/${encodeURIComponent(candidateId)}/telegram-context${params.size ? `?${params}` : ''}`, { cache: 'no-store', signal: controller.signal });
            if (controller.signal.aborted || active.blocked || epoch !== staffAuthRecovery.requestEpoch()) return;
            if (response.status === 404) { setHidden(true); return; }
            if ([401, 403, 428].includes(response.status)) {
                clearPrivate(); staffAuthRecovery.require(response.status, epoch);
                setError('Access to private source links is unavailable. Verify your access before retrying.'); return;
            }
            if (!response.ok) throw new Error('service unavailable');
            const data: TelegramProvenance = await response.json();
            if (controller.signal.aborted || active.blocked || epoch !== staffAuthRecovery.requestEpoch()) return;
            setSnapshot(data); setHidden(false); staffAuthRecovery.accepted(epoch);
        } catch {
            if (!controller.signal.aborted && !active.blocked) setError('Private source links could not be loaded. Check your connection and retry.');
        } finally { if (!controller.signal.aborted && active.controller === controller) setLoading(false); }
    }, [candidateId, clearPrivate]);
    useEffect(() => {
        let cancelled = false;
        const active = currentRequest.current;
        queueMicrotask(() => { if (!cancelled) void load(); });
        const invalidate = () => clearPrivate();
        const retry = () => { active.blocked = false; setBlocked(false); void load(); };
        window.addEventListener('staff-session-invalidated', invalidate); window.addEventListener('staff-auth-retry', retry);
        return () => { cancelled = true; active.controller?.abort(); window.removeEventListener('staff-session-invalidated', invalidate); window.removeEventListener('staff-auth-retry', retry); };
    }, [load, clearPrivate]);

    if (hidden || (!loading && !error && !provenanceVisible(snapshot))) return null;
    return <Card className="space-y-3 p-5" aria-label="Private Telegram provenance">
        <h2 className="font-semibold">Private Telegram provenance</h2>
        <p className="text-sm text-muted-foreground">Original source links are visible only to the importing owner. Shared profiles do not grant access to private conversations.</p>
        <StaffAuthRecoveryPrompt />
        <p role="status" aria-live="polite" className="text-sm">{loading ? 'Loading private source links…' : error}</p>
        {error ? <Button variant="outline" disabled={blocked || loading} onClick={() => void load(cursors)}>Retry source links</Button> : null}
        {snapshot?.provenanceUnavailable ? <p className="text-sm text-muted-foreground">Original provenance from an earlier extraction is unavailable. No original source link can be confirmed for those records.</p> : null}
        {snapshot?.sources.map(source => <div key={source.id} className="space-y-1 rounded-lg border p-3">
            <Link className="text-sm underline underline-offset-4" href={provenanceLink(source)}>{provenanceSourceLabel(source)}</Link>
            {!source.available ? <p className="text-xs text-muted-foreground">The original quote is no longer retained or is unavailable. This link keeps the original message anchor.</p> : null}
            {source.sourceChanged ? <p className="text-xs font-medium">Source changed after extraction; review approved facts.</p> : null}
        </div>)}
        {snapshot?.sources.length ? <div className="flex flex-wrap items-center gap-2"><span className="text-xs text-muted-foreground">Source page {cursors.length}</span><Button variant="outline" size="sm" disabled={loading || cursors.length === 1} onClick={() => void load(cursors.slice(0, -1))}>Previous sources</Button>{snapshot.nextAfter ? <Button variant="outline" size="sm" disabled={loading} onClick={() => void load([...cursors, snapshot.nextAfter])}>Next sources</Button> : null}</div> : null}
    </Card>;
}
