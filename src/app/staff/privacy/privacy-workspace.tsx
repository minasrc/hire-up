'use client';

import { useState } from 'react';
import { Eye, Lock, ShieldAlert } from 'lucide-react';

import { Button } from '@/components/staff-ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/staff-ui/card';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/staff-ui/dialog';
import { Separator } from '@/components/staff-ui/separator';
import { EmptyState, FieldLabel, StatusBadge } from '@/components/staff-preview/shared';
import { cn } from '@/lib/utils';
import type { PrivacyCaseList, PrivacyCaseRow } from '@/lib/recruitment-types';

const KIND_LABELS: Record<string, string> = {
    access: 'Access request',
    correction: 'Correction request',
    restriction: 'Processing restriction',
    erasure: 'Erasure request',
    objection: 'Objection',
    portability: 'Portability request',
    withdrawal: 'Consent withdrawal',
};

const STATUS_LABELS: Record<string, string> = {
    received: 'Received',
    verified: 'Verified',
    in_progress: 'In progress',
    fulfilled: 'Fulfilled',
    rejected: 'Rejected',
};

const STATUS_TONES: Record<string, 'accent' | 'warning' | 'success' | 'secondary'> = {
    received: 'accent',
    verified: 'accent',
    in_progress: 'warning',
    fulfilled: 'success',
    rejected: 'secondary',
};

const ACTION_LABELS: Record<string, string> = {
    'privacy.request.created': 'Request received',
    'privacy.request.verified': 'Identity verified',
    'privacy.subject.reviewed': 'Subject records reviewed',
    'privacy.candidate.corrected': 'Candidate record corrected',
    'privacy.subject.restricted': 'Staff access restricted',
};

const RESULT_LIMIT = 500;

function formatDate(iso: string | null | undefined): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
    });
}

function kindLabel(kind: string): string {
    return KIND_LABELS[kind]
        ?? kind.replace(/_/g, ' ').replace(/^\w/, (first) => first.toUpperCase());
}

function statusLabel(status: string): string {
    return STATUS_LABELS[status]
        ?? status.replace(/_/g, ' ').replace(/^\w/, (first) => first.toUpperCase());
}

function actionLabel(action: string): string {
    const known = ACTION_LABELS[action];
    if (known) return known;
    const tail = action.split('.').pop() ?? action;
    return tail.replace(/_/g, ' ').replace(/^\w/, (first) => first.toUpperCase());
}

