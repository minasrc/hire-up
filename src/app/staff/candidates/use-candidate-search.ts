'use client';

import { useEffect, useRef, useState } from 'react';
import { searchAction, searchEndpoint, searchRequest } from './search/search-api';
import { safeSearchSnapshot, searchGuidance } from './search/search-model';
import type { CandidateRow } from './candidates-browser';

type SearchCoverage = { eligible: number; indexed: number; fullyIndexed?: number; pending: number; failed: number; corpusChanged?: boolean };

type SearchState = { query: string; after: string; status: 'searching' | 'completed' | 'unavailable' | 'failed'; rows: CandidateRow[]; next: string | null; error?: string; coverage?: SearchCoverage | null };

export function useCandidateSearch(query: string, enabled: boolean) {
    const [state, setState] = useState<SearchState | null>(null);
    const [paging, setPaging] = useState<{ query: string; cursors: string[] }>({ query: '', cursors: [''] });
    const [revision, setRevision] = useState(0);
    const current = useRef<{ query: string; id: string; includeCv: boolean } | null>(null);
    const cursors = paging.query === query ? paging.cursors : [''];
    const after = cursors[cursors.length - 1];

    useEffect(() => {
        let stopped = false;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        const previous = current.current;
        if (previous && previous.query !== query) {
            current.current = null;
            void searchAction({ action: 'cancel', queryId: previous.id }).catch(() => {});
        }
        if (!enabled) return () => controller.abort();
        const publish = (next: Omit<SearchState, 'query' | 'after'>) => {
            if (!stopped) setState({ query, after, ...next });
        };
        let coverage: SearchCoverage | null = null;
        async function run() {
            publish({ status: 'searching', rows: [], next: null });
            try {
                let active = current.current;
                if (!active || active.query !== query) {
                    const availability = await searchRequest(`${searchEndpoint}?scope=approved&includeCv=false`, { signal: controller.signal });
                    if (stopped) return;
                    coverage = availability.coverage ?? null;
                    if (!availability.workerAvailable) { publish({ status: 'unavailable', rows: [], next: null, coverage }); return; }
                    const includeCv = availability.cvAvailable === true;
                    const started = await searchRequest(searchEndpoint, { method: 'POST', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'search', operationId: crypto.randomUUID(), query, scope: 'approved', readyOnly: false, includeCv }) });
                    if (stopped) { void searchAction({ action: 'cancel', queryId: started.queryId }).catch(() => {}); return; }
                    active = { query, id: started.queryId, includeCv }; current.current = active;
                }
                const params = new URLSearchParams({ queryId: active.id, directory: 'true' });
                if (after) params.set('after', after);
                const snapshot = safeSearchSnapshot(await searchRequest(`${searchEndpoint}?${params}`, { signal: controller.signal }));
                if (stopped) return;
                coverage = snapshot.coverage ?? coverage;
                if (snapshot.status === 'completed') {
                    publish({ status: 'completed', rows: (snapshot.results ?? []).filter((row: { directoryRow?: CandidateRow }) => row.directoryRow).map((row: { directoryRow: CandidateRow }) => row.directoryRow), next: snapshot.nextAfter ?? null, coverage });
                } else if (snapshot.status === 'queued' || snapshot.status === 'running') {
                    publish({ status: snapshot.workerAvailable ? 'searching' : 'unavailable', rows: [], next: null, coverage });
                    timer = setTimeout(() => void run(), 1500);
                } else {
                    current.current = null;
                    publish({ status: 'failed', rows: [], next: null, error: searchGuidance(snapshot.errorCode) || 'Search again.', coverage });
                }
            } catch {
                if (!stopped && !controller.signal.aborted) publish({ status: 'failed', rows: [], next: null, error: 'Search unavailable. Try again.', coverage });
            }
        }
        // Wait until typing settles before creating a ranked search job.
        timer = setTimeout(() => void run(), 500);
        const lost = () => { stopped = true; clearTimeout(timer); controller.abort(); current.current = null; setState(null); };
        window.addEventListener('staff-session-invalidated', lost);
        return () => { stopped = true; clearTimeout(timer); controller.abort(); window.removeEventListener('staff-session-invalidated', lost); };
    }, [query, enabled, after, revision]);

    useEffect(() => () => {
        if (current.current) void searchAction({ action: 'cancel', queryId: current.current.id }).catch(() => {});
    }, []);

    return {
        state: state?.query === query && state.after === after ? state : null,
        page: cursors.length,
        previous: () => setPaging({ query, cursors: cursors.slice(0, -1) }),
        next: () => { if (state?.next) setPaging({ query, cursors: [...cursors, state.next] }); },
        retry: () => { if (current.current) void searchAction({ action: 'cancel', queryId: current.current.id }).catch(() => {}); current.current = null; setRevision(value => value + 1); },
    };
}
