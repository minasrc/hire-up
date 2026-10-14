'use client';

import { useMemo, type ReactNode } from 'react';

import {
    ClientJobContractError,
    normalizeJobDocument,
} from '@/lib/client-job-contracts.js';
import { editorJobDocument } from '@/lib/editor-job-document.js';
import { cn } from '@/lib/utils';

import type { JobDocument, JobDocumentNode } from './types';

function renderMarks(text: string, marks: JobDocumentNode['marks'], keyBase: string): ReactNode {
    let node: ReactNode = text;
    (marks ?? []).forEach((mark, index) => {
        const key = `${keyBase}-${index}`;
        if (mark.type === 'bold') {
            node = <strong key={key}>{node}</strong>;
        } else if (mark.type === 'italic') {
            node = <em key={key}>{node}</em>;
        } else if (mark.type === 'underline') {
            node = <u key={key}>{node}</u>;
        } else if (mark.type === 'strike') {
            node = <s key={key}>{node}</s>;
        } else if (mark.type === 'link' && typeof mark.attrs?.href === 'string') {
            node = (
                <a
                    key={key}
                    href={mark.attrs.href}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-sm text-accent-foreground underline outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                    {node}
                </a>
            );
        }
    });
    return node;
}

function renderInline(node: JobDocumentNode, key: string): ReactNode {
    if (node.type === 'text') {
        return <span key={key}>{renderMarks(node.text ?? '', node.marks, key)}</span>;
    }
    if (node.type === 'hardBreak') {
        return <br key={key} />;
    }
    return null;
}

function renderInlineGroup(children: JobDocumentNode[] | undefined, keyBase: string): ReactNode {
    return (children ?? []).map((child, index) => renderInline(child, `${keyBase}-${index}`));
}

function renderBlock(node: JobDocumentNode, key: string): ReactNode {
    switch (node.type) {
        case 'paragraph':
            return (
                <p key={key} className="text-sm leading-6 text-muted-foreground">
                    {renderInlineGroup(node.content, key)}
                </p>
            );
        case 'heading': {
            const level = node.attrs?.level === 3 ? 3 : 2;
            const className =
                level === 2
                    ? 'text-xs font-semibold tracking-wide text-foreground uppercase'
                    : 'text-sm font-semibold text-foreground';
            return level === 2 ? (
                <h2 key={key} className={className}>
                    {renderInlineGroup(node.content, key)}
                </h2>
            ) : (
                <h3 key={key} className={className}>
                    {renderInlineGroup(node.content, key)}
                </h3>
            );
        }
        case 'bulletList':
            return (
                <ul key={key} className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
                    {(node.content ?? []).map((child, index) =>
                        renderBlock(child, `${key}-${index}`),
                    )}
                </ul>
            );
        case 'orderedList': {
            const start = typeof node.attrs?.start === 'number' ? node.attrs.start : undefined;
            return (
                <ol
                    key={key}
                    start={start}
                    className="flex list-decimal flex-col gap-1 pl-5 text-sm text-muted-foreground"
                >
                    {(node.content ?? []).map((child, index) =>
                        renderBlock(child, `${key}-${index}`),
                    )}
                </ol>
            );
        }
        case 'listItem':
            return (
                <li key={key} className="leading-6">
                    {(node.content ?? []).map((child, index) => {
                        if (child.type === 'paragraph') {
                            return (
                                <span key={`${key}-${index}`}>
                                    {renderInlineGroup(child.content, `${key}-${index}`)}
                                </span>
                            );
                        }
                        return renderBlock(child, `${key}-${index}`);
                    })}
                </li>
            );
        case 'blockquote':
            return (
                <blockquote
                    key={key}
                    className="flex flex-col gap-2 border-l-2 border-border pl-4 text-sm italic text-muted-foreground"
                >
                    {(node.content ?? []).map((child, index) =>
                        renderBlock(child, `${key}-${index}`),
                    )}
                </blockquote>
            );
        default:
            return null;
    }
}

export function canonicalJobDocument(value: unknown): JobDocument | null {
    try {
        return normalizeJobDocument(editorJobDocument(value)) as JobDocument;
    } catch (error) {
        if (error instanceof ClientJobContractError) return null;
        throw error;
    }
}

export function JobDocumentView({
    document,
    className,
}: {
    document: unknown;
    className?: string;
}) {
    const canonical = useMemo(() => canonicalJobDocument(document), [document]);
    if (!canonical) {
        return <p role="alert" className="text-sm text-destructive">This description couldn’t be previewed. Your text is still in the editor.</p>;
    }
    if (canonical.content.length === 0 || canonical.content.every((node) => node.type === 'paragraph' && !node.content?.length)) {
        return <p className="text-sm text-muted-foreground">No description provided yet.</p>;
    }
    return (
        <div className={cn('flex flex-col gap-3', className)}>
            {canonical.content.map((node, index) => renderBlock(node, `b${index}`))}
        </div>
    );
}
