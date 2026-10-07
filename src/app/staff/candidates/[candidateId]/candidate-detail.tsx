'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
    ArrowLeft,
    FileText,
    Lock,
    MessageSquareText,
    Plus,
    ShieldAlert,
    Upload,
} from 'lucide-react';

import { Badge } from '@/components/staff-ui/badge';
import { Button } from '@/components/staff-ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/staff-ui/card';
import { Checkbox } from '@/components/staff-ui/checkbox';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/staff-ui/dialog';
import { Input } from '@/components/staff-ui/input';
import { Label } from '@/components/staff-ui/label';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/staff-ui/popover';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/staff-ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/staff-ui/tabs';
import { Textarea } from '@/components/staff-ui/textarea';
import { CandidateSummary } from '@/components/staff-preview/candidate-summary';
import { FieldLabel, InitialsAvatar, TagPill } from '@/components/staff-preview/shared';
import { CV_ACCEPT_ATTRIBUTE, validateCvFileMetadata } from '@/lib/application';
import { isUuid } from '@/lib/recruitment-contracts';
import { cn } from '@/lib/utils';
import type {
    CandidateFields,
    CandidateWorkspace,
} from '@/lib/recruitment-types';
import { useUnsavedChangesGuard } from '../../form-guard';

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

const SOURCE_LABELS: Record<string, string> = {
    public_application: 'Application',
    manual: 'Manual entry',
    referral: 'Referral',
    legacy: 'Legacy record',
    import: 'CSV import',
};

const sourceLabel = (value: string | null | undefined) =>
    value ? (SOURCE_LABELS[value] ?? value) : 'Not provided';

const nativeSelectClass =
    'w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring';

function Field({
    label,
    htmlFor,
    required,
    children,
}: {
    label: string;
    htmlFor: string;
    required?: boolean;
    children: ReactNode;
}) {
    return (
        <div className="flex flex-col gap-1.5">
            <Label htmlFor={htmlFor}>{label}{required ? ' *' : ''}</Label>
            {children}
        </div>
    );
}

type Workspace = CandidateWorkspace;
type ApplicationEntry = Workspace['applications'][number];
type StageEntry = Workspace['stages'][number];
type DocumentEntry = Workspace['documents'][number];

