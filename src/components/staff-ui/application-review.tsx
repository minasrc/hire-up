'use client';

import { createContext, useContext, useState, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Undo2 } from 'lucide-react';
import { Button } from './button';
import { ControlledSelect } from './controlled-select';
import { SelectItem } from './select';
import { Sheet, SheetContent, SheetTitle, SheetDescription } from './sheet';
import { useDiscardConfirmation } from './discard-confirmation';
import { Textarea } from './textarea';

export const ApplicationReviewContext = createContext<((id: string, trigger: HTMLElement) => void) | null>(null);

export function ApplicationReviewLink({ applicationId, href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { applicationId: string }) {
    const open = useContext(ApplicationReviewContext);
    return <a {...props} data-preview-trigger data-application-review={applicationId} href={href} onClick={(event) => {
        if (open && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
            event.preventDefault(); open(applicationId, event.currentTarget);
        }
        props.onClick?.(event);
    }} />;
}

export interface ReviewStage { id: string; label: string; kind: string }
interface DecisionState {
    applicationId: string;
    rejecting: boolean;
    editing: boolean;
    reason: string;
    targetId: string;
    error: string;
    success: string;
    successStageId: string;
    undo: ReviewStage | null;
}
const emptyDecision = (applicationId: string): DecisionState => ({ applicationId, rejecting: false, editing: false, reason: '', targetId: '', error: '', success: '', successStageId: '', undo: null });

export function ApplicationReviewPanel({ applicationId, currentStage, open, onClose, name, job, client, stages, nextStage, onMove, position, total, onPrevious, onNext, children, canMove = true, loading = false, dirty = false, returnFocus }: {
    applicationId: string; currentStage: ReviewStage;
    open: boolean; onClose: () => void; name: string; job: string; client: string;
    stages: ReviewStage[]; nextStage?: ReviewStage; onMove: (stage: ReviewStage, reason: string) => Promise<boolean>;
    position: number; total: number; onPrevious: () => void; onNext: () => void;
    children: ReactNode; returnFocus?: HTMLElement | null; dirty?: boolean; canMove?: boolean; loading?: boolean;
}) {
    const { requestDiscard, discardDialog } = useDiscardConfirmation();
    const [pending, setPending] = useState(false);
    const [savedDecision, setSavedDecision] = useState<DecisionState>(() => emptyDecision(applicationId));
    const decision = savedDecision.applicationId === applicationId ? savedDecision : emptyDecision(applicationId);
    const patch = (values: Partial<DecisionState>) => setSavedDecision((previous) => ({ ...(previous.applicationId === applicationId ? previous : emptyDecision(applicationId)), ...values }));
    const navigate = (action: () => void) => requestDiscard(dirty || Boolean(decision.reason.trim()), action);
    const rejected = stages.find((entry) => entry.kind === 'rejected');
    const closed = ['hired', 'rejected', 'withdrawn'].includes(currentStage.kind);
    const reopen = stages.find((entry) => entry.kind === 'active');
    const target = stages.find((entry) => entry.id === decision.targetId);
    const move = async (destination: ReviewStage, undoing = false) => {
        setPending(true); patch({ error: '' });
        try {
            if (await onMove(destination, destination.kind === 'rejected' ? decision.reason.trim() : '')) {
                patch({ rejecting: false, editing: false, reason: '', targetId: '', successStageId: destination.id, success: undoing ? 'Decision undone.' : destination.kind === 'hired' ? 'Marked as hired.' : `Moved to ${destination.label}.`, undo: !undoing && currentStage.kind === 'active' ? currentStage : null });
            } else patch({ error: 'Could not update this application. Please try again.' });
        } catch (failure) {
            patch({ error: failure instanceof Error ? failure.message : 'Could not update this application. Please try again.' });
        } finally { setPending(false); }
    };
    const confirmMove = (destination: ReviewStage) => requestDiscard(dirty, () => void move(destination));
    const disabled = !canMove || pending || loading;
    return <><Sheet open={open} onOpenChange={(value) => { if (!value && !pending) navigate(onClose); }}>
        <SheetContent data-testid="application-review-panel" className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl" onCloseAutoFocus={(event) => { event.preventDefault(); if (returnFocus?.isConnected) returnFocus.focus(); else document.getElementById('application-search')?.focus(); }} onEscapeKeyDown={(event) => { if (pending) event.preventDefault(); }} onInteractOutside={(event) => { if (pending) event.preventDefault(); }}>
            <div className="border-b border-border px-5 py-4 pr-12">
                <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
                    <span>Application {position + 1} of {total}</span>
                    <Button size="icon" variant="ghost" className="h-7 w-7" disabled={position === 0 || pending || loading} onClick={() => navigate(onPrevious)} aria-label="Previous application"><ChevronLeft /></Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7" disabled={position >= total - 1 || pending || loading} onClick={() => navigate(onNext)} aria-label="Next application"><ChevronRight /></Button>
                </div>
                <SheetTitle>{name}</SheetTitle>
                <SheetDescription className="mt-1">{job} · {client}</SheetDescription>
                <p className="mt-2 w-fit rounded-md bg-secondary px-2 py-1 text-xs font-medium">{currentStage.label}</p>
                {currentStage.label === 'Offer' && <p className="mt-2 text-xs text-muted-foreground">Awaiting an offer decision.</p>}
                <span className="sr-only" role="status">Viewing {name}, {job}, {currentStage.label}</span>
            </div>
            <div aria-busy={loading} className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
            <div className="flex flex-col gap-3 border-t border-border bg-card p-4">
                {decision.error && <p role="alert" className="text-sm text-destructive">{decision.error}</p>}
                {decision.success && decision.successStageId === currentStage.id && <div className="flex items-center gap-2 text-sm"><span role="status">{decision.success}</span>{decision.undo && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => requestDiscard(dirty, () => decision.undo && void move(decision.undo, true))}><Undo2 aria-hidden="true" />Undo</Button>}</div>}
                {decision.rejecting ? <>
                    <label htmlFor="application-rejection-reason" className="text-sm font-medium">Reason for rejection</label>
                    <Textarea id="application-rejection-reason" value={decision.reason} maxLength={500} onChange={(event) => patch({ reason: event.target.value })} placeholder="Add a brief reason" />
                    <div className="flex gap-2"><Button variant="outline" disabled={pending} onClick={() => patch({ rejecting: false, reason: '' })}>Cancel</Button><Button variant="destructive" disabled={disabled || !decision.reason.trim()} onClick={() => rejected && confirmMove(rejected)}>{pending ? 'Saving…' : 'Confirm rejection'}</Button></div>
                </> : decision.editing ? <div className="flex flex-col gap-3">
                    <label htmlFor="review-change-stage" className="text-sm font-medium">Change stage</label>
                    <ControlledSelect id="review-change-stage" value={decision.targetId || currentStage.id} disabled={disabled} onChange={(id) => patch({ targetId: id })}>
                        <SelectItem value={currentStage.id}>{currentStage.label}</SelectItem>
                        {stages.map((entry) => <SelectItem key={entry.id} value={entry.id}>{entry.label}</SelectItem>)}
                    </ControlledSelect>
                    <div className="flex gap-2"><Button variant="outline" disabled={pending} onClick={() => patch({ editing: false, targetId: '' })}>Cancel</Button><Button disabled={disabled || !target} onClick={() => { if (target?.kind === 'rejected') patch({ editing: false, rejecting: true }); else if (target) confirmMove(target); }}>Apply change</Button></div>
                </div> : <div className="flex flex-wrap items-center gap-2">
                    {closed ? reopen && <Button disabled={disabled} onClick={() => confirmMove(reopen)}>{pending ? 'Saving…' : 'Reopen for review'}</Button> : <>
                        {nextStage && <Button disabled={disabled} onClick={() => confirmMove(nextStage)}>{pending ? 'Saving…' : nextStage.kind === 'hired' ? 'Mark as hired' : `Move to ${nextStage.label}`}</Button>}
                        {rejected && <Button variant="outline" disabled={disabled} onClick={() => patch({ rejecting: true })}>Reject</Button>}
                    </>}
                    <Button variant="ghost" className="ml-auto" disabled={disabled} onClick={() => patch({ editing: true, targetId: '' })}>Change stage</Button>
                </div>}
            </div>
        </SheetContent>
    </Sheet>{discardDialog}</>;
}
