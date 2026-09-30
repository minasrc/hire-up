'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, FileText, Lock } from 'lucide-react';

import { Badge } from '@/components/staff-ui/badge';
import { Button } from '@/components/staff-ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/staff-ui/card';
import { Label } from '@/components/staff-ui/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/staff-ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/staff-ui/tabs';
import { Textarea } from '@/components/staff-ui/textarea';
import { cn } from '@/lib/utils';
import {
    EditCandidateProfileButton,
    type CandidateProfileOptions,
} from '../candidate-profile-dialog';

const AVATAR_PALETTE = [
    'bg-[#f1f3f5] text-[#4b5563]',
    'bg-[#eef4ef] text-[#44644c]',
    'bg-[#e2f4e9] text-[#1d6b45]',
    'bg-[#f3e8f7] text-[#74408f]',
    'bg-[#fbe8ec] text-[#9f2843]',
];

const KIND_TONE: Record<string, 'accent' | 'warning' | 'success' | 'restriction' | 'secondary'> = {
    active: 'accent',
    hired: 'success',
    rejected: 'restriction',
    withdrawn: 'secondary',
};

const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric',
    });

const formatDateTime = (iso: string) =>
    new Date(iso).toLocaleString('en-GB', {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });

function initials(name: string) {
    return name
        .split(' ')
        .map((part) => part.charAt(0))
        .filter(Boolean)
        .slice(0, 2)
        .join('')
        .toUpperCase();
}

interface Stage {
    stageId: string;
    pipelineId: string;
    key: string;
    label: string;
    kind: string;
    position: number;
}

interface ApplicationHistory {
    sequence: number;
    fromStageLabel: string | null;
    toStageLabel: string;
    actorName: string | null;
    reason: string | null;
    occurredAt: string;
}

interface CandidateApplication {
    applicationId: string;
    jobTitle: string;
    clientName: string;
    pipelineId: string;
    stageId: string;
    stageLabel: string;
    stageKind: string;
    publicReference: string;
    submittedName: string | null;
    submittedEmail: string | null;
    submittedProfessionalUrl: string | null;
    submittedAchievement: string | null;
    receivedAt: string;
    version: string;
    history: ApplicationHistory[];
}

interface Workspace {
    candidate: {
        candidateId: string;
        fullName: string | null;
        professionalSummary: string | null;
        lifecycle: string;
        ownerName: string | null;
        createdAt: string;
        version: string;
        email?: string | null;
        secondaryEmails?: string[];
        professionalUrl?: string | null;
        headline?: string | null;
        location?: string | null;
        ownerMembershipId?: string | null;
    };
    identifiers: { kind: string; value: string; verification: string }[];
    applications: CandidateApplication[];
    stages: Stage[];
    documents: {
        documentId: string;
        filename: string;
        purpose: string;
        lifecycle: string;
        scanState: string;
        sizeBytes: number;
        receivedAt: string;
    }[];
    notes: {
        noteId: string;
        body: string;
        authorName: string | null;
        createdAt: string;
    }[];
    capabilities: {
        readApplications: boolean;
        readNotes: boolean;
        writeNotes: boolean;
        changeStage: boolean;
        downloadDocuments: boolean;
        writeCandidates?: boolean;
    };
    profileOptions?: CandidateProfileOptions;
}