function StageSelect({
    application,
    stages,
    disabled,
    onChanged,
}: {
    application: ApplicationEntry;
    stages: StageEntry[];
    disabled: boolean;
    onChanged?: () => void;
}) {
    const router = useRouter();
    const refresh = () => (onChanged ? onChanged() : router.refresh());
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
                refresh();
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

function NoteComposer({
    candidateId,
    onSaved,
}: {
    candidateId: string;
    onSaved: () => void;
}) {
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
                onSaved();
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

interface EditDraft {
    fullName: string;
    headline: string;
    location: string;
    email: string;
    professionalUrl: string;
    professionalSummary: string;
    availability: 'not_specified' | 'open';
    tags: string;
    skills: string;
    ownerMembershipId: string;
    experience: { _key: string; role: string; company: string; period: string; description: string }[];
}

function EditProfileDialog({
    workspace,
    onChanged,
}: {
    workspace: Workspace;
    onChanged?: () => void;
}) {
    const router = useRouter();
    const refresh = () => (onChanged ? onChanged() : router.refresh());
    const candidate = workspace.candidate;
    const owners = workspace.context?.owners ?? [];
    const baseline = (): EditDraft => ({
        fullName: candidate.fullName ?? '',
        headline: candidate.headline ?? '',
        location: candidate.location ?? '',
        email: candidate.email ?? '',
        professionalUrl: candidate.professionalUrl ?? '',
        professionalSummary: candidate.professionalSummary ?? '',
        availability:
            candidate.availability === 'open' ? 'open' : 'not_specified',
        tags: (candidate.tags ?? []).join(', '),
        skills: (candidate.skills ?? []).join(', '),
        ownerMembershipId: candidate.ownerMembershipId ?? 'none',
        experience: (candidate.experience ?? []).map((entry) => ({
            _key: crypto.randomUUID(),
            role: entry.role,
            company: entry.company,
            period: entry.period,
            description: entry.description,
        })),
    });
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState<EditDraft>(baseline);
    const [dirty, setDirty] = useState(false);
    const [error, setError] = useState('');
    const [pending, setPending] = useState(false);
    const operationIdRef = useRef<string>(crypto.randomUUID());

    const patch = (partial: Partial<EditDraft>) => {
        setDirty(true);
        setDraft((current) => ({ ...current, ...partial }));
    };

    const fieldsPayload = (): CandidateFields => ({
        fullName: draft.fullName.trim(),
        headline: draft.headline.trim() || null,
        location: draft.location.trim() || null,
        email: draft.email.trim() || null,
        professionalUrl: draft.professionalUrl.trim() || null,
        ownerMembershipId:
            draft.ownerMembershipId === 'none' ? null : draft.ownerMembershipId,
        professionalSummary: draft.professionalSummary.trim() || null,
        availability: draft.availability,
        tags: draft.tags.split(',').map((entry) => entry.trim()).filter(Boolean),
        skills: draft.skills.split(',').map((entry) => entry.trim()).filter(Boolean),
        experience: draft.experience.map((entry) => ({
            role: entry.role,
            company: entry.company,
            period: entry.period,
            description: entry.description,
        })),
        source: 'manual',
    });

    const save = async (): Promise<boolean> => {
        if (pending) return false;
        setPending(true);
        setError('');
        try {
            await fetch(`/api/staff/candidates/${candidate.candidateId}`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    fields: fieldsPayload(),
                    expectedVersion: candidate.version,
                    operationId: operationIdRef.current,
                }),
            }).then(async (response) => {
                const payload = await response.json().catch(() => ({}));
                if (!response.ok) {
                    throw new Error(
                        response.status === 409
                            ? 'This record changed elsewhere. Reload and try again.'
                            : response.status === 401 || response.status === 428
                              ? 'Your session expired. Sign in again.'
                              : response.status === 403
                                ? 'You do not have permission to edit this candidate.'
                                : payload.fields
                                  ? `Check these fields: ${Object.keys(payload.fields).join(', ')}`
                                  : payload.error ?? 'Could not save the profile.',
                    );
                }
            });
            setDirty(false);
            setOpen(false);
            operationIdRef.current = crypto.randomUUID();
            window.dispatchEvent(new Event('staff-workspace-updated'));
            refresh();
            return true;
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : 'Could not save the profile.');
            return false;
        } finally {
            setPending(false);
        }
    };

    useUnsavedChangesGuard({
        dirty: open && dirty,
        save: async () => save(),
    });

    return (
        <>
            <Button
                variant="outline"
                size="sm"
                onClick={() => {
                    setDraft(baseline());
                    setDirty(false);
                    setError('');
                    setOpen(true);
                }}
            >
                Edit profile
            </Button>
            <Dialog
                open={open}
                onOpenChange={(next) => {
                    if (pending) return;
                    setOpen(next);
                    if (!next) setDirty(false);
                }}
            >
                <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>Edit profile</DialogTitle>
                        <DialogDescription>
                            Update the candidate profile. Empty contact fields stay
                            empty — clearing an email or URL removes it.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <Field label="Full name" htmlFor="edit-candidate-name" required>
                            <Input
                                id="edit-candidate-name"
                                value={draft.fullName}
                                maxLength={120}
                                onChange={(event) => patch({ fullName: event.target.value })}
                            />
                        </Field>
                        <Field label="Email" htmlFor="edit-candidate-email">
                            <Input
                                id="edit-candidate-email"
                                type="email"
                                value={draft.email}
                                maxLength={254}
                                onChange={(event) => patch({ email: event.target.value })}
                            />
                        </Field>
                        <Field label="Role / headline" htmlFor="edit-candidate-headline">
                            <Input
                                id="edit-candidate-headline"
                                value={draft.headline}
                                maxLength={200}
                                onChange={(event) => patch({ headline: event.target.value })}
                            />
                        </Field>
                        <Field label="Location" htmlFor="edit-candidate-location">
                            <Input
                                id="edit-candidate-location"
                                value={draft.location}
                                maxLength={200}
                                onChange={(event) => patch({ location: event.target.value })}
                            />
                        </Field>
                        <Field label="Profile URL" htmlFor="edit-candidate-url">
                            <Input
                                id="edit-candidate-url"
                                type="url"
                                value={draft.professionalUrl}
                                maxLength={2048}
                                onChange={(event) =>
                                    patch({ professionalUrl: event.target.value })
                                }
                            />
                        </Field>
                        <Field label="Availability" htmlFor="edit-candidate-availability">
                            <select
                                id="edit-candidate-availability"
                                className={nativeSelectClass}
                                value={draft.availability}
                                onChange={(event) =>
                                    patch({
                                        availability: event.target.value as
                                            EditDraft['availability'],
                                    })
                                }
                            >
                                <option value="not_specified">Not specified</option>
                                <option value="open">Open to offers</option>
                            </select>
                        </Field>
                        <Field label="Owner" htmlFor="edit-candidate-owner">
                            <select
                                id="edit-candidate-owner"
                                className={nativeSelectClass}
                                value={draft.ownerMembershipId}
                                onChange={(event) =>
                                    patch({ ownerMembershipId: event.target.value })
                                }
                            >
                                <option value="none">Unassigned</option>
                                {owners.map((owner) => (
                                    <option key={owner.id} value={owner.id}>
                                        {owner.name}
                                    </option>
                                ))}
                            </select>
                        </Field>
                        <Field label="Tags (comma separated)" htmlFor="edit-candidate-tags">
                            <Input
                                id="edit-candidate-tags"
                                value={draft.tags}
                                onChange={(event) => patch({ tags: event.target.value })}
                            />
                        </Field>
                        <Field label="Skills (comma separated)" htmlFor="edit-candidate-skills">
                            <Input
                                id="edit-candidate-skills"
                                value={draft.skills}
                                onChange={(event) => patch({ skills: event.target.value })}
                            />
                        </Field>
                    </div>
                    <Field label="Professional summary" htmlFor="edit-candidate-summary">
                        <Textarea
                            id="edit-candidate-summary"
                            rows={3}
                            maxLength={8000}
                            value={draft.professionalSummary}
                            onChange={(event) =>
                                patch({ professionalSummary: event.target.value })
                            }
                        />
                    </Field>
                    <div className="flex flex-col gap-2">
                        <div className="flex items-center justify-between">
                            <span className="text-xs font-medium text-muted-foreground">
                                Experience
                            </span>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={draft.experience.length >= 20}
                                onClick={() =>
                                    patch({
                                        experience: [
                                            ...draft.experience,
                                            {
                                                _key: crypto.randomUUID(),
                                                role: '',
                                                company: '',
                                                period: '',
                                                description: '',
                                            },
                                        ],
                                    })
                                }
                            >
                                <Plus aria-hidden="true" />
                                Add experience
                            </Button>
                        </div>
                        {draft.experience.map((entry, index) => (
                            <div
                                key={entry._key}
                                className="flex flex-col gap-2 rounded-lg border border-border p-3"
                            >
                                <div className="grid gap-2 sm:grid-cols-3">
                                    <Input
                                        aria-label={`Experience ${index + 1} role`}
                                        placeholder="Role"
                                        value={entry.role}
                                        onChange={(event) =>
                                            patch({
                                                experience: draft.experience.map(
                                                    (item, position) =>
                                                        position === index
                                                            ? { ...item, role: event.target.value }
                                                            : item,
                                                ),
                                            })
                                        }
                                    />
                                    <Input
                                        aria-label={`Experience ${index + 1} company`}
                                        placeholder="Company"
                                        value={entry.company}
                                        onChange={(event) =>
                                            patch({
                                                experience: draft.experience.map(
                                                    (item, position) =>
                                                        position === index
                                                            ? { ...item, company: event.target.value }
                                                            : item,
                                                ),
                                            })
                                        }
                                    />
                                    <Input
                                        aria-label={`Experience ${index + 1} period`}
                                        placeholder="Period"
                                        value={entry.period}
                                        onChange={(event) =>
                                            patch({
                                                experience: draft.experience.map(
                                                    (item, position) =>
                                                        position === index
                                                            ? { ...item, period: event.target.value }
                                                            : item,
                                                ),
                                            })
                                        }
                                    />
                                </div>
                                <div className="flex items-start gap-2">
                                    <Textarea
                                        aria-label={`Experience ${index + 1} description`}
                                        placeholder="Description"
                                        rows={2}
                                        value={entry.description}
                                        onChange={(event) =>
                                            patch({
                                                experience: draft.experience.map(
                                                    (item, position) =>
                                                        position === index
                                                            ? { ...item, description: event.target.value }
                                                            : item,
                                                ),
                                            })
                                        }
                                    />
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        aria-label={`Remove experience ${index + 1}`}
                                        onClick={() =>
                                            patch({
                                                experience: draft.experience.filter(
                                                    (_, position) => position !== index,
                                                ),
                                            })
                                        }
                                    >
                                        Remove
                                    </Button>
                                </div>
                            </div>
                        ))}
                    </div>
                    {error ? (
                        <p role="alert" className="text-sm text-destructive">
                            {error}
                        </p>
                    ) : null}
                    <DialogFooter>
                        <Button
                            variant="ghost"
                            disabled={pending}
                            onClick={() => {
                                setOpen(false);
                                setDirty(false);
                            }}
                        >
                            Cancel
                        </Button>
                        <Button
                            disabled={pending || draft.fullName.trim() === ''}
                            onClick={() => void save()}
                        >
                            {pending ? 'Saving…' : 'Save profile'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}

function AddToJobDialog({
    workspace,
    onChanged,
}: {
    workspace: Workspace;
    onChanged?: () => void;
}) {
    const router = useRouter();
    const refresh = () => (onChanged ? onChanged() : router.refresh());
    const appliedJobIds = useMemo(
        () => new Set(workspace.applications.map((entry) => entry.jobId)),
        [workspace.applications],
    );
    const openJobs = useMemo(
        () => (workspace.context?.jobs ?? []).filter(
            (job) => job.applicationState === 'open',
        ),
        [workspace.context?.jobs],
    );
    const [open, setOpen] = useState(false);
    const [jobId, setJobId] = useState('none');
    const [error, setError] = useState('');
    const [duplicateApplicationId, setDuplicateApplicationId] = useState<string | null>(null);
    const [pending, setPending] = useState(false);
    const operationIdRef = useRef<string>(crypto.randomUUID());

    const submit = async () => {
        if (pending || jobId === 'none') return;
        setPending(true);
        setError('');
        setDuplicateApplicationId(null);
        try {
            const response = await fetch(
                `/api/staff/candidates/${workspace.candidate.candidateId}/applications`,
                {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        jobId,
                        operationId: operationIdRef.current,
                    }),
                },
            );
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                if (response.status === 409 && payload?.applicationId) {
                    setDuplicateApplicationId(String(payload.applicationId));
                    setError(
                        payload.error
                        ?? 'This candidate already has an application for that job.',
                    );
                    return;
                }
                setError(
                    response.status === 401 || response.status === 428
                        ? 'Your session expired. Sign in again.'
                        : response.status === 403
                          ? 'You do not have permission to add applications.'
                          : payload.error ?? 'Could not add the application.',
                );
                return;
            }
            setOpen(false);
            setJobId('none');
            operationIdRef.current = crypto.randomUUID();
            refresh();
        } catch {
            setError('Could not add the application. Please try again.');
        } finally {
            setPending(false);
        }
    };

    return (
        <>
            <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
                <Plus aria-hidden="true" />
                Add to job
            </Button>
            <Dialog
                open={open}
                onOpenChange={(next) => {
                    if (pending) return;
                    setOpen(next);
                    if (!next) {
                        setJobId('none');
                        setError('');
                        setDuplicateApplicationId(null);
                    }
                }}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Add to a job</DialogTitle>
                        <DialogDescription>
                            Link this candidate to a published, open role — listed or
                            unlisted.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor="add-to-job-select">Job</Label>
                        <select
                            id="add-to-job-select"
                            className={nativeSelectClass}
                            value={jobId}
                            onChange={(event) => setJobId(event.target.value)}
                        >
                            <option value="none">Select a job…</option>
                            {openJobs.map((job) => (
                                <option
                                    key={job.id}
                                    value={job.id}
                                    disabled={appliedJobIds.has(job.id)}
                                >
                                    {job.clientName ? `${job.clientName} — ` : ''}
                                    {job.title}
                                    {appliedJobIds.has(job.id) ? ' (already applied)' : ''}
                                </option>
                            ))}
                        </select>
                    </div>
                    {error ? (
                        <p role="alert" className="text-sm text-destructive">
                            {error}
                        </p>
                    ) : null}
                    {duplicateApplicationId ? (
                        <p className="text-xs text-muted-foreground">
                            Existing application: {duplicateApplicationId}
                        </p>
                    ) : null}
                    <DialogFooter>
                        <Button
                            variant="ghost"
                            disabled={pending}
                            onClick={() => setOpen(false)}
                        >
                            Cancel
                        </Button>
                        <Button
                            disabled={pending || jobId === 'none'}
                            onClick={() => void submit()}
                        >
                            {pending ? 'Adding…' : 'Add application'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}

function TagsCard({
    workspace,
    canWrite,
    onChanged,
}: {
    workspace: Workspace;
    canWrite: boolean;
    onChanged?: () => void;
}) {
    const router = useRouter();
    const refresh = () => (onChanged ? onChanged() : router.refresh());
    const candidate = workspace.candidate;
    const vocabulary = workspace.context?.tags ?? [];
    const [draft, setDraft] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');

    const saveTags = async (tags: string[]) => {
        if (pending) return;
        setPending(true);
        setError('');
        try {
            const response = await fetch(
                `/api/staff/candidates/${candidate.candidateId}`,
                {
                    method: 'PATCH',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        fields: {
                            fullName: candidate.fullName,
                            headline: candidate.headline ?? null,
                            location: candidate.location ?? null,
                            email: candidate.email ?? null,
                            professionalUrl: candidate.professionalUrl ?? null,
                            ownerMembershipId: candidate.ownerMembershipId ?? null,
                            professionalSummary: candidate.professionalSummary ?? null,
                            availability: candidate.availability === 'open' ? 'open' : 'not_specified',
                            tags,
                            skills: candidate.skills ?? [],
                            experience: candidate.experience ?? [],
                            source: 'manual',
                        },
                        expectedVersion: candidate.version,
                        operationId: crypto.randomUUID(),
                    }),
                },
            );
            if (!response.ok) {
                const payload = await response.json().catch(() => ({}));
                setError(
                    response.status === 409
                        ? 'This record changed elsewhere. Reload and try again.'
                        : payload.error ?? 'Tags could not be saved.',
                );
                return;
            }
            setDraft('');
            refresh();
        } catch {
            setError('Tags could not be saved.');
        } finally {
            setPending(false);
        }
    };

    const tags = candidate.tags ?? [];

    const toggleTag = (tag: string, checked: boolean | 'indeterminate') => {
        void saveTags(
            checked === true
                ? [...tags, tag]
                : tags.filter((entry) => entry !== tag),
        );
    };

    const addCustomTag = () => {
        const value = draft.trim();
        if (!value) return;
        if (tags.some((tag) => tag.toLowerCase() === value.toLowerCase())) {
            setDraft('');
            return;
        }
        void saveTags([...tags, value]);
    };

    return (
        <Card>
            <CardHeader className="flex-row items-center justify-between">
                <CardTitle>Tags</CardTitle>
                {canWrite ? (
                    <Popover>
                        <PopoverTrigger asChild>
                            <Button variant="outline" size="sm" disabled={pending}>
                                Edit tags
                            </Button>
                        </PopoverTrigger>
                        <PopoverContent align="end" className="w-56">
                            <div className="flex flex-col gap-2">
                                {vocabulary.length > 0 ? (
                                    <>
                                        <p className="text-xs font-medium text-muted-foreground">
                                            Shared tag vocabulary
                                        </p>
                                        {vocabulary.map((tag) => (
                                            <label
                                                key={tag}
                                                className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-hover"
                                            >
                                                <Checkbox
                                                    checked={tags.includes(tag)}
                                                    onCheckedChange={(checked) =>
                                                        toggleTag(tag, checked)
                                                    }
                                                />
                                                {tag}
                                            </label>
                                        ))}
                                    </>
                                ) : null}
                                <Label htmlFor="candidate-new-tag">New tag</Label>
                                <div className="flex items-center gap-2">
                                    <Input
                                        id="candidate-new-tag"
                                        value={draft}
                                        maxLength={80}
                                        onChange={(event) =>
                                            setDraft(event.target.value)
                                        }
                                        onKeyDown={(event) => {
                                            if (event.key === 'Enter') {
                                                event.preventDefault();
                                                addCustomTag();
                                            }
                                        }}
                                    />
                                    <Button
                                        size="sm"
                                        disabled={pending || draft.trim() === ''}
                                        onClick={addCustomTag}
                                    >
                                        Add
                                    </Button>
                                </div>
                                {error ? (
                                    <p role="alert" className="text-xs text-destructive">
                                        {error}
                                    </p>
                                ) : null}
                            </div>
                        </PopoverContent>
                    </Popover>
                ) : null}
            </CardHeader>
            <CardContent>
                {tags.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No tags yet.</p>
                ) : (
                    <div className="flex flex-wrap gap-1.5">
                        {tags.map((tag) => (
                            <TagPill key={tag}>
                                {tag}
                                {canWrite ? (
                                    <button
                                        type="button"
                                        aria-label={`Remove tag ${tag}`}
                                        disabled={pending}
                                        className="rounded-full outline-none hover:text-destructive focus-visible:ring-1 focus-visible:ring-ring"
                                        onClick={() =>
                                            void saveTags(
                                                tags.filter((entry) => entry !== tag),
                                            )
                                        }
                                    >
                                        ×
                                    </button>
                                ) : null}
                            </TagPill>
                        ))}
                    </div>
                )}
                {error && !draft ? (
                    <p role="alert" className="mt-2 text-xs text-destructive">
                        {error}
                    </p>
                ) : null}
            </CardContent>
        </Card>
    );
}

