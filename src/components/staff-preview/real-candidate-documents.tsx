'use client';

import { StaffDocumentLink } from '@/components/staff-ui/staff-document-link';

import { useState } from 'react';
import { Download, FileText } from 'lucide-react';

import { Button } from '@/components/staff-ui/button';
import { PdfDocumentPreview } from './pdf-document-preview';
import { useDocumentPreview } from './document-preview-provider';
import { StaffAuthRecoveryPrompt } from '@/app/staff/auth-recovery';
import { StaffDate } from '@/app/staff/staff-date';

export interface CandidateDocumentRecord {
    documentId: string;
    filename: string;
    purpose?: string;
    lifecycle: string;
    scanState: string;
    sizeBytes: number;
    receivedAt: string;
}

export function RealCandidateDocuments({
    documents,
    canView,
}: {
    documents: CandidateDocumentRecord[];
    canView: boolean;
}) {
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const canOpen = (document: CandidateDocumentRecord) => canView
        && document.lifecycle === 'active'
        && document.scanState !== 'infected';
    const canPreview = (document: CandidateDocumentRecord) => canOpen(document)
        && /\.(pdf|docx)$/i.test(document.filename);
    const selected = documents.find((document) => document.documentId === selectedId && canOpen(document))
        ?? documents.find((document) => document.purpose === 'cv' && canPreview(document))
        ?? documents.find(canPreview);
    const isPdf = selected?.filename.toLowerCase().endsWith('.pdf');
    const isDocx = selected?.filename.toLowerCase().endsWith('.docx');
    const selectedDocxId = isDocx ? selected.documentId : null;
    const { value, error, checking, authRequired } = useDocumentPreview(selectedDocxId, 'text');
    const text = value?.kind === 'text' ? value.text : null;

    if (documents.length === 0) {
        return <p className="text-sm text-muted-foreground">No documents on file.</p>;
    }

    return <div className="space-y-4">
        <div className="divide-y divide-border rounded-md border border-border">
            {documents.map((document) => <div key={document.documentId}
                className={`flex min-w-0 items-center gap-3 px-3 py-2.5 ${
                    selected?.documentId === document.documentId ? 'bg-accent/50' : ''}`}>
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                    {canOpen(document) ? <button type="button"
                        onClick={() => {
                            setSelectedId(document.documentId);
                        }}
                        aria-pressed={selected?.documentId === document.documentId}
                        className="max-w-full cursor-pointer truncate text-left text-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
                        {document.filename}
                    </button> : <span className="block truncate text-sm font-medium">
                        {document.filename}
                    </span>}
                    <p className="text-xs text-muted-foreground">
                        <StaffDate value={document.receivedAt} /> · {Math.max(1, Math.round(document.sizeBytes / 1024))} KB
                        {document.scanState !== 'clean' ? ` · Scan: ${document.scanState}` : ''}
                    </p>
                </div>
                {canOpen(document) ? <Button size="icon" variant="ghost" asChild>
                    <StaffDocumentLink documentId={document.documentId}
                        aria-label={`Download ${document.filename}`} title={`Download ${document.filename}`}>
                        <Download className="h-4 w-4" />
                    </StaffDocumentLink>
                </Button> : null}
            </div>)}
        </div>
        {selected ? <section aria-label={`Preview of ${selected.filename}`}
            className="min-w-0 overflow-hidden rounded-md border border-border">
            <div className="border-b border-border px-4 py-2 text-sm font-medium">
                {selected.filename}
            </div>
            {isPdf ? <PdfDocumentPreview key={selected.documentId}
                documentId={selected.documentId} filename={selected.filename} />
                : isDocx ? <div className="max-h-[min(70vh,720px)] overflow-auto px-4 py-5">
                    {authRequired ? <StaffAuthRecoveryPrompt />
                        : error ? <p role="alert" className="text-sm text-destructive">{error}</p>
                        : text === null ? <p role="status" className="text-sm text-muted-foreground">
                            {checking ? 'Checking document access…' : 'Loading document…'}</p>
                            : <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6">
                                {text}
                            </pre>}
                </div> : <p className="px-4 py-5 text-sm text-muted-foreground">
                    Preview is available for PDF and DOCX files.
                </p>}
        </section> : null}
    </div>;
}
