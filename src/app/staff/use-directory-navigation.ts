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
        const cancelScheduled = () => {
            if (timer.current) clearTimeout(timer.current);
            timer.current = null;
            setScheduled(false);
        };
        const onPopState = () => {
            cancelScheduled();
            setFilters(parse(new URLSearchParams(window.location.search)));
        };
        const onLinkNavigation = (event: MouseEvent) => {
            if (!timer.current || event.defaultPrevented || event.button !== 0
                || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            if (!(event.target instanceof Element)) return;
            const anchor = event.target.closest('a[href]');
            if (!(anchor instanceof HTMLAnchorElement)
                || (anchor.target && anchor.target !== '_self')
                || anchor.hasAttribute('download')
                || anchor.hasAttribute('data-preview-trigger')) return;
            const destination = new URL(anchor.href, window.location.href);
            if (destination.origin !== window.location.origin || destination.pathname !== path) return;
            // In-page anchor jumps do not replace directory filters.
            if (destination.hash && destination.search === window.location.search) return;
            cancelScheduled();
        };
        window.addEventListener('popstate', onPopState);
        // Capture before Next's Link handler prevents the native default action.
        document.addEventListener('click', onLinkNavigation, true);
        return () => {
            if (timer.current) clearTimeout(timer.current);
            window.removeEventListener('popstate', onPopState);
            document.removeEventListener('click', onLinkNavigation, true);
        };
    }, [parse, path]);

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
            timer.current = null;
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
