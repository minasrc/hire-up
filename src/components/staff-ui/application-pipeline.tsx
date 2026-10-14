'use client';

import { useId, useState, type HTMLAttributes, type ReactNode, type RefCallback } from 'react';
import { DragDropProvider, useDraggable, useDroppable } from '@dnd-kit/react';
import { Feedback, PointerSensor, KeyboardSensor } from '@dnd-kit/dom';

const pipelineSensors = [PointerSensor.configure({
    preventActivation: (event, source) => {
        if (event.target instanceof Element && event.target.closest('[data-pipeline-review]')) return false;
        return PointerSensor.defaults.preventActivation?.(event, source) ?? false;
    },
}), KeyboardSensor];
import { Badge } from './badge';
import { Button } from './button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './dialog';
import { Textarea } from './textarea';

export type PipelineDragProps = Pick<HTMLAttributes<HTMLLIElement>, 'draggable' | 'tabIndex' | 'aria-describedby' | 'aria-label' | 'style'> & { ref: RefCallback<HTMLLIElement>; 'data-drag-enabled': boolean };
interface PipelineStage { key: string; label: string; kind?: string }

function PipelineCard<Row>({ row, id, enabled, helpId, name, renderCard }: {
    row: Row; id: string; enabled: boolean; helpId: string; name?: string;
    renderCard: (row: Row, drag: PipelineDragProps) => ReactNode;
}) {
    const { ref } = useDraggable({
        id, disabled: !enabled,
        // A stage change remounts the card in another column. Clear the floating
        // preview before that happens instead of animating toward its old node.
        plugins: [Feedback.configure({ dropAnimation: null })],
    });
    return renderCard(row, {
        ref, draggable: false, 'data-drag-enabled': enabled,
        tabIndex: enabled ? 0 : undefined,
        'aria-label': enabled ? `Move ${name || 'application'}` : undefined,
        'aria-describedby': enabled ? helpId : undefined,
        style: { touchAction: enabled ? 'none' : undefined },
    });
}

function PipelineColumn({ stage, disabled, className, children, headingId }: {
    stage: PipelineStage; disabled: boolean; className: string; children: (over: boolean) => ReactNode; headingId: string;
}) {
    const { ref, isDropTarget } = useDroppable({ id: stage.key, disabled });
    return <section ref={ref} aria-labelledby={headingId} data-drop-stage={stage.key}
        className={`${className} ${isDropTarget ? 'bg-accent ring-2 ring-inset ring-ring' : ''}`}>
        {children(isDropTarget)}
    </section>;
}