function DocumentUploader({
    workspace,
    onUploaded,
}: {
    workspace: Workspace;
    onUploaded: () => void;
}) {
    const candidate = workspace.candidate;
    const [file, setFile] = useState<File | null>(null);
    const [error, setError] = useState('');
    const [duplicateDocumentId, setDuplicateDocumentId] = useState<string | null>(null);
    const [pending, setPending] = useState(false);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const operationIdRef = useRef<string>(crypto.randomUUID());

    const selectFile = (next: File | null) => {
        setDuplicateDocumentId(null);
        if (!next) {
            setFile(null);
            setError('');
            return;
        }
        const validation = validateCvFileMetadata(next);
        if (!validation.ok) {
            setFile(null);
            setError(validation.message ?? 'Choose a valid PDF or DOCX file.');
            return;
        }
        setError('');
        setFile(next);
    };

    const submit = async () => {
        if (!file || pending) return;
        setPending(true);
        setError('');
        setDuplicateDocumentId(null);
        try {
            const formData = new FormData();
            formData.set('cvFile', file, file.name);
            formData.set('expectedVersion', candidate.version);
            formData.set('operationId', operationIdRef.current);
            const response = await fetch(
                `/api/staff/candidates/${candidate.candidateId}/documents`,
                { method: 'POST', body: formData },
            );
            const payload = await response.json().catch(() => null);
            const result = payload?.result;
            if (result?.status === 'duplicate' && isUuid(result.documentId)) {
                setDuplicateDocumentId(result.documentId);
                setError('Already on file — this CV is already attached to the record.');
                return;
            }
            const succeeded = response.ok
                && payload?.ok === true
                && (result?.status === 'created' || result?.status === 'replayed')
                && isUuid(result?.documentId);
            if (!succeeded) {
                setError(
                    response.status === 409
                        ? 'This record changed elsewhere. Reload and try again.'
                        : response.status === 403
                          ? 'You do not have permission to upload documents.'
                          : response.status === 401 || response.status === 428
                            ? 'Your session expired. Sign in again.'
                            : payloadErrorText(payload) ?? 'Upload failed.',
                );
                return;
            }
            setFile(null);
            operationIdRef.current = crypto.randomUUID();
            if (inputRef.current) inputRef.current.value = '';
            window.dispatchEvent(new Event('staff-workspace-updated'));
            onUploaded();
        } catch {
            setError('Upload failed. Please try again.');
        } finally {
            setPending(false);
        }
    };

    return (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
            <p className="text-sm font-medium text-foreground">New CV version</p>
            <p className="text-xs text-muted-foreground">
                Uploading replaces the current CV; earlier versions stay on file.
            </p>
            <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="candidate-cv-file">CV file</Label>
                    <Input
                        id="candidate-cv-file"
                        ref={inputRef}
                        type="file"
                        accept={CV_ACCEPT_ATTRIBUTE}
                        onChange={(event) =>
                            selectFile(event.target.files?.[0] ?? null)
                        }
                    />
                </div>
                <Button
                    size="sm"
                    disabled={!file || pending}
                    onClick={() => void submit()}
                >
                    <Upload aria-hidden="true" />
                    {pending ? 'Uploading…' : 'Upload'}
                </Button>
            </div>
            <p className="text-xs text-muted-foreground">
                PDF or DOCX, up to 4 MB. The file content is verified before upload.
            </p>
            {error ? (
                <p role="alert" className="text-sm text-destructive">
                    {error}
                    {duplicateDocumentId ? (
                        <>
                            {' '}
                            <a
                                href={`/api/staff/documents/${duplicateDocumentId}`}
                                className="underline underline-offset-2"
                            >
                                Download existing
                            </a>
                        </>
                    ) : null}
                </p>
            ) : null}
        </div>
    );
}

