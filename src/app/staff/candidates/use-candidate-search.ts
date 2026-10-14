'use client';

import { useEffect, useRef, useState } from 'react';
import { searchAction, searchEndpoint, searchRequest } from './search/search-api';
import { safeSearchSnapshot, searchGuidance, searchInvalidated } from './search/search-model';
import type { CandidateRow } from './candidates-browser';

import type { SearchCoverage } from './use-search-indexing';

type SearchState = { query: string; after: string; status: 'searching' | 'completed' | 'unavailable' | 'failed'; rows: CandidateRow[]; next: string | null; error?: string; coverage?: SearchCoverage | null };

export function useCandidateSearch(query: string, enabled: boolean, indexRevision = 0) {
    const [state, setState] = useState<SearchState | null>(null);
    const [paging, setPaging] = useState<{ query: string; cursors: string[] }>({ query: '', cursors: [''] });
    const [revision, setRevision] = useState(0);
    const current = useRef<{ query: string; id: string; includeCv: boolean } | null>(null);
    const lastResult = useRef<SearchState | null>(null);
    const indexedRevision = useRef(indexRevision);
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
        if (indexedRevision.current !== indexRevision) {
            indexedRevision.current = indexRevision;
            if (current.current) void searchAction({ action: 'cancel', queryId: current.current.id }).catch(() => {});
            current.current = null;
        }
        const previousResult = lastResult.current;
        const refreshing = previousResult?.query === query && previousResult.after === after && previousResult.status === 'completed';
        const deadline = setTimeout(() => {
            stopped = true; clearTimeout(timer); clearTimeout(deadline); controller.abort();
            if (current.current) void searchAction({ action: 'cancel', queryId: current.current.id }).catch(() => {});
            current.current = null;
            setState(existing => existing?.query === query && existing.after === after && existing.rows.length
                ? { ...existing, status: 'completed', error: 'Search refresh delayed. Try again.' }
                : { query, after, status: 'failed', rows: [], next: null, error: 'Search is taking too long. Try again.' });
        }, 20000);
        const publish = (next: Omit<SearchState, 'query' | 'after'>) => {
            if (!stopped) { lastResult.current = { query, after, ...next }; setState(lastResult.current); }
        };
        let coverage: SearchCoverage | null = previousResult?.query === query ? previousResult.coverage ?? null : null;
        const fail = (status: 'failed' | 'unavailable', error: string) => {
            if (refreshing && previousResult.rows.length) publish({ ...previousResult, status: 'completed', error, coverage });
            else publish({ status, error, rows: [], next: null, coverage });
        };
        async function run() {
            if (!refreshing) publish({ status: 'searching', rows: [], next: null });
            try {
                let active = current.current;
                if (!active || active.query !== query) {
                    const availability = await searchRequest(`${searchEndpoint}?scope=approved&includeCv=false`, { signal: controller.signal });
                    if (stopped) return;
                    coverage = availability.coverage ?? null;
                    if (!availability.workerAvailable) { clearTimeout(deadline); fail('unavailable', 'Search temporarily unavailable'); return; }
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
                    clearTimeout(deadline);
                    publish({ status: 'completed', rows: (snapshot.results ?? []).filter((row: { directoryRow?: CandidateRow }) => row.directoryRow).map((row: { directoryRow: CandidateRow }) => row.directoryRow), next: snapshot.nextAfter ?? null, coverage });
                } else if (snapshot.status === 'queued' || snapshot.status === 'running') {
                    if (!refreshing) publish({ status: snapshot.workerAvailable ? 'searching' : 'unavailable', rows: [], next: null, coverage });
                    timer = setTimeout(() => void run(), 1500);
                } else {
                    clearTimeout(deadline);
                    current.current = null;
                    if (searchInvalidated(snapshot.errorCode)) publish({ status: 'failed', error: searchGuidance(snapshot.errorCode), rows: [], next: null, coverage });
                    else fail('failed', searchGuidance(snapshot.errorCode) || 'Search again.');
                }
            } catch {
                clearTimeout(deadline);
                if (!stopped && !controller.signal.aborted) fail('failed', 'Search unavailable. Try again.');
            }
        }
        // Wait until typing settles before creating a ranked search job.
        timer = setTimeout(() => void run(), 500);
        const lost = () => { stopped = true; clearTimeout(timer); clearTimeout(deadline); controller.abort(); current.current = null; lastResult.current = null; setState(null); };
        window.addEventListener('staff-session-invalidated', lost);
        return () => { stopped = true; clearTimeout(timer); clearTimeout(deadline); controller.abort(); window.removeEventListener('staff-session-invalidated', lost); };
    }, [query, enabled, after, revision, indexRevision]);

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
