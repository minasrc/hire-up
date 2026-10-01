'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

// Transition same-route updates without replacing the existing table with the
// route loading skeleton. Search is debounced; newer input supersedes old reads.
export function useDirectoryNavigation<T>(
    path: string,
    parse: (params: { get(name: string): string | null }) => T,
    serialize: (filters: T) => string,
) {
    const router = useRouter();
    const params = useSearchParams();
    const [filters, setFilters] = useState(() => parse(params));
    const [pending, startTransition] = useTransition();
    const [scheduled, setScheduled] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const committed = serialize(parse(params));

    useEffect(() => {
        if (!pending && !scheduled) {
            setFilters(parse(new URLSearchParams(committed)));
        }
    }, [committed, parse, pending, scheduled]);

    useEffect(() => {
        const onPopState = () => {
            if (timer.current) clearTimeout(timer.current);
            setScheduled(false);
            setFilters(parse(new URLSearchParams(window.location.search)));
        };
        window.addEventListener('popstate', onPopState);
        return () => {
            if (timer.current) clearTimeout(timer.current);
            window.removeEventListener('popstate', onPopState);
        };
    }, [parse]);

    const update = (next: T, debounce = false, localOnly = false) => {
        setFilters(next);
        if (timer.current) clearTimeout(timer.current);
        const query = serialize(next);
        if (localOnly && !pending && !scheduled) {
            window.history.replaceState(null, '', `${path}${query ? `?${query}` : ''}`);
            return;
        }
        setScheduled(debounce);
        const navigate = () => {
            setScheduled(false);
            startTransition(() => {
                router.replace(`${path}${query ? `?${query}` : ''}`, { scroll: false });
            });
        };
        if (debounce) timer.current = setTimeout(navigate, 300);
        else navigate();
    };
    return { filters, update, pending: pending || scheduled };
}