function payloadErrorText(payload: unknown): string | null {
    if (
        payload
        && typeof payload === 'object'
        && typeof (payload as { error?: unknown }).error === 'string'
    ) {
        return (payload as { error: string }).error;
    }
    return null;
}

function DocumentRow({
    document,
    canDownload,
}: {
    document: DocumentEntry;
    canDownload: boolean;
}) {
    const [previewOpen, setPreviewOpen] = useState(false);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [previewError, setPreviewError] = useState('');
    const [previewPending, setPreviewPending] = useState(false);
    const abortRef = useRef<AbortController | null>(null);
    const isPdf = document.mimeType === 'application/pdf';
    const usable = canDownload && document.lifecycle === 'active';

    useEffect(() => () => {
        abortRef.current?.abort();
    }, [document.documentId]);

    const openPreview = async () => {
        if (!usable || !isPdf || previewPending) return;
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        setPreviewPending(true);
        setPreviewError('');
        try {
            const response = await fetch(
                `/api/staff/documents/${document.documentId}?inline=1&format=json`,
                { signal: controller.signal },
            );
            const payload = await response.json().catch(() => null);
            const url = payload?.url;
            if (
                !response.ok
                || typeof url !== 'string'
                || !/^https?:\/\//.test(url)
            ) {
                setPreviewError(
                    response.status === 401 || response.status === 428
                        ? 'Your session expired. Sign in again.'
                        : response.status === 403
                          ? 'You do not have permission to preview this document.'
                          : 'Preview could not be loaded.',
                );
                return;
            }
            setPreviewUrl(url);
            setPreviewOpen(true);
        } catch (previewFailure) {
            if (!(previewFailure instanceof DOMException
                && previewFailure.name === 'AbortError')) {
                setPreviewError('Preview could not be loaded.');
            }
        } finally {
            setPreviewPending(false);
        }
    };

    const closePreview = () => {
        abortRef.current?.abort();
        setPreviewOpen(false);
        setPreviewUrl(null);
    };

    return (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card px-4 py-3">
            <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                    <FileText
                        className="h-4 w-4 text-muted-foreground"
                        aria-hidden="true"
                    />
                    <div className="flex flex-col">
                        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                            {document.filename}
                            {document.current ? (
                                <Badge variant="secondary">Current</Badge>
                            ) : null}
                            {document.version ? (
                                <span className="text-xs text-muted-foreground">
                                    v{document.version}
                                </span>
                            ) : null}
                        </span>
                        <span className="text-xs text-muted-foreground">
                            {document.purpose.toUpperCase()} ·{' '}
                            {formatDate(document.receivedAt)} ·{' '}
                            {Math.round(document.sizeBytes / 1024)} KB ·{' '}
                            {document.mimeType === 'application/pdf' ? 'PDF' : 'DOCX'} ·{' '}
                            scan: {document.scanState}
                        </span>
                    </div>
                </div>
                {usable ? (
                    <div className="flex items-center gap-2">
                        {isPdf ? (
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={previewPending}
                                onClick={() =>
                                    previewOpen ? closePreview() : void openPreview()}
                            >
                                {previewPending
                                    ? 'Loading…'
                                    : previewOpen ? 'Close preview' : 'Preview'}
                            </Button>
                        ) : null}
                        <Button variant="outline" size="sm" asChild>
                            <a href={`/api/staff/documents/${document.documentId}`}>
                                Download
                            </a>
                        </Button>
                    </div>
                ) : null}
            </div>
            {!isPdf && usable ? (
                <p className="text-xs text-muted-foreground">
                    Preview unavailable for this file; download to view.
                </p>
            ) : null}
            {previewError ? (
                <p role="alert" className="text-xs text-destructive">
                    {previewError}
                </p>
            ) : null}
            {previewOpen && previewUrl ? (
                <iframe
                    title={`CV preview — ${document.filename}`}
                    src={previewUrl}
                    className="h-[70vh] w-full rounded-md border border-border bg-white"
                />
            ) : null}
        </div>
    );
}

