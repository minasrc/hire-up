'use client';

import { StaffDocumentLink } from '@/components/staff-ui/staff-document-link';

import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, ZoomIn, ZoomOut } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';

import { Button } from '@/components/staff-ui/button';
import { useDocumentPreview, type PdfPreviewValue } from './document-preview-provider';
import { StaffAuthRecoveryPrompt } from '@/app/staff/auth-recovery';

function PdfPage({
    pdf, number, width, zoom,
}: {
    pdf: PDFDocumentProxy;
    number: number;
    width: number;
    zoom: number;
}) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [error, setError] = useState('');
    const [accessibleText, setAccessibleText] = useState('');

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || width === 0) return;
        let cancelled = false;
        let renderTask: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | null = null;
        pdf.getPage(number).then(async (page) => {
            if (cancelled) return;
            const base = page.getViewport({ scale: 1 });
            const viewport = page.getViewport({ scale: width * zoom / base.width });
            const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
            canvas.width = Math.ceil(viewport.width * pixelRatio);
            canvas.height = Math.ceil(viewport.height * pixelRatio);
            canvas.style.width = `${Math.ceil(viewport.width)}px`;
            canvas.style.height = `${Math.ceil(viewport.height)}px`;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Canvas is unavailable.');
            renderTask = page.render({
                canvas,
                canvasContext: context,
                viewport,
                transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
            });
            await renderTask.promise;
            const content = await page.getTextContent();
            if (!cancelled) setAccessibleText(content.items
                .filter((item): item is typeof item & { str: string } => 'str' in item)
                .map((item) => item.str).join(' ').slice(0, 20_000));
        }).catch((reason) => {
            if (!cancelled && reason?.name !== 'RenderingCancelledException') {
                setError('This PDF page could not be displayed.');
            }
        });
        return () => {
            cancelled = true;
            renderTask?.cancel();
        };
    }, [pdf, number, width, zoom]);

    return <div className="mx-auto w-fit max-w-none bg-white shadow-sm">
        {error ? <p role="alert" className="p-4 text-sm text-destructive">{error}</p> : null}
        <canvas ref={canvasRef} role="img" aria-label={`Page ${number} of ${pdf.numPages}`} />
        {accessibleText ? <p className="sr-only">{accessibleText}</p> : null}
    </div>;
}

export function PdfDocumentPreview({
    documentId, filename,
}: {
    documentId: string;
    filename: string;
}) {
    const { value, error, checking, authRequired } = useDocumentPreview(documentId, 'bytes');
    if (authRequired) return <div className="p-4"><StaffAuthRecoveryPrompt /></div>;
    if (error) return <p role="alert" className="p-4 text-sm text-destructive">{error}</p>;
    if (value?.kind !== 'pdf') return <p role="status" className="p-4 text-sm text-muted-foreground">
        {checking ? 'Checking document access…' : 'Loading PDF…'}</p>;
    return <LoadedPdfPreview documentId={documentId} filename={filename} value={value} />;
}

function LoadedPdfPreview({ documentId, filename, value }: {
    documentId: string; filename: string; value: PdfPreviewValue;
}) {
    const containerRef = useRef<HTMLDivElement>(null);
    const pdf = value.pdf;
    const [width, setWidth] = useState(0);
    const [zoom, setZoom] = useState(() => value.getView().zoom);
    const [pageNumber, setPageNumber] = useState(() => value.getView().page);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const observer = new ResizeObserver(() => setWidth(Math.max(0, container.clientWidth - 32)));
        observer.observe(container);
        return () => observer.disconnect();
    }, []);

    return <div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
            <span className="text-xs text-muted-foreground">
                {pdf ? `${pdf.numPages} ${pdf.numPages === 1 ? 'page' : 'pages'}` : 'PDF'}
            </span>
            <div className="flex items-center gap-1">
                <Button size="icon" variant="ghost" title="Previous page"
                    aria-label="Previous page" disabled={!pdf || pageNumber <= 1}
                    onClick={() => {
                        value.rememberView({ page: pageNumber - 1 });
                        setPageNumber(pageNumber - 1);
                        containerRef.current?.scrollTo({ top: 0 });
                    }}>
                    <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="min-w-10 text-center text-xs tabular-nums">
                    {pdf ? `${pageNumber}/${pdf.numPages}` : '—'}
                </span>
                <Button size="icon" variant="ghost" title="Next page"
                    aria-label="Next page" disabled={!pdf || pageNumber >= pdf.numPages}
                    onClick={() => {
                        value.rememberView({ page: pageNumber + 1 });
                        setPageNumber(pageNumber + 1);
                        containerRef.current?.scrollTo({ top: 0 });
                    }}>
                    <ChevronRight className="h-4 w-4" />
                </Button>
                <Button size="icon" variant="ghost" title="Zoom out"
                    aria-label="Zoom out" disabled={zoom <= 0.75}
                    onClick={() => { const next = Math.max(0.75, zoom - 0.25); value.rememberView({ zoom: next }); setZoom(next); }}>
                    <ZoomOut className="h-4 w-4" />
                </Button>
                <span className="w-11 text-center text-xs tabular-nums">{Math.round(zoom * 100)}%</span>
                <Button size="icon" variant="ghost" title="Zoom in"
                    aria-label="Zoom in" disabled={zoom >= 2}
                    onClick={() => { const next = Math.min(2, zoom + 0.25); value.rememberView({ zoom: next }); setZoom(next); }}>
                    <ZoomIn className="h-4 w-4" />
                </Button>
                <Button size="icon" variant="ghost" asChild>
                    <StaffDocumentLink documentId={documentId} view="inline"
                        target="_blank" rel="noreferrer"
                        title={`Open original ${filename}`} aria-label={`Open original ${filename}`}>
                        <ExternalLink className="h-4 w-4" />
                    </StaffDocumentLink>
                </Button>
            </div>
        </div>
        <div ref={containerRef} className="max-h-[min(70vh,720px)] overflow-auto bg-muted p-4">
            {width ? <PdfPage key={pageNumber} pdf={pdf}
                    number={pageNumber} width={width} zoom={zoom} />
                    : <p role="status" className="text-sm text-muted-foreground">
                    Loading PDF…</p>}
        </div>
    </div>;
}