export function ApplicationPipeline<Row>({ rows, stages, stageKey, renderCard, partial = false, onMove, rowName, rowKey, onShowAllStages }: {
    rows: Row[];
    partial?: boolean;
    stages: PipelineStage[];
    stageKey: (row: Row) => string;
    renderCard: (row: Row, drag: PipelineDragProps) => ReactNode;
    onMove?: (row: Row, stage: string, reason: string) => Promise<void>;
    rowName?: (row: Row) => string;
    rowKey: (row: Row) => string;
    onShowAllStages?: () => void;
}) {
    const id = useId();
    const [dragged, setDragged] = useState<Row | null>(null);
    const [pending, setPending] = useState(false);
    const [moves, setMoves] = useState<Record<string, string>>({});
    const [previousRows, setPreviousRows] = useState(rows);
    if (previousRows !== rows) {
        setPreviousRows(rows);
        setMoves(current => {
            const next = Object.fromEntries(Object.entries(current).filter(([key, destination]) => {
                const row = rows.find(item => rowKey(item) === key);
                return row && stageKey(row) !== destination;
            }));
            return Object.keys(next).length === Object.keys(current).length ? current : next;
        });
    }
    const displayedStage = (row: Row) => moves[rowKey(row)] ?? stageKey(row);
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const [rejection, setRejection] = useState<{ row: Row; stage: PipelineStage } | null>(null);
    const [reason, setReason] = useState('');
    const canDrag = Boolean(onMove) && stages.length > 1 && !pending && Object.keys(moves).length === 0;
    const move = async (row: Row, destination: PipelineStage, rejectionReason = '') => {
        if (!onMove || pending || stageKey(row) === destination.key) return;
        setPending(true); setError(''); setMessage('');
        setMoves(current => ({ ...current, [rowKey(row)]: destination.key }));
        try {
            await onMove(row, destination.key, rejectionReason);
            setMessage(`${rowName?.(row) || 'Application'} moved to ${destination.label}.`);
            setRejection(null); setReason('');
        } catch (failure) {
            setMoves(current => { const next = { ...current }; delete next[rowKey(row)]; return next; });
            setError(failure instanceof Error ? failure.message : 'Could not move this application. Please try again.');
        } finally { setPending(false); }
    };
    return <DragDropProvider sensors={pipelineSensors}
        onDragStart={(event) => {
            const row = rows.find((item) => rowKey(item) === event.operation.source?.id);
            setDragged(row ?? null); setError(''); setMessage('');
        }}
        onDragEnd={(event) => {
            const row = dragged;
            const destination = stages.find((stage) => stage.key === event.operation.target?.id);
            setDragged(null);
            if (event.canceled || !row || !destination || stageKey(row) === destination.key) return;
            if (destination.kind === 'rejected') { setReason(''); setError(''); setRejection({ row, stage: destination }); }
            else void move(row, destination);
        }}>
        <div className="flex min-w-0 flex-col gap-2">
        {onMove && stages.length > 1 && <p id={`${id}-drag-help`} className="text-xs text-muted-foreground">Drag a card to change its stage, or open it to review.</p>}
        {onMove && stages.length === 1 && onShowAllStages && <Button variant="outline" size="sm" className="w-fit" onClick={onShowAllStages}>Show all stages to drag cards</Button>}
        {message && <p role="status" className="text-sm">{message}</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div aria-busy={pending} className={`min-w-0 overflow-x-auto rounded-lg border border-border bg-secondary/20 ${stages.length === 1 ? 'md:max-w-sm' : ''}`} aria-label="Application pipeline">
            <div className="flex flex-col md:flex-row">
                {stages.map((stage, index) => {
                    const applications = rows.filter((row) => displayedStage(row) === stage.key);
                    const eligible = dragged !== null && stageKey(dragged) !== stage.key && !pending;
                    return (
                        <PipelineColumn key={stage.key} stage={stage} disabled={!canDrag} headingId={`${id}-${index}`}
                            className="min-w-0 flex-1 border-b border-border transition-colors last:border-0 md:min-w-[260px] md:border-r md:border-b-0">
                            {(over) => <>
                            <div className="relative flex items-center justify-between gap-2 border-b border-border bg-card px-4 py-3">
                                <h3 id={`${id}-${index}`} className="text-sm font-medium">{stage.label}</h3>
                                <Badge variant="secondary" aria-label={`${applications.length} applications shown`}>{applications.length}{partial ? ' shown' : ''}</Badge>
                            </div>
                            <div className="h-[min(72vh,800px)] min-h-[560px] overflow-y-auto overscroll-contain p-3" tabIndex={0} role="region" aria-label={`${stage.label} cards`}>
                                {applications.length ? <ul className="flex flex-col gap-2.5">{applications.map((row) => <PipelineCard key={rowKey(row)} id={rowKey(row)} row={row} enabled={canDrag} helpId={`${id}-drag-help`} name={rowName?.(row)} renderCard={renderCard} />)}</ul> : <p className="py-6 text-center text-xs text-muted-foreground">{over && eligible ? `Drop to move to ${stage.label}` : 'No applications in this stage'}</p>}
                            </div>
                            </>}
                        </PipelineColumn>
                    );
                })}
            </div>
        </div>
        <Dialog open={rejection !== null} onOpenChange={(open) => { if (!open && !pending) { setRejection(null); setReason(''); } }}>
            <DialogContent><DialogHeader><DialogTitle>Reject {rejection ? rowName?.(rejection.row) || 'application' : 'application'}?</DialogTitle><DialogDescription>Add a reason before moving this application to Rejected.</DialogDescription></DialogHeader>
                <label htmlFor={`${id}-reason`} className="text-sm font-medium">Reason for rejection</label>
                <Textarea id={`${id}-reason`} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} disabled={pending} />
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                <DialogFooter><Button variant="outline" disabled={pending} onClick={() => { setRejection(null); setReason(''); }}>Cancel</Button><Button variant="destructive" disabled={pending || !reason.trim()} onClick={() => rejection && void move(rejection.row, rejection.stage, reason.trim())}>{pending ? 'Saving…' : 'Confirm rejection'}</Button></DialogFooter>
            </DialogContent>
        </Dialog>
    </div></DragDropProvider>;
}