function DocumentsPanel({
    documents,
    canDownload,
}: {
    documents: DocumentEntry[];
    canDownload: boolean;
}) {
    const currentId = documents.find((entry) => entry.current)?.documentId
        ?? documents[0]?.documentId
        ?? '';
    const [selectedId, setSelectedId] = useState(currentId);
    const previousCurrentRef = useRef(currentId);
    useEffect(() => {
        if (previousCurrentRef.current !== currentId) {
            previousCurrentRef.current = currentId;
            setSelectedId(currentId);
        }
    }, [currentId]);
    const selected = documents.find((entry) => entry.documentId === selectedId)
        ?? documents.find((entry) => entry.documentId === currentId)
        ?? null;

    return (
        <div className="flex flex-col gap-3">
            <div className="flex max-w-sm flex-col gap-1.5">
                <Label htmlFor="candidate-doc-version">View version</Label>
                <select
                    id="candidate-doc-version"
                    className={nativeSelectClass}
                    value={selected?.documentId ?? ''}
                    onChange={(event) => setSelectedId(event.target.value)}
                >
                    {documents.map((document) => (
                        <option
                            key={document.documentId}
                            value={document.documentId}
                        >
                            v{document.version ?? '—'} — {document.filename}
                            {document.current ? ' (current)' : ''}
                        </option>
                    ))}
                </select>
            </div>
            {selected ? (
                <DocumentRow
                    key={selected.documentId}
                    document={selected}
                    canDownload={canDownload}
                />
            ) : null}
        </div>
    );
}

