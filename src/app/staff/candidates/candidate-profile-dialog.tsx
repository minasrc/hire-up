'use client';

import { useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Pencil, Plus } from 'lucide-react';

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
import {
    ClientJobContractError,
    isUuid,
    validateCandidateProfileFields,
} from '@/lib/candidate-profile-contracts';

export interface CandidateProfileOptions {
    currentMembershipId: string;
    canWrite: boolean;
    canReviewDuplicates?: boolean;
    owners: { id: string; name: string }[];
}

export interface CandidateProfileValues {
    fullName: string;
    email: string | null;
    professionalUrl: string | null;
    headline: string | null;
    location: string | null;
    ownerMembershipId: string | null;
    professionalSummary: string | null;
}

interface FormDraft {
    fullName: string;
    email: string;
    professionalUrl: string;
    headline: string;
    location: string;
    ownerMembershipId: string;
    professionalSummary: string;
}

const draftFrom = (values: CandidateProfileValues): FormDraft => ({
    fullName: values.fullName,
    email: values.email ?? '',
    professionalUrl: values.professionalUrl ?? '',
    headline: values.headline ?? '',
    location: values.location ?? '',
    ownerMembershipId: values.ownerMembershipId ?? 'none',
    professionalSummary: values.professionalSummary ?? '',
});

const toFields = (draft: FormDraft): CandidateProfileValues => ({
    fullName: draft.fullName.trim(),
    email: draft.email.trim() || null,
    professionalUrl: draft.professionalUrl.trim() || null,
    headline: draft.headline.trim() || null,
    location: draft.location.trim() || null,
    ownerMembershipId:
        draft.ownerMembershipId === 'none' ? null : draft.ownerMembershipId,
    professionalSummary: draft.professionalSummary.trim() === ''
        ? null
        : draft.professionalSummary,
});

function Field({
    label,
    htmlFor,
    required,
    error,
    children,
}: {
    label: string;
    htmlFor: string;
    required?: boolean;
    error?: string;
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
            {error ? (
                <span className="text-xs text-destructive">{error}</span>
            ) : null}
        </div>
    );
}

