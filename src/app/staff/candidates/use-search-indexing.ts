'use client';

import { useEffect, useRef, useState } from 'react';
import { searchEndpoint, searchRequest } from './search/search-api';
import { searchIndexingStatus } from './search/search-model';

export type SearchCoverage = { eligible: number; indexed: number; fullyIndexed?: number; pending: number; failed: number; corpusChanged?: boolean };

// Coverage never participates in loading the directory or running a query.
export function useSearchIndexing(enabled: boolean, candidateTotal: number) {
    const [coverage, setCoverage] = useState<SearchCoverage | null>(null);
    const [revision, setRevision] = useState(0);
    const [check, setCheck] = useState(0);
    const [animated, setAnimated] = useState(false);
    const previous = useRef<SearchCoverage | null>(null);
    const processing = Boolean(coverage && searchIndexingStatus(coverage)?.incomplete && coverage.pending > 0);

    useEffect(() => {
        if (!enabled) return;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout>;
        let request: AbortController | null = null;
        let includeCv = false;
        async function read() {
            if (stopped || document.hidden) return;
            request?.abort();
            const controller = new AbortController();
            request = controller;
            try {
                const result = await searchRequest(`${searchEndpoint}?scope=approved&includeCv=${includeCv}`, {
                    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
                });
                if (stopped || controller.signal.aborted) return;
                if (!includeCv && result.cvAvailable) { includeCv = true; void read(); return; }
                const next: SearchCoverage | null = result.coverage ?? null;
                if (previous.current && next && !searchIndexingStatus(next)?.incomplete && (
                    searchIndexingStatus(previous.current)?.incomplete || previous.current.eligible !== next.eligible
                    || (previous.current.fullyIndexed ?? previous.current.indexed) !== (next.fullyIndexed ?? next.indexed)
                )) {
                    setRevision(value => value + 1);
                }
                previous.current = next;
                setCoverage(next);
                if ((next?.pending ?? 0) > 0) timer = setTimeout(() => void read(), 8000);
            } catch {
                // A status check failing never clears the table or blocks search.
                if (!stopped && !controller.signal.aborted) timer = setTimeout(() => void read(), 10000);
            }
        }
        const visibility = () => {
            clearTimeout(timer); request?.abort();
            if (!document.hidden) void read();
        };
        const lost = () => { stopped = true; clearTimeout(timer); request?.abort(); previous.current = null; setCoverage(null); };
        void read();
        document.addEventListener('visibilitychange', visibility);
        window.addEventListener('staff-session-invalidated', lost);
        return () => { stopped = true; clearTimeout(timer); request?.abort(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('staff-session-invalidated', lost); };
    }, [enabled, candidateTotal, check]);

    useEffect(() => {
        if (!processing) return;
        // Animation is bounded; a queued profile is not an endless active search.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setAnimated(true);
        const timer = setTimeout(() => setAnimated(false), 15000);
        return () => clearTimeout(timer);
    }, [processing]);

    return { coverage: enabled ? coverage : null, revision, animated: processing && animated, refresh: () => setCheck(value => value + 1) };
}