function StageSelect({
    application,
    stages,
    disabled,
}: {
    application: CandidateApplication;
    stages: Stage[];
    disabled: boolean;
}) {
    const router = useRouter();
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');

    const move = async (toStageId: string) => {
        if (!toStageId || toStageId === application.stageId) return;
        setPending(true);
        setError('');
        try {
            const response = await fetch('/api/staff/applications', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    action: 'transitionStage',
                    applicationId: application.applicationId,
                    toStageId,
                    expectedVersion: application.version,
                }),
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                setError(
                    payload?.code === '40001'
                        ? 'Someone else moved this application — reload the page.'
                        : 'Stage change failed.',
                );
            } else {
                router.refresh();
            }
        } catch {
            setError('Stage change failed.');
        } finally {
            setPending(false);
        }
    };

    const options = stages
        .filter((stage) => stage.pipelineId === application.pipelineId)
        .sort((a, b) => a.position - b.position);

    return (
        <div className="flex flex-col gap-1">
            <Select
                value={application.stageId}
                onValueChange={move}
                disabled={disabled || pending}
            >
                <SelectTrigger
                    className="w-44"
                    aria-label={`Stage for application ${application.publicReference}`}
                >
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {options.map((stage) => (
                        <SelectItem key={stage.stageId} value={stage.stageId}>
                            {stage.label}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            {error ? (
                <span role="alert" className="text-xs text-destructive">{error}</span>
            ) : null}
        </div>
    );
}

function NoteComposer({ candidateId }: { candidateId: string }) {
    const router = useRouter();
    const [body, setBody] = useState('');
    const [pending, setPending] = useState(false);
    const [message, setMessage] = useState('');

    const submit = async () => {
        if (!body.trim()) return;
        setPending(true);
        setMessage('');
        try {
            const response = await fetch('/api/staff/candidates', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    action: 'addNote',
                    candidateId,
                    body: body.trim(),
                }),
            });
            if (!response.ok) {
                setMessage('Note could not be saved.');
            } else {
                setBody('');
                setMessage('Note added.');
                router.refresh();
            }
        } catch {
            setMessage('Note could not be saved.');
        } finally {
            setPending(false);
        }
    };

    return (
        <div className="flex flex-col gap-2">
            <Label htmlFor="note-body">Add a note</Label>
            <Textarea
                id="note-body"
                placeholder="Interview feedback, context, next steps…"
                rows={3}
                value={body}
                onChange={(event) => setBody(event.target.value)}
            />
            <div className="flex items-center gap-3">
                <Button size="sm" onClick={submit} disabled={pending || !body.trim()}>
                    {pending ? 'Saving…' : 'Add note'}
                </Button>
                {message ? (
                    <span role="status" className="text-xs text-muted-foreground">{message}</span>
                ) : null}
            </div>
        </div>
    );
}

const DETAIL_TABS = ['applications', 'documents', 'notes'] as const;

