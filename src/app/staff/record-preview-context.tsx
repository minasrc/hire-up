'use client';

import {
    createContext,
    useContext,
    type AnchorHTMLAttributes,
} from 'react';
import Link from 'next/link';

export type RecordPreviewKind = 'candidate' | 'job' | 'client';

const RECORD_HREFS: Record<RecordPreviewKind, string> = {
    candidate: '/staff/candidates',
    job: '/staff/jobs',
    client: '/staff/clients',
};

export function recordHref(kind: RecordPreviewKind, id: string): string {
    return `${RECORD_HREFS[kind]}/${id}`;
}

export interface RecordPreviewActions {
    open: (kind: RecordPreviewKind, id: string, trigger: HTMLElement) => void;
}

export const RecordPreviewContext = createContext<RecordPreviewActions | null>(null);

export function useRecordPreview(): RecordPreviewActions | null {
    return useContext(RecordPreviewContext);
}

export function RecordPreviewLink({
    kind,
    id,
    children,
    onClick,
    ...props
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
    kind: RecordPreviewKind;
    id: string;
}) {
    const preview = useRecordPreview();
    return (
        <Link
            href={recordHref(kind, id)}
            data-preview-trigger={`${kind}:${id}`}
            onClick={(event) => {
                if (
                    preview
                    && event.button === 0
                    && !event.metaKey
                    && !event.ctrlKey
                    && !event.shiftKey
                    && !event.altKey
                ) {
                    event.preventDefault();
                    preview.open(kind, id, event.currentTarget);
                    onClick?.(event);
                    return;
                }
                onClick?.(event);
            }}
            {...props}
        >
            {children}
        </Link>
    );
}