function CaseDetail({ privacyCase }: { privacyCase: PrivacyCaseRow }) {
    const [recordsOpen, setRecordsOpen] = useState(false);
    return (
        <Card>
            <CardHeader>
                <div className="flex flex-wrap items-center gap-2">
                    <CardTitle className="font-mono text-sm">{privacyCase.id}</CardTitle>
                    <StatusBadge tone="accent">{kindLabel(privacyCase.kind)}</StatusBadge>
                    <StatusBadge tone={STATUS_TONES[privacyCase.status] ?? 'secondary'}>
                        {statusLabel(privacyCase.status)}
                    </StatusBadge>
                </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
                <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <FieldLabel label="Received">
                        {formatDate(privacyCase.receivedAt)}
                    </FieldLabel>
                    <FieldLabel label="Due">
                        {formatDate(privacyCase.dueAt)}
                    </FieldLabel>
                    <FieldLabel label="Verified">
                        {formatDate(privacyCase.verifiedAt)}
                    </FieldLabel>
                    <FieldLabel label="Resolved">
                        {formatDate(privacyCase.resolvedAt)}
                    </FieldLabel>
                </dl>

                <Separator />

                <div className="flex flex-col gap-2">
                    <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                        Timeline
                    </p>
                    {privacyCase.events.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            No recorded events yet.
                        </p>
                    ) : (
                        <ol className="flex flex-col gap-3">
                            {privacyCase.events.map((event, index) => (
                                <li key={index} className="flex flex-col gap-0.5">
                                    <span className="text-sm font-medium text-foreground">
                                        {actionLabel(event.action)}
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                        {formatDate(event.occurredAt)}
                                        {event.evidenceCode
                                            ? ` · Evidence ${event.evidenceCode}`
                                            : ''}
                                    </span>
                                </li>
                            ))}
                        </ol>
                    )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" onClick={() => setRecordsOpen(true)}>
                        <Eye aria-hidden="true" />
                        View reviewed records
                    </Button>
                    <p className="text-xs text-muted-foreground">
                        Record identifiers only — restricted details stay hidden.
                    </p>
                </div>
            </CardContent>

            <Dialog open={recordsOpen} onOpenChange={setRecordsOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Reviewed records</DialogTitle>
                        <DialogDescription>
                            Minimal identifiers reviewed under this request. Restricted
                            record contents are not shown.
                        </DialogDescription>
                    </DialogHeader>
                    {privacyCase.subjects.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            No records have been reviewed for this request yet.
                        </p>
                    ) : (
                        <ul className="flex flex-col gap-2">
                            {privacyCase.subjects.map((subject) => (
                                <li
                                    key={subject.subjectId}
                                    className="flex flex-col gap-0.5 rounded-lg border border-border px-3 py-2"
                                >
                                    <span className="font-mono text-xs text-foreground">
                                        {subject.candidateId
                                            ?? subject.legacyRecordId
                                            ?? subject.subjectId}
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                        Reviewed {formatDate(subject.reviewedAt)}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </DialogContent>
            </Dialog>
        </Card>
    );
}

export function PrivacyWorkspace({ result }: { result: PrivacyCaseList }) {
    const cases = result.cases ?? [];
    const [selectedId, setSelectedId] = useState(cases[0]?.id ?? '');
    const selected =
        cases.find((privacyCase) => privacyCase.id === selectedId) ?? cases[0];

    return (
        <div className="flex flex-col gap-6">
            {cases.length === 0 ? (
                <Card>
                    <CardContent>
                        <EmptyState
                            icon={ShieldAlert}
                            title="No privacy cases"
                            description="When a privacy request is recorded for a candidate it will appear here."
                        />
                    </CardContent>
                </Card>
            ) : (
                <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
                    <div className="flex flex-col gap-3" aria-label="Data requests">
                        {cases.map((privacyCase) => {
                            const isSelected = selected?.id === privacyCase.id;
                            return (
                                <button
                                    key={privacyCase.id}
                                    type="button"
                                    aria-pressed={isSelected}
                                    onClick={() => setSelectedId(privacyCase.id)}
                                    className={cn(
                                        'flex flex-col gap-2 rounded-lg border p-4 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                                        isSelected
                                            ? 'border-accent-foreground/40 bg-accent/50'
                                            : 'border-border bg-card hover:bg-hover',
                                    )}
                                >
                                    <span className="flex items-center justify-between gap-2">
                                        <span className="text-sm font-semibold text-foreground">
                                            {kindLabel(privacyCase.kind)}
                                        </span>
                                        <StatusBadge
                                            tone={
                                                STATUS_TONES[privacyCase.status]
                                                ?? 'secondary'
                                            }
                                        >
                                            {statusLabel(privacyCase.status)}
                                        </StatusBadge>
                                    </span>
                                    <span className="font-mono text-xs text-muted-foreground">
                                        {privacyCase.id}
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                        Received {formatDate(privacyCase.receivedAt)}
                                        {privacyCase.dueAt
                                            ? ` · Due ${formatDate(privacyCase.dueAt)}`
                                            : ''}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                    {selected ? <CaseDetail privacyCase={selected} /> : null}
                </div>
            )}
            {cases.length >= RESULT_LIMIT ? (
                <p className="text-xs text-muted-foreground">
                    This list shows up to {RESULT_LIMIT} requests at a time. Narrow the
                    records handled through the review workflow for older requests.
                </p>
            ) : null}
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                This screen is for reviewing requests. Changes are recorded by the
                privacy workflow.
            </p>
        </div>
    );
}
