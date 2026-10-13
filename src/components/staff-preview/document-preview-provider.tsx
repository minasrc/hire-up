'use client';

import { staffWorkspaceFetch } from '@/lib/staff-workspace-fetch';

import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useSession } from 'next-auth/react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { createDocumentPreviewCache } from '@/lib/staff-document-preview-cache';
import { staffAuthRecovery } from '@/lib/staff-auth-recovery';
import { useStaffAuthRecovery } from '@/app/staff/auth-recovery';

export type PdfPreviewValue = { kind: 'pdf'; pdf: PDFDocumentProxy;
    getView: () => { page: number; zoom: number };
    rememberView: (patch: { page?: number; zoom?: number }) => void };
type DocumentValue = PdfPreviewValue
    | { kind: 'text'; text: string };
type PreviewResource = { version: string | null; sizeBytes: number; value: DocumentValue; dispose?: () => Promise<void> };
const DocumentContext = createContext<ReturnType<typeof createDocumentPreviewCache> | null>(null);

export function DocumentPreviewProvider({ scope, children }: { scope: string; children: ReactNode }) {
    const { data: session, status } = useSession();
    const identity = session?.user?.email;
    const sessionCache = useMemo(() => ({ scope, identity, status, cache: createDocumentPreviewCache() }), [scope, identity, status]);
    const cache = sessionCache.cache;
    useEffect(() => {
        const clear = () => cache.clear();
        const revalidate = () => cache.revalidate();
        window.addEventListener('focus', revalidate);
        document.addEventListener('visibilitychange', revalidate);
        window.addEventListener('staff-workspace-updated', clear);
        window.addEventListener('staff-session-invalidated', clear);
        window.addEventListener('staff-auth-required', clear);
        window.addEventListener('staff-auth-retry', revalidate);
        return () => {
            window.removeEventListener('focus', revalidate);
            document.removeEventListener('visibilitychange', revalidate);
            window.removeEventListener('staff-workspace-updated', clear);
            window.removeEventListener('staff-session-invalidated', clear);
            window.removeEventListener('staff-auth-required', clear);
            window.removeEventListener('staff-auth-retry', revalidate);
            cache.clear();
        };
    }, [cache]);
    return <DocumentContext.Provider value={cache}>{children}</DocumentContext.Provider>;
}

async function loadDocument(documentId: string, view: 'bytes' | 'text', previous: PreviewResource | undefined, signal: AbortSignal): Promise<PreviewResource> {
    const authEpoch = staffAuthRecovery.requestEpoch();
    const response = await staffWorkspaceFetch(`/api/staff/documents/${documentId}?view=${view}`, {
        signal, cache: 'no-store',
        headers: previous?.version ? { 'if-none-match': previous.version } : {},
    });
    if (signal.aborted) throw new DOMException('Preview invalidated', 'AbortError');
    if ([401, 428].includes(response.status)) {
        const reported = staffAuthRecovery.require(response.status, authEpoch);
        throw Object.assign(new DOMException('Preview access must be checked again', 'AbortError'), {
            retryAuth: !reported && !staffAuthRecovery.getSnapshot().required,
        });
    }
    if (response.status === 304 && previous) { staffAuthRecovery.accepted(authEpoch); return previous; }
    if (!response.ok) {
        if ([403, 404].includes(response.status)) staffAuthRecovery.accepted(authEpoch);
        else staffAuthRecovery.retryFailed(authEpoch);
        throw Object.assign(new Error(
            response.status === 403 ? 'You do not have permission to view this document.'
                : 'This document could not be previewed.',
        ), { status: response.status });
    }
    staffAuthRecovery.accepted(authEpoch);
    const version = response.headers.get('etag');
    if (view === 'text') {
        const payload = await response.json();
        if (signal.aborted) throw new DOMException('Preview invalidated', 'AbortError');
        const text = typeof payload.text === 'string' && payload.text || 'No readable text was found in this document.';
        return { version, sizeBytes: text.length * 2, value: { kind: 'text', text } };
    }
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > 4 * 1024 * 1024) throw new Error('This PDF is too large to preview.');
    const sizeBytes = data.byteLength;
    const pdfjs = await import('pdfjs-dist');
    if (signal.aborted) throw new DOMException('Preview invalidated', 'AbortError');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
    const task = pdfjs.getDocument({ data });
    const dispose = () => task.destroy();
    const abort = () => { void dispose().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
        const pdf = await task.promise;
        let page = 1, zoom = 1;
        return { version, sizeBytes, value: { kind: 'pdf', pdf,
            getView: () => ({ page, zoom }),
            rememberView: (patch) => { page = patch.page ?? page; zoom = patch.zoom ?? zoom; },
        }, dispose };
    } catch (error) {
        await dispose().catch(() => {});
        throw error;
    } finally { signal.removeEventListener('abort', abort); }
}

export function useDocumentPreview(documentId: string | null, view: 'bytes' | 'text') {
    const cache = useContext(DocumentContext);
    if (!cache) throw new Error('Document previews require an authenticated workspace provider.');
    const { status } = useSession();
    const recovery = useStaffAuthRecovery();
    const blocked = recovery.required && recovery.phase !== 'retrying';
    const epoch = useSyncExternalStore(cache.subscribe, cache.getEpoch, cache.getEpoch);
    const key = `${documentId}:${view}`;
    // A -> another view -> A is a new activation, even when old state still
    // contains A. Never expose it before this activation's access check finishes.
    const activation = useMemo(() => ({ cache, epoch, key, status }), [cache, epoch, key, status]);
    const [loaded, setLoaded] = useState<{ activation: typeof activation; value: DocumentValue } | null>(null);
    const [failure, setFailure] = useState<{ activation: typeof activation; error: string } | null>(null);
    useEffect(() => {
        if (!documentId || blocked || status !== 'authenticated' || document.visibilityState !== 'visible') return;
        let current = true;
        const authEpoch = staffAuthRecovery.requestEpoch();
        let release: (() => void) | undefined;
        cache.acquire(key, (previous, signal) => loadDocument(documentId, view, previous, signal)).then((lease) => {
            if (!current) { lease.release(); return; }
            release = lease.release;
            setLoaded({ activation, value: lease.value });
        }).catch((reason) => {
            if (current && reason.retryAuth) { cache.revalidate(); return; }
            if (current && reason.name !== 'AbortError') {
                staffAuthRecovery.retryFailed(authEpoch);
                setFailure({ activation, error: reason.message });
            }
        });
        return () => { current = false; release?.(); };
    }, [activation, cache, key, documentId, view, status, blocked]);
    return {
        value: !recovery.required && status === 'authenticated' && loaded?.activation === activation ? loaded.value : null,
        error: failure?.activation === activation ? failure.error : '',
        checking: cache.has(key),
        authRequired: recovery.required,
    };
}
