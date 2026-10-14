'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ApplicationReviewPanel } from '@/components/staff-ui/application-review';
import { RealCandidateDocuments } from '@/components/staff-preview/real-candidate-documents';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/staff-ui/tabs';
import { Button } from '@/components/staff-ui/button';
import { staffWorkspaceFetch, staffWorkspaceUrl } from '@/lib/staff-workspace-fetch';
import { staffAuthRecovery } from '@/lib/staff-auth-recovery';
import { staffMutation } from '@/lib/staff-mutation';
import { NoteComposer, type Workspace } from '../candidates/[candidateId]/candidate-detail';
import type { ApplicationRow } from './applications-browser';

export async function loadApplicationWorkspace(candidateId: string, signal?: AbortSignal): Promise<Workspace> {
    const response = await staffWorkspaceFetch(`/api/staff/applications/review/${candidateId}`, { signal, cache: 'no-store' });
    if ([401, 428].includes(response.status)) staffAuthRecovery.require(response.status);
    if (!response.ok) throw new Error('Could not load this application. Please try again.');
    const payload = await response.json();
    return payload.result;
}
const stageLabel = (key: string, label: string) => ['new', 'review', 'reviewing'].includes(key) ? 'To review' : label;
export function StaffApplicationReview({ row, position, total, onClose, onPrevious, onNext, onChanged, returnFocus, navigationLoading = false, navigationError = '' }: {
    row: ApplicationRow; position: number; total: number; onClose: () => void; onPrevious: () => void; onNext: () => void; onChanged: () => void;
    returnFocus?: HTMLElement | null; navigationLoading?: boolean; navigationError?: string;
}) {
    const [loaded, setLoaded] = useState<{ id: string; workspace: Workspace } | null>(null);
    const [error, setError] = useState('');
    const [revision, setRevision] = useState(0);
    const [tab, setTab] = useState('profile');
    const [dirty, setDirty] = useState(false);
    useEffect(() => {
        const controller = new AbortController();
        loadApplicationWorkspace(row.candidateId, controller.signal).then((workspace) => {
            if (!controller.signal.aborted) { setLoaded({ id: row.candidateId, workspace }); setError(''); }
        }).catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
        return () => controller.abort();
    }, [row.candidateId, revision]);
    const workspace = loaded?.id === row.candidateId ? loaded.workspace : null;
    const application = workspace?.applications.find((entry) => entry.applicationId === row.applicationId);
    const pipeline = (workspace?.stages ?? []).filter((stage) => stage.pipelineId === application?.pipelineId).sort((a, b) => a.position - b.position);
    const current = pipeline.find((stage) => stage.stageId === application?.stageId);
    const next = current?.kind === 'active' ? pipeline.find((stage) => stage.position > current.position && stage.key !== 'reviewing' && ['active', 'hired'].includes(stage.kind)) : undefined;
    const stages = pipeline.filter((stage) => stage.key !== 'reviewing' || !pipeline.some((entry) => entry.key === 'new')).map((stage) => ({ id: stage.stageId, label: stageLabel(stage.key, stage.label), kind: stage.kind }));
    return <ApplicationReviewPanel applicationId={row.applicationId} currentStage={{ id: current?.stageId ?? row.stageId, label: stageLabel(current?.key ?? row.stageKey, current?.label ?? row.stageLabel), kind: current?.kind ?? row.stageKind }}
        open onClose={onClose} returnFocus={returnFocus} dirty={dirty} loading={!workspace || navigationLoading} name={row.candidateName ?? 'Unnamed candidate'} job={row.jobTitle} client={row.clientName}
        stages={stages} nextStage={next ? { id: next.stageId, label: next.label, kind: next.kind } : undefined} position={position} total={total}
        onPrevious={() => { setDirty(false); onPrevious(); }} onNext={() => { setDirty(false); onNext(); }}
        canMove={Boolean(application && workspace?.capabilities.changeStage && workspace.candidate.lifecycle === 'active')}
        onMove={async (target, reason) => {
            if (!application) return false;
            try {
                await staffMutation('/api/staff/applications', { action: 'transitionStage', applicationId: row.applicationId, toStageId: target.id, expectedVersion: application.version, reason });
                setRevision((value) => value + 1); onChanged(); return true;
            } catch (failure) { setRevision((value) => value + 1); throw failure; }
        }}>
        {navigationError && <p role="alert" className="mb-3 text-sm text-destructive">{navigationError}</p>}
        {error ? <div role="alert"><p>{error}</p><Button variant="outline" onClick={() => setRevision((value) => value + 1)}>Try again</Button></div> : workspace ? <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="mb-4"><TabsTrigger value="profile">Profile</TabsTrigger><TabsTrigger value="cv">CV</TabsTrigger><TabsTrigger value="notes">Notes</TabsTrigger></TabsList>
            <TabsContent value="profile"><p className="text-sm text-muted-foreground">{[workspace.candidate.headline, workspace.candidate.location].filter(Boolean).join(' · ')}</p><p className="mt-4 whitespace-pre-wrap text-sm">{workspace.candidate.professionalSummary || 'No summary provided.'}</p><Button asChild variant="outline" className="mt-4"><Link href={staffWorkspaceUrl(`/staff/candidates/${row.candidateId}`)}>Open full profile</Link></Button></TabsContent>
            <TabsContent value="cv"><RealCandidateDocuments key={row.candidateId} documents={workspace.documents} canView={workspace.capabilities.downloadDocuments} /></TabsContent>
            <TabsContent value="notes">{workspace.capabilities.writeNotes ? <NoteComposer key={row.applicationId} candidateId={row.candidateId} onDirtyChange={setDirty} onAdded={() => setRevision((value) => value + 1)} /> : null}{workspace.capabilities.readNotes ? workspace.notes.map((note) => <p key={note.noteId} className="mt-4 whitespace-pre-wrap rounded-lg border border-border p-3 text-sm">{note.body}</p>) : <p>Notes are unavailable.</p>}</TabsContent>
        </Tabs> : <p role="status">Loading application…</p>}
    </ApplicationReviewPanel>;
}
