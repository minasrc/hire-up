'use client';

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/staff-ui/button';
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
import { Textarea } from '@/components/staff-ui/textarea';
import { RequiredMark } from '@/components/staff-preview/shared';
import { CV_ACCEPT_ATTRIBUTE, validateCvFileMetadata } from '@/lib/application';
import { isUuid } from '@/lib/recruitment-contracts';
import type {
    CandidateExperienceEntry,
    CandidateFields,
    RecruitmentContext,
} from '@/lib/recruitment-types';
import { useUnsavedChangesGuard } from '../form-guard';

interface ExperienceDraft extends CandidateExperienceEntry {
    _key: string;
}

interface FormDraft {
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
    experience: ExperienceDraft[];
    jobId: string;
    note: string;
}

const emptyDraft = (ownerMembershipId: string): FormDraft => ({
    fullName: '',
    headline: '',
    location: '',
    email: '',
    professionalUrl: '',
    professionalSummary: '',
    availability: 'not_specified',
    tags: '',
    skills: '',
    ownerMembershipId,
    experience: [],
    jobId: 'none',
    note: '',
});

const parseList = (value: string) =>
    value.split(',').map((entry) => entry.trim()).filter(Boolean);

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
            <Label htmlFor={htmlFor}>
                {label}
                {required ? (
                    <>
                        {' '}
                        <RequiredMark />
                    </>
                ) : null}
            </Label>
            {children}
        </div>
    );
}