const selectClass =
    'w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function CandidateProfileDialog({
    mode,
    open,
    onOpenChange,
    options,
    initial,
    candidateId,
    expectedVersion,
    onSaved,
}: {
    mode: 'create' | 'edit';
    open: boolean;
    onOpenChange: (open: boolean) => void;
    options: CandidateProfileOptions;
    initial: CandidateProfileValues;
    candidateId?: string;
    expectedVersion?: string;
    onSaved: (candidateId: string) => void;
}) {
    const [draft, setDraft] = useState<FormDraft>(() => draftFrom(initial));
    const [error, setError] = useState('');
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
    const [duplicateCandidateId, setDuplicateCandidateId] =
        useState<string | null>(null);
    const [pending, setPending] = useState(false);
    const busyRef = useRef(false);
    const operationIdRef = useRef<string>(crypto.randomUUID());
    const targetRef = useRef({ candidateId, expectedVersion });
    const field = (name: string) => fieldErrors[`fields.${name}`] ?? fieldErrors[name];

    const reset = () => {
        setDraft(draftFrom(initial));
        setError('');
        setFieldErrors({});
        setDuplicateCandidateId(null);
        setPending(false);
        operationIdRef.current = crypto.randomUUID();
    };

    const applyFailure = (payload: Record<string, unknown>) => {
        const fields = payload?.fields;
        if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
            setFieldErrors(
                Object.fromEntries(
                    Object.entries(fields).filter(
                        (entry): entry is [string, string] =>
                            typeof entry[1] === 'string'),
                ),
            );
        }
    };

    const submit = async () => {
        if (busyRef.current) return;
        busyRef.current = true;
        setPending(true);
        setError('');
        setFieldErrors({});
        setDuplicateCandidateId(null);
        const { candidateId: targetId, expectedVersion: targetVersion } =
            targetRef.current;
        try {
            let fields;
            try {
                fields = validateCandidateProfileFields(toFields(draft));
            } catch (caught) {
                if (caught instanceof ClientJobContractError) {
                    setFieldErrors(caught.fieldErrors);
                    setError('Check the highlighted fields.');
                    return;
                }
                throw caught;
            }
            const response = mode === 'create'
                ? await fetch('/api/staff/candidates', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        action: 'createCandidate',
                        fields,
                        operationId: operationIdRef.current,
                    }),
                })
                : await fetch(
                    `/api/staff/candidates/${encodeURIComponent(targetId ?? '')}`,
                    {
                        method: 'PATCH',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({
                            fields,
                            expectedVersion: targetVersion,
                            operationId: operationIdRef.current,
                        }),
                    });
            const payload = await response.json().catch(() => null);
            if (
                response.status === 409
                && payload?.code === 'DUPLICATE_CANDIDATE'
                && isUuid(payload?.candidateId)
            ) {
                setDuplicateCandidateId(payload.candidateId);
                setError('A candidate with this email already exists.');
                return;
            }
            if (response.status === 409 && payload?.code === '40001') {
                setError(
                    'This profile changed since you opened it. Reload the page and try again — your entries are still here.');
                return;
            }
            const succeeded = response.ok
                && payload?.ok === true
                && isUuid(payload?.result?.candidateId)
                && (payload.result.status === 'created'
                    || payload.result.status === 'updated');
            if (!succeeded) {
                applyFailure(payload ?? {});
                setError(
                    response.status === 401 || response.status === 428
                        ? 'Your session expired. Sign in again.'
                        : response.status === 403
                          ? 'You do not have permission to save this candidate.'
                          : response.status === 503
                            ? 'Profile editing is temporarily unavailable.'
                            : typeof payload?.error === 'string'
                              ? payload.error
                              : 'Could not save the candidate.');
                return;
            }
            window.dispatchEvent(new Event('staff-workspace-updated'));
            onOpenChange(false);
            onSaved(payload.result.candidateId);
        } catch {
            setError('Could not save the candidate. Please try again.');
        } finally {
            busyRef.current = false;
            setPending(false);
        }
    };

    const patch = (partial: Partial<FormDraft>) => {
        setDraft((current) => ({ ...current, ...partial }));
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (pending) return;
                onOpenChange(next);
                if (!next) reset();
            }}
        >
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>
                        {mode === 'create' ? 'Add candidate' : 'Edit profile'}
                    </DialogTitle>
                    <DialogDescription>
                        {mode === 'create'
                            ? 'Create a candidate profile manually. All fields except the name are optional.'
                            : 'Update the candidate profile.'}
                    </DialogDescription>
                </DialogHeader>
                <fieldset
                    disabled={pending}
                    className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0"
                >
                <div className="grid gap-4 sm:grid-cols-2">
                    <Field
                        label="Full name"
                        htmlFor={`${mode}-candidate-name`}
                        required
                        error={field('fullName')}
                    >
                        <Input
                            id={`${mode}-candidate-name`}
                            value={draft.fullName}
                            maxLength={120}
                            onChange={(event) =>
                                patch({ fullName: event.target.value })}
                        />
                    </Field>
                    <Field
                        label="Email"
                        htmlFor={`${mode}-candidate-email`}
                        error={field('email')}
                    >
                        <Input
                            id={`${mode}-candidate-email`}
                            type="email"
                            value={draft.email}
                            maxLength={254}
                            onChange={(event) =>
                                patch({ email: event.target.value })}
                        />
                    </Field>
                    <Field
                        label="Role / headline"
                        htmlFor={`${mode}-candidate-headline`}
                        error={field('headline')}
                    >
                        <Input
                            id={`${mode}-candidate-headline`}
                            value={draft.headline}
                            maxLength={200}
                            onChange={(event) =>
                                patch({ headline: event.target.value })}
                        />
                    </Field>
                    <Field
                        label="Location"
                        htmlFor={`${mode}-candidate-location`}
                        error={field('location')}
                    >
                        <Input
                            id={`${mode}-candidate-location`}
                            value={draft.location}
                            maxLength={200}
                            onChange={(event) =>
                                patch({ location: event.target.value })}
                        />
                    </Field>
                    <Field
                        label="Profile URL"
                        htmlFor={`${mode}-candidate-url`}
                        error={field('professionalUrl')}
                    >
                        <Input
                            id={`${mode}-candidate-url`}
                            type="url"
                            value={draft.professionalUrl}
                            maxLength={2048}
                            onChange={(event) =>
                                patch({ professionalUrl: event.target.value })}
                        />
                    </Field>
                    <Field
                        label="Owner"
                        htmlFor={`${mode}-candidate-owner`}
                        error={field('ownerMembershipId')}
                    >
                        <select
                            id={`${mode}-candidate-owner`}
                            className={selectClass}
                            value={draft.ownerMembershipId}
                            onChange={(event) =>
                                patch({ ownerMembershipId: event.target.value })}
                        >
                            <option value="none">Unassigned</option>
                            {options.owners.map((owner) => (
                                <option key={owner.id} value={owner.id}>
                                    {owner.name}
                                </option>
                            ))}
                        </select>
                    </Field>
                </div>
                <Field
                    label="Professional summary"
                    htmlFor={`${mode}-candidate-summary`}
                    error={field('professionalSummary')}
                >
                    <Textarea
                        id={`${mode}-candidate-summary`}
                        rows={4}
                        maxLength={8000}
                        value={draft.professionalSummary}
                        onChange={(event) =>
                            patch({ professionalSummary: event.target.value })}
                    />
                </Field>
                </fieldset>
                {error ? (
                    <p role="alert" className="text-sm text-destructive">
                        {error}
                        {duplicateCandidateId ? (
                            <>
                                {' '}
                                <Link
                                    href={`/staff/candidates/${duplicateCandidateId}`}
                                    className="underline underline-offset-4"
                                >
                                    Open existing
                                </Link>
                            </>
                        ) : null}
                    </p>
                ) : null}
                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                        disabled={pending}
                    >
                        Cancel
                    </Button>
                    <Button
                        onClick={submit}
                        disabled={pending || draft.fullName.trim() === ''}
                    >
                        {pending
                            ? 'Saving…'
                            : mode === 'create'
                              ? 'Add candidate'
                              : 'Save changes'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

export function AddCandidateDialog({
    options,
    onCreated,
}: {
    options: CandidateProfileOptions;
    onCreated: (candidateId: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const empty: CandidateProfileValues = {
        fullName: '',
        email: null,
        professionalUrl: null,
        headline: null,
        location: null,
        ownerMembershipId: options.currentMembershipId,
        professionalSummary: null,
    };
    return (
        <>
            <Button size="sm" onClick={() => setOpen(true)}>
                <Plus aria-hidden="true" />
                Add candidate
            </Button>
            {open ? (
                <CandidateProfileDialog
                    mode="create"
                    open={open}
                    onOpenChange={setOpen}
                    options={options}
                    initial={empty}
                    onSaved={onCreated}
                />
            ) : null}
        </>
    );
}

export function EditCandidateProfileButton({
    options,
    candidate,
    candidateId,
    version,
    onSaved,
}: {
    options: CandidateProfileOptions;
    candidate: CandidateProfileValues;
    candidateId: string;
    version: string;
    onSaved: () => void;
}) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <Button
                variant="outline"
                size="sm"
                onClick={() => setOpen(true)}
            >
                <Pencil aria-hidden="true" />
                Edit profile
            </Button>
            {open ? (
                <CandidateProfileDialog
                    mode="edit"
                    open={open}
                    onOpenChange={setOpen}
                    options={options}
                    initial={candidate}
                    candidateId={candidateId}
                    expectedVersion={version}
                    onSaved={onSaved}
                />
            ) : null}
        </>
    );
}