const DETAIL_TABS = ['overview', 'applications', 'documents', 'notes'] as const;

export function CandidateDetail({
    workspace,
    embedded = false,
    onChanged,
}: {
    workspace: Workspace;
    embedded?: boolean;
    onChanged?: () => void;
}) {
    const router = useRouter();
    const { candidate, applications, stages, documents, notes, capabilities } =
        workspace;
    const refresh = () => (onChanged ? onChanged() : router.refresh());
    const [embeddedTab, setEmbeddedTab] = useState('overview');
    const searchParams = useSearchParams();
    const pathname = usePathname();
    const requestedTab = searchParams.get('tab') ?? '';
    const tab = embedded
        ? ((DETAIL_TABS as readonly string[]).includes(embeddedTab)
            ? embeddedTab
            : 'overview')
        : (DETAIL_TABS as readonly string[]).includes(requestedTab)
          ? requestedTab
          : 'overview';
    const setTab = (value: string) => {
        if (embedded) {
            setEmbeddedTab(value);
            return;
        }
        const params = new URLSearchParams(searchParams.toString());
        if (value === 'overview') {
            params.delete('tab');
        } else {
            params.set('tab', value);
        }
        const queryString = params.toString();
        window.history.replaceState(
            null, '', `${pathname}${queryString ? `?${queryString}` : ''}`);
    };
    const goToNotes = () => {
        setTab('notes');
        window.setTimeout(
            () => document.getElementById('note-body')?.focus(), 0);
    };
    const name = candidate.fullName ?? 'Unnamed candidate';
    const canWrite = capabilities.writeCandidates === true;

    return (
        <div className="flex flex-col gap-6">
            {!embedded ? (
                <Link
                    href="/staff/candidates"
                    className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground"
                >
                    <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                    Back to candidates
                </Link>
            ) : null}
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex items-center gap-4">
                    <InitialsAvatar name={name} />
                    <div className="flex flex-col gap-1">
                        {!embedded ? (
                            <h1 className="text-[26px] leading-8 font-medium text-foreground">
                                {name}
                            </h1>
                        ) : (
                            <p className="text-base font-medium text-foreground">{name}</p>
                        )}
                        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                            {candidate.headline ? <span>{candidate.headline}</span> : null}
                            {candidate.location ? <span>· {candidate.location}</span> : null}
                            {candidate.availability === 'open' ? (
                                <Badge variant="success">Open to offers</Badge>
                            ) : null}
                        </div>
                        <div className="flex items-center gap-2">
                            <Badge variant="secondary">
                                Owner: {candidate.ownerName ?? 'Unassigned'}
                            </Badge>
                            <Badge variant="outline">
                                {sourceLabel(candidate.source)}
                            </Badge>
                        </div>
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {canWrite ? (
                        <>
                            {capabilities.addApplications ? (
                                <AddToJobDialog
                                    workspace={workspace}
                                    onChanged={onChanged}
                                />
                            ) : null}
                            <EditProfileDialog
                                workspace={workspace}
                                onChanged={onChanged}
                            />
                        </>
                    ) : null}
                    {capabilities.writeNotes ? (
                        <Button onClick={goToNotes}>
                            <Plus aria-hidden="true" />
                            Add note
                        </Button>
                    ) : null}
                </div>
            </div>

            <Tabs value={tab} onValueChange={setTab}>
                <TabsList
                    aria-label="Candidate sections"
                    className="grid grid-cols-2 sm:flex"
                >
                    <TabsTrigger value="overview">Overview</TabsTrigger>
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

                <TabsContent value="overview">
                    <div className="grid gap-6 pt-4 lg:grid-cols-3">
                        <div className="flex flex-col gap-6 lg:col-span-2">
                            <Card>
                                <CardHeader>
                                    <CardTitle>Candidate summary</CardTitle>
                                </CardHeader>
                                <CardContent>
                                    <CandidateSummary
                                        candidate={{
                                            summary:
                                                candidate.professionalSummary ?? '',
                                            experience:
                                                candidate.experience ?? [],
                                            skills: candidate.skills ?? [],
                                        }}
                                    />
                                </CardContent>
                            </Card>
                            <Card>
                                <CardHeader>
                                    <CardTitle>Applications</CardTitle>
                                </CardHeader>
                                <CardContent className="flex flex-col gap-3">
                                    {!capabilities.readApplications ? (
                                        <p className="flex items-center gap-2 text-sm text-muted-foreground">
                                            <Lock
                                                className="h-4 w-4"
                                                aria-hidden="true"
                                            />
                                            Application details require the
                                            applications.read permission.
                                        </p>
                                    ) : applications.length === 0 ? (
                                        <p className="text-sm text-muted-foreground">
                                            No applications yet for this candidate.
                                        </p>
                                    ) : (
                                        applications.map((application) => (
                                            <div
                                                key={application.applicationId}
                                                className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"
                                            >
                                                <div className="flex min-w-0 flex-col">
                                                    {application.jobId ? (
                                                        <Link
                                                            href={`/staff/jobs/${application.jobId}`}
                                                            className="w-fit truncate rounded-sm text-sm font-medium text-foreground outline-none hover:text-accent-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                                                        >
                                                            {application.jobTitle}
                                                        </Link>
                                                    ) : (
                                                        <span className="truncate text-sm font-medium text-foreground">
                                                            {application.jobTitle}
                                                        </span>
                                                    )}
                                                    <span className="text-xs text-muted-foreground">
                                                        {application.clientId ? (
                                                            <Link
                                                                href={`/staff/clients/${application.clientId}`}
                                                                className="rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                                                            >
                                                                {application.clientName}
                                                            </Link>
                                                        ) : (
                                                            application.clientName
                                                        )}{' '}
                                                        · Received{' '}
                                                        {formatDate(application.receivedAt)}
                                                    </span>
                                                    <span className="text-xs text-muted-foreground">
                                                        Owner ·{' '}
                                                        {application.ownerName
                                                            ?? candidate.ownerName
                                                            ?? 'Unassigned'}{' '}
                                                        · Source ·{' '}
                                                        {sourceLabel(
                                                            application.source
                                                                ?? candidate.source,
                                                        )}
                                                    </span>
                                                </div>
                                                <Badge
                                                    variant={
                                                        KIND_TONE[application.stageKind]
                                                        ?? 'secondary'
                                                    }
                                                >
                                                    {application.stageLabel}
                                                </Badge>
                                            </div>
                                        ))
                                    )}
                                </CardContent>
                            </Card>
                        </div>
                        <div className="flex flex-col gap-6">
                            <Card>
                                <CardHeader>
                                    <CardTitle>Details</CardTitle>
                                </CardHeader>
                                <CardContent>
                                    <dl className="flex flex-col gap-3">
                                        <FieldLabel label="Owner">
                                            {candidate.ownerName ?? 'Unassigned'}
                                        </FieldLabel>
                                        <FieldLabel label="Source">
                                            {sourceLabel(candidate.source)}
                                        </FieldLabel>
                                        <FieldLabel label="Availability">
                                            {candidate.availability === 'open'
                                                ? 'Open to offers'
                                                : 'Not specified'}
                                        </FieldLabel>
                                        <FieldLabel label="Email">
                                            {candidate.email ?? 'Not provided'}
                                        </FieldLabel>
                                        <FieldLabel label="Location">
                                            {candidate.location ?? 'Not provided'}
                                        </FieldLabel>
                                        <FieldLabel label="Profile URL">
                                            {candidate.professionalUrl ? (
                                                <a
                                                    href={candidate.professionalUrl}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    className="break-all underline underline-offset-4 hover:opacity-70"
                                                >
                                                    {candidate.professionalUrl}
                                                </a>
                                            ) : (
                                                'Not provided'
                                            )}
                                        </FieldLabel>
                                    </dl>
                                </CardContent>
                            </Card>
                            <Card>
                                <CardHeader className="pb-2">
                                    <CardTitle className="flex items-center gap-2 text-base">
                                        <MessageSquareText
                                            className="h-4 w-4 text-muted-foreground"
                                            aria-hidden="true"
                                        />
                                        Recent notes
                                    </CardTitle>
                                </CardHeader>
                                <CardContent className="flex flex-col gap-3">
                                    {capabilities.readNotes === false ? (
                                        <p className="flex items-center gap-2 text-sm text-muted-foreground">
                                            <Lock
                                                className="h-4 w-4"
                                                aria-hidden="true"
                                            />
                                            Notes require the collaboration.read
                                            permission.
                                        </p>
                                    ) : notes.length === 0 ? (
                                        <p className="text-sm text-muted-foreground">
                                            No notes yet.
                                        </p>
                                    ) : (
                                        <ul className="flex flex-col gap-2">
                                            {notes.slice(0, 3).map((entry) => (
                                                <li
                                                    key={entry.noteId}
                                                    className="rounded-lg bg-secondary/50 p-3 text-sm"
                                                >
                                                    <p className="line-clamp-3 whitespace-pre-wrap text-foreground">
                                                        {entry.body}
                                                    </p>
                                                    <p className="mt-1 text-xs text-muted-foreground">
                                                        {entry.authorName ?? 'Staff'} ·{' '}
                                                        {formatDateTime(entry.createdAt)}
                                                    </p>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                                        <button
                                            type="button"
                                            onClick={() => setTab('notes')}
                                            className="w-fit rounded-sm text-xs font-medium text-accent-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                                        >
                                            View all notes ({notes.length})
                                        </button>
                                        {capabilities.writeNotes ? (
                                            <button
                                                type="button"
                                                onClick={goToNotes}
                                                className="w-fit rounded-sm text-xs font-medium text-accent-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                                            >
                                                Add note
                                            </button>
                                        ) : null}
                                    </div>
                                </CardContent>
                            </Card>
                            <TagsCard
                                workspace={workspace}
                                canWrite={canWrite}
                                onChanged={onChanged}
                            />
                        </div>
                    </div>
                </TabsContent>

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
                                                onChanged={onChanged}
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
                    {capabilities.uploadDocuments ? (
                        <DocumentUploader
                            workspace={workspace}
                            onUploaded={refresh}
                        />
                    ) : null}
                    {documents.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No documents on file.</p>
                    ) : (
                        <DocumentsPanel
                            documents={documents}
                            canDownload={capabilities.downloadDocuments === true}
                        />
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
                                <NoteComposer
                                    candidateId={candidate.candidateId}
                                    onSaved={refresh}
                                />
                            ) : null}
                            {notes.length === 0 ? (
                                <p className="text-sm text-muted-foreground">No notes yet.</p>
                            ) : (
                                <ol className="flex flex-col gap-3">
                                    {notes.map((entry) => (
                                        <li
                                            key={entry.noteId}
                                            className="rounded-lg border border-border bg-card px-4 py-3 text-sm"
                                        >
                                            <p className="whitespace-pre-wrap text-foreground">
                                                {entry.body}
                                            </p>
                                            <p className="mt-1 text-xs text-muted-foreground">
                                                {entry.authorName ?? 'Staff'} ·{' '}
                                                {formatDateTime(entry.createdAt)}
                                            </p>
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

export function RestrictedCandidateNotice({
    workspace,
}: {
    workspace: Workspace;
}) {
    const managePrivacy = workspace.capabilities?.managePrivacy === true;
    return (
        <div className="flex flex-col gap-6">
            <Link
                href="/staff/candidates"
                className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground"
            >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                Back to candidates
            </Link>
            <div className="flex items-center gap-4">
                <span
                    aria-hidden="true"
                    className="flex h-12 w-12 items-center justify-center rounded-full bg-restriction text-restriction-foreground"
                >
                    <ShieldAlert className="h-5 w-5" />
                </span>
                <div className="flex flex-col gap-1">
                    <h1 className="text-[26px] leading-8 font-medium text-foreground">
                        Restricted candidate
                    </h1>
                    <p className="font-mono text-xs text-muted-foreground">
                        Record {workspace.candidate.candidateId}
                    </p>
                </div>
            </div>
            <Card>
                <CardContent className="flex flex-col gap-4 py-6">
                    <div className="flex items-start gap-3">
                        <ShieldAlert
                            className="mt-0.5 h-4 w-4 shrink-0 text-restriction-foreground"
                            aria-hidden="true"
                        />
                        <p className={cn('text-sm', 'text-muted-foreground')}>
                            Staff access to this record is restricted. Notes, contact
                            details and documents are hidden from the workspace while
                            the restriction is in place.
                        </p>
                    </div>
                    {managePrivacy ? (
                        <Button variant="outline" className="w-fit" asChild>
                            <Link href="/staff/privacy">
                                <Lock aria-hidden="true" />
                                Open data requests
                            </Link>
                        </Button>
                    ) : null}
                </CardContent>
            </Card>
        </div>
    );
}