export function CandidateDetail({
    workspace,
    profileUnavailable = false,
}: {
    workspace: Workspace;
    profileUnavailable?: boolean;
}) {
    const router = useRouter();
    const { candidate, identifiers, applications, stages, documents, notes, capabilities } =
        workspace;
    const searchParams = useSearchParams();
    const pathname = usePathname();
    const requestedTab = searchParams.get('tab') ?? '';
    const tab = (DETAIL_TABS as readonly string[]).includes(requestedTab)
        ? requestedTab
        : 'applications';
    const setTab = (value: string) => {
        const params = new URLSearchParams(searchParams.toString());
        if (value === 'applications') {
            params.delete('tab');
        } else {
            params.set('tab', value);
        }
        const queryString = params.toString();
        window.history.replaceState(
            null, '', `${pathname}${queryString ? `?${queryString}` : ''}`);
    };
    const name = candidate.fullName ?? 'Unnamed candidate';
    const email = candidate.email !== undefined
        ? candidate.email
        : identifiers.find((entry) => entry.kind === 'email')?.value;
    const otherEmails = candidate.secondaryEmails ?? [];
    const professionalUrl = candidate.professionalUrl !== undefined
        ? candidate.professionalUrl
        : identifiers.find(
            (entry) => entry.kind === 'professional_url')?.value;
    const canEditProfile = !profileUnavailable
        && capabilities.writeCandidates === true
        && workspace.profileOptions !== undefined;
    const palette = AVATAR_PALETTE[name.length % AVATAR_PALETTE.length];

    return (
        <div className="flex flex-col gap-6">
            <Link
                href="/staff/candidates"
                className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground"
            >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                Back to candidates
            </Link>
            {profileUnavailable ? (
                <p role="status" className="text-sm text-muted-foreground">
                    Profile editing is temporarily unavailable.
                </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-4">
                <span
                    aria-hidden="true"
                    className={cn(
                        'inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-base font-semibold',
                        palette,
                    )}
                >
                    {initials(name)}
                </span>
                <div className="flex min-w-0 flex-col gap-1">
                    <h1 className="text-[26px] leading-8 font-medium text-foreground">{name}</h1>
                    {candidate.headline ? (
                        <p className="text-sm text-foreground">{candidate.headline}</p>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                        {email ? <span>{email}</span> : null}
                        {otherEmails.length > 0 ? <span>· Secondary emails: {otherEmails.join(', ')}</span> : null}
                        {professionalUrl ? (
                            <a
                                href={professionalUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="underline underline-offset-4 hover:opacity-70"
                            >
                                Profile
                            </a>
                        ) : null}
                        {candidate.location ? <span>· {candidate.location}</span> : null}
                        {candidate.ownerName ? (
                            <span>· Owner: {candidate.ownerName}</span>
                        ) : null}
                    </div>
                </div>
                {canEditProfile ? (
                    <div className="w-full sm:ml-auto sm:w-auto">
                        <EditCandidateProfileButton
                            options={workspace.profileOptions as CandidateProfileOptions}
                            candidate={{
                                fullName: candidate.fullName ?? '',
                                email: email ?? null,
                                professionalUrl: professionalUrl ?? null,
                                headline: candidate.headline ?? null,
                                location: candidate.location ?? null,
                                ownerMembershipId: candidate.ownerMembershipId ?? null,
                                professionalSummary: candidate.professionalSummary,
                            }}
                            candidateId={candidate.candidateId}
                            version={String(candidate.version)}
                            onSaved={() => router.refresh()}
                        />
                    </div>
                ) : null}
            </div>

            {candidate.professionalSummary ? (
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Summary</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-sm whitespace-pre-wrap">
                            {candidate.professionalSummary}
                        </p>
                    </CardContent>
                </Card>
            ) : null}

            <Tabs value={tab} onValueChange={setTab}>
                <TabsList>
                    <TabsTrigger value="applications">
                        Applications
                        <Badge variant="secondary">{applications.length}</Badge>
                    </TabsTrigger>
                    <TabsTrigger value="documents">
                        Documents
                        <Badge variant="secondary">{documents.length}</Badge>
                    </TabsTrigger>
                    <TabsTrigger value="notes">
                        Notes
                        <Badge variant="secondary">{notes.length}</Badge>
                    </TabsTrigger>
                </TabsList>

                <TabsContent value="applications" className="flex flex-col gap-4 pt-4">
                    {!capabilities.readApplications ? (
                        <p className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Lock className="h-4 w-4" aria-hidden="true" />
                            Application details require the applications.read permission.
                        </p>
                    ) : applications.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No applications yet.</p>
                    ) : (
                        applications.map((application) => (
                            <Card key={application.applicationId}>
                                <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                    <div className="flex flex-col gap-1">
                                        <CardTitle className="text-base">
                                            {application.jobTitle}
                                        </CardTitle>
                                        <p className="text-sm text-muted-foreground">
                                            {application.clientName} ·{' '}
                                            {formatDate(application.receivedAt)} ·{' '}
                                            <span className="font-mono text-xs">
                                                {application.publicReference}
                                            </span>
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-3">
                                        <Badge
                                            variant={KIND_TONE[application.stageKind] ?? 'secondary'}
                                        >
                                            {application.stageLabel}
                                        </Badge>
                                        {capabilities.changeStage ? (
                                            <StageSelect
                                                application={application}
                                                stages={stages}
                                                disabled={false}
                                            />
                                        ) : null}
                                    </div>
                                </CardHeader>
                                <CardContent className="flex flex-col gap-4">
                                    {application.submittedAchievement ? (
                                        <div className="flex flex-col gap-1">
                                            <span className="text-xs font-medium text-muted-foreground">
                                                Technical achievement
                                            </span>
                                            <p className="text-sm whitespace-pre-wrap">
                                                {application.submittedAchievement}
                                            </p>
                                        </div>
                                    ) : null}
                                    {application.history.length > 0 ? (
                                        <ol className="flex flex-col gap-2 border-l border-border pl-4">
                                            {application.history.map((entry) => (
                                                <li
                                                    key={entry.sequence}
                                                    className="text-xs text-muted-foreground"
                                                >
                                                    <span className="font-medium text-foreground">
                                                        {entry.fromStageLabel
                                                            ? `${entry.fromStageLabel} → ${entry.toStageLabel}`
                                                            : entry.toStageLabel}
                                                    </span>{' '}
                                                    · {formatDateTime(entry.occurredAt)}
                                                    {entry.actorName ? ` · ${entry.actorName}` : ''}
                                                    {entry.reason ? ` — ${entry.reason}` : ''}
                                                </li>
                                            ))}
                                        </ol>
                                    ) : null}
                                </CardContent>
                            </Card>
                        ))
                    )}
                </TabsContent>

                <TabsContent value="documents" className="flex flex-col gap-3 pt-4">
                    {documents.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No documents on file.</p>
                    ) : (
                        documents.map((document) => (
                            <div
                                key={document.documentId}
                                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3"
                            >
                                <div className="flex items-center gap-3">
                                    <FileText
                                        className="h-4 w-4 text-muted-foreground"
                                        aria-hidden="true"
                                    />
                                    <div className="flex flex-col">
                                        <span className="text-sm font-medium text-foreground">
                                            {document.filename}
                                        </span>
                                        <span className="text-xs text-muted-foreground">
                                            {document.purpose.toUpperCase()} ·{' '}
                                            {formatDate(document.receivedAt)} ·{' '}
                                            {Math.round(document.sizeBytes / 1024)} KB
                                            {document.scanState !== 'clean'
                                                ? ` · scan: ${document.scanState}`
                                                : ''}
                                        </span>
                                    </div>
                                </div>
                                {capabilities.downloadDocuments
                                    && document.lifecycle === 'active' ? (
                                    <Button variant="outline" size="sm" asChild>
                                        <a
                                            href={`/api/staff/documents/${document.documentId}`}
                                        >
                                            Download
                                        </a>
                                    </Button>
                                ) : null}
                            </div>
                        ))
                    )}
                </TabsContent>

                <TabsContent value="notes" className="flex flex-col gap-4 pt-4">
                    {!capabilities.readNotes ? (
                        <p className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Lock className="h-4 w-4" aria-hidden="true" />
                            Notes require the collaboration.read permission.
                        </p>
                    ) : (
                        <>
                            {capabilities.writeNotes ? (
                                <NoteComposer candidateId={candidate.candidateId} />
                            ) : null}
                            {notes.length === 0 ? (
                                <p className="text-sm text-muted-foreground">No notes yet.</p>
                            ) : (
                                <ol className="flex flex-col gap-3">
                                    {notes.map((note) => (
                                        <li
                                            key={note.noteId}
                                            className="flex flex-col gap-1 rounded-lg border border-border bg-card px-4 py-3"
                                        >
                                            <p className="text-sm whitespace-pre-wrap">
                                                {note.body}
                                            </p>
                                            <span className="text-xs text-muted-foreground">
                                                {note.authorName ?? 'Staff'} ·{' '}
                                                {formatDateTime(note.createdAt)}
                                            </span>
                                        </li>
                                    ))}
                                </ol>
                            )}
                        </>
                    )}
                </TabsContent>
            </Tabs>
        </div>
    );
}