const selectClass =
    'w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function AddCandidateDialog({
    context,
    onCreated,
}: {
    context: RecruitmentContext;
    onCreated: (candidateId: string) => void;
}) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState<FormDraft>(() =>
        emptyDraft(context.currentMembershipId));
    const [cvFile, setCvFile] = useState<File | null>(null);
    const [fileError, setFileError] = useState('');
    const [error, setError] = useState('');
    const [duplicateCandidateId, setDuplicateCandidateId] = useState<string | null>(null);
    const [pending, setPending] = useState(false);
    const operationIdRef = useRef<string>(crypto.randomUUID());
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    const capabilities = context.capabilities;
    const openJobs = useMemo(
        () => context.jobs.filter((job) => job.applicationState === 'open'),
        [context.jobs],
    );
    const canAddJob = capabilities.addApplications === true;
    const canUpload = capabilities.uploadDocuments === true;
    const canSubmit = capabilities.writeCandidates === true;
    const dirty =
        open
        && (cvFile !== null
            || JSON.stringify(draft)
                !== JSON.stringify(emptyDraft(context.currentMembershipId)));
    useUnsavedChangesGuard({ dirty });

    const reset = () => {
        setDraft(emptyDraft(context.currentMembershipId));
        setCvFile(null);
        setFileError('');
        setError('');
        setDuplicateCandidateId(null);
        setPending(false);
        operationIdRef.current = crypto.randomUUID();
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const onFileChange = (file: File | null) => {
        setFileError('');
        setCvFile(null);
        if (!file) return;
        const validation = validateCvFileMetadata(file);
        if (!validation.ok) {
            setFileError(validation.message ?? 'Choose a valid PDF or DOCX file.');
            return;
        }
        setCvFile(file);
    };

    const toFields = (): CandidateFields => ({
        fullName: draft.fullName.trim(),
        headline: draft.headline.trim() || null,
        location: draft.location.trim() || null,
        email: draft.email.trim() || null,
        professionalUrl: draft.professionalUrl.trim() || null,
        ownerMembershipId:
            draft.ownerMembershipId === 'none' ? null : draft.ownerMembershipId,
        professionalSummary: draft.professionalSummary.trim() || null,
        availability: draft.availability,
        tags: parseList(draft.tags),
        skills: parseList(draft.skills),
        experience: draft.experience.map((entry) => ({
            role: entry.role,
            company: entry.company,
            period: entry.period,
            description: entry.description,
        })),
        source: 'manual',
    });

    const submit = async () => {
        if (pending || !canSubmit || draft.fullName.trim() === ''
            || fileError !== '') return;
        setPending(true);
        setError('');
        setDuplicateCandidateId(null);
        try {
            const formData = new FormData();
            formData.set('action', 'createCandidate');
            formData.set('fields', JSON.stringify(toFields()));
            if (draft.jobId !== 'none') formData.set('jobId', draft.jobId);
            if (draft.note.trim() !== '') formData.set('note', draft.note.trim());
            formData.set('operationId', operationIdRef.current);
            if (cvFile) formData.set('cvFile', cvFile, cvFile.name);
            const response = await fetch('/api/staff/candidates', {
                method: 'POST',
                body: formData,
            });
            const payload = await response.json().catch(() => null);
            const result = payload?.result;
            if (
                response.status === 409
                && result?.status === 'duplicate'
                && isUuid(result.candidateId)
            ) {
                setDuplicateCandidateId(result.candidateId);
                setError('A candidate with this email already exists.');
                return;
            }
            const succeeded =
                response.ok
                && payload?.ok === true
                && isUuid(result?.candidateId)
                && (result?.status === 'created' || result?.status === 'replayed');
            if (!succeeded) {
                const fieldMessages =
                    payload?.fields && typeof payload.fields === 'object'
                        ? Object.values(payload.fields)
                            .filter((value): value is string => typeof value === 'string')
                            .join(' ')
                        : '';
                setError(
                    response.status === 401 || response.status === 428
                        ? 'Your session expired. Sign in again.'
                        : response.status === 403
                          ? 'You do not have permission to create this candidate.'
                          : fieldMessages !== ''
                            ? fieldMessages
                            : typeof payload?.error === 'string'
                              ? payload.error
                              : 'Could not create the candidate.',
                );
                return;
            }
            window.dispatchEvent(new Event('staff-workspace-updated'));
            router.refresh();
            setOpen(false);
            reset();
            onCreated(result.candidateId);
        } catch {
            setError('Could not create the candidate. Please try again.');
        } finally {
            setPending(false);
        }
    };

    const updateExperience = (index: number, patch: Partial<ExperienceDraft>) => {
        setDraft((current) => ({
            ...current,
            experience: current.experience.map((entry, position) =>
                position === index ? { ...entry, ...patch } : entry),
        }));
    };

    const patch = (partial: Partial<FormDraft>) => {
        setDraft((current) => ({ ...current, ...partial }));
    };

    return (
        <>
            <Button size="sm" onClick={() => setOpen(true)}>
                <Plus aria-hidden="true" />
                Add candidate
            </Button>
            <Dialog
                open={open}
                onOpenChange={(next) => {
                    if (pending) return;
                    setOpen(next);
                    if (!next) reset();
                }}
            >
                <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>Add candidate</DialogTitle>
                        <DialogDescription>
                            Create a candidate profile manually. All fields except the
                            name are optional.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <Field label="Full name" htmlFor="add-candidate-name" required>
                            <Input
                                id="add-candidate-name"
                                value={draft.fullName}
                                maxLength={120}
                                onChange={(event) => patch({ fullName: event.target.value })}
                            />
                        </Field>
                        <Field label="Email" htmlFor="add-candidate-email">
                            <Input
                                id="add-candidate-email"
                                type="email"
                                value={draft.email}
                                maxLength={254}
                                onChange={(event) => patch({ email: event.target.value })}
                            />
                        </Field>
                        <Field label="Role / headline" htmlFor="add-candidate-headline">
                            <Input
                                id="add-candidate-headline"
                                value={draft.headline}
                                maxLength={200}
                                onChange={(event) => patch({ headline: event.target.value })}
                            />
                        </Field>
                        <Field label="Location" htmlFor="add-candidate-location">
                            <Input
                                id="add-candidate-location"
                                value={draft.location}
                                maxLength={200}
                                onChange={(event) => patch({ location: event.target.value })}
                            />
                        </Field>
                        <Field label="Profile URL" htmlFor="add-candidate-url">
                            <Input
                                id="add-candidate-url"
                                type="url"
                                value={draft.professionalUrl}
                                maxLength={2048}
                                onChange={(event) =>
                                    patch({ professionalUrl: event.target.value })
                                }
                            />
                        </Field>
                        <Field label="Availability" htmlFor="add-candidate-availability">
                            <select
                                id="add-candidate-availability"
                                className={selectClass}
                                value={draft.availability}
                                onChange={(event) =>
                                    patch({
                                        availability: event.target.value as
                                            FormDraft['availability'],
                                    })
                                }
                            >
                                <option value="not_specified">Not specified</option>
                                <option value="open">Open to offers</option>
                            </select>
                        </Field>
                        <Field label="Owner" htmlFor="add-candidate-owner">
                            <select
                                id="add-candidate-owner"
                                className={selectClass}
                                value={draft.ownerMembershipId}
                                onChange={(event) =>
                                    patch({ ownerMembershipId: event.target.value })
                                }
                            >
                                <option value="none">Unassigned</option>
                                {context.owners.map((owner) => (
                                    <option key={owner.id} value={owner.id}>
                                        {owner.name}
                                    </option>
                                ))}
                            </select>
                        </Field>
                        <Field label="Tags (comma separated)" htmlFor="add-candidate-tags">
                            <Input
                                id="add-candidate-tags"
                                value={draft.tags}
                                onChange={(event) => patch({ tags: event.target.value })}
                            />
                        </Field>
                        <Field label="Skills (comma separated)" htmlFor="add-candidate-skills">
                            <Input
                                id="add-candidate-skills"
                                value={draft.skills}
                                onChange={(event) => patch({ skills: event.target.value })}
                            />
                        </Field>
                    </div>
                    <Field label="Professional summary" htmlFor="add-candidate-summary">
                        <Textarea
                            id="add-candidate-summary"
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
                                            updateExperience(index, {
                                                role: event.target.value,
                                            })
                                        }
                                    />
                                    <Input
                                        aria-label={`Experience ${index + 1} company`}
                                        placeholder="Company"
                                        value={entry.company}
                                        onChange={(event) =>
                                            updateExperience(index, {
                                                company: event.target.value,
                                            })
                                        }
                                    />
                                    <Input
                                        aria-label={`Experience ${index + 1} period`}
                                        placeholder="Period"
                                        value={entry.period}
                                        onChange={(event) =>
                                            updateExperience(index, {
                                                period: event.target.value,
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
                                            updateExperience(index, {
                                                description: event.target.value,
                                            })
                                        }
                                    />
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        aria-label={`Remove experience ${index + 1}`}
                                        onClick={() =>
                                            patch({
                                                experience: draft.experience.filter(
                                                    (_, position) => position !== index,
                                                ),
                                            })
                                        }
                                    >
                                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                                    </Button>
                                </div>
                            </div>
                        ))}
                    </div>

                    {canAddJob || canUpload ? (
                        <div className="grid gap-4 sm:grid-cols-2">
                            {canAddJob ? (
                                <Field label="Add to job" htmlFor="add-candidate-job">
                                    <select
                                        id="add-candidate-job"
                                        className={selectClass}
                                        value={draft.jobId}
                                        onChange={(event) =>
                                            patch({ jobId: event.target.value })}
                                    >
                                        <option value="none">No application</option>
                                        {openJobs.map((job) => (
                                            <option key={job.id} value={job.id}>
                                                {job.clientName ? `${job.clientName} — ` : ''}
                                                {job.title}
                                            </option>
                                        ))}
                                    </select>
                                </Field>
                            ) : null}
                            {canUpload ? (
                                <Field label="CV (PDF or DOCX, max 4 MB)" htmlFor="add-candidate-cv">
                                    <Input
                                        id="add-candidate-cv"
                                        ref={fileInputRef}
                                        type="file"
                                        accept={CV_ACCEPT_ATTRIBUTE}
                                        onChange={(event) =>
                                            onFileChange(event.target.files?.[0] ?? null)
                                        }
                                    />
                                </Field>
                            ) : null}
                        </div>
                    ) : null}
                    {fileError ? (
                        <p role="alert" className="text-xs text-destructive">
                            {fileError}
                        </p>
                    ) : null}
                    {cvFile ? (
                        <p className="text-xs text-muted-foreground">
                            Selected file: {cvFile.name} (
                            {Math.ceil(cvFile.size / 1024)} KB)
                        </p>
                    ) : null}

                    {capabilities.writeNotes === true ? (
                        <Field label="Initial note" htmlFor="add-candidate-note">
                            <Textarea
                                id="add-candidate-note"
                                rows={2}
                                maxLength={4000}
                                placeholder="Optional note saved with the candidate…"
                                value={draft.note}
                                onChange={(event) => patch({ note: event.target.value })}
                            />
                        </Field>
                    ) : null}

                    {error ? (
                        <div className="flex flex-col gap-2">
                            <p role="alert" className="text-sm text-destructive">
                                {error}
                            </p>
                            {duplicateCandidateId ? (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="w-fit"
                                    onClick={() => {
                                        setOpen(false);
                                        reset();
                                        onCreated(duplicateCandidateId);
                                    }}
                                >
                                    View existing candidate
                                </Button>
                            ) : null}
                        </div>
                    ) : null}
                    {!canSubmit ? (
                        <p className="text-xs text-muted-foreground">
                            Some requested actions need additional permissions — the
                            server will still verify every change.
                        </p>
                    ) : null}
                    <DialogFooter>
                        <Button
                            variant="ghost"
                            disabled={pending}
                            onClick={() => {
                                setOpen(false);
                                reset();
                            }}
                        >
                            Cancel
                        </Button>
                        <Button
                            disabled={
                                pending || draft.fullName.trim() === '' || !canSubmit
                                || fileError !== ''
                            }
                            onClick={() => void submit()}
                        >
                            {pending ? 'Creating…' : 'Add candidate'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
