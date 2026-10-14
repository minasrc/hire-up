"use client";

import Link from 'next/link';
import { BONUS_TYPE_LABELS } from '@/components/staff-preview/demo-data';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/staff-ui/popover';
import { CancelJobButton } from '@/components/staff-preview/cancel-job-button';
import { JobFormSelect } from '@/components/staff-preview/job-form-select';
import { JobCompensation } from '@/components/staff-preview/job-compensation';
import { readJobEditor } from '@/components/staff-preview/read-job-editor';
import { compensationValue, friendlyJobErrors, jobPreviewLocations } from '@/lib/job-form-ui.js';
import { JobDocumentView, canonicalJobDocument } from '@/components/staff-preview/job-document';
import { JobEditorSection, JobEditorNavigation } from '@/components/staff-preview/job-editor-layout';
import { LOCATION_OPTIONS, canonicalLocationLabel } from '@/lib/location-options.js';
import { useUnsavedChangesGuard } from './form-guard';


import { staffWorkspaceUrl, refreshStaffWorkspace } from '@/lib/staff-workspace-fetch';

import { useRouter } from 'next/navigation';
import { useId, useRef, useState, type ReactNode } from 'react';
import { Check, Eye, FileText, MapPin, Briefcase, Coins, Save, Search, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/staff-ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/staff-ui/dialog';
import { Input } from '@/components/staff-ui/input';
import { Label } from '@/components/staff-ui/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/staff-ui/select';
import { RichTextEditor } from '@/components/staff-preview/rich-text-editor';
import { RequiredMark, TagPill } from '@/components/staff-preview/shared';
import {
    BONUS_TYPES,
    EMPTY_JOB_DOCUMENT,
    validateJobDraftInput,
    ClientJobContractError,
} from '@/lib/client-job-contracts.js';
import { staffMutation } from '@/lib/staff-mutation';

function Field({
    label,
    htmlFor,
    required,
    error,
    hint,
    children,
}: {
    label: string;
    htmlFor?: string;
    required?: boolean;
    error?: string;
    hint?: string;
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
                <span
                    id={htmlFor ? `${htmlFor}-error` : undefined}
                    className="text-xs text-destructive"
                >
                    {error}
                </span>
            ) : null}
            {hint ? (
                <span
                    id={htmlFor ? `${htmlFor}-hint` : undefined}
                    className="text-xs text-muted-foreground"
                >
                    {hint}
                </span>
            ) : null}
        </div>
    );
}

const parseList = (value: string) =>
    value.split(',').map((entry) => entry.trim()).filter(Boolean);

const parseListField = (raw: string): string[] => {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
        try {
            const parsed: unknown = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                return parsed
                    .map((entry) => String(entry).trim())
                    .filter(Boolean);
            }
        } catch {
            return parseList(raw);
        }
    }
    return parseList(raw);
};

interface JobBonus { type: string; details: string; }
function LocationEditor({
    label,
    name,
    inputId,
    initial,
    onDirty,
    error,
}: {
    error?: string;
    label: string;
    name: string;
    inputId: string;
    initial?: string[];
    onDirty?: () => void;
}) {
    const listId = useId();
    const [values, setValues] = useState<string[]>(initial ?? []);
    const [draft, setDraft] = useState('');
    const [open, setOpen] = useState(false);
    const [highlighted, setHighlighted] = useState(0);
    const query = draft.trim().toLowerCase();
    const suggestions = query ? LOCATION_OPTIONS
        .filter((option) => option.toLowerCase().includes(query)
            && !values.some((value) => value.toLowerCase() === option.toLowerCase()))
        .sort((left, right) => Number(!left.toLowerCase().startsWith(query)) - Number(!right.toLowerCase().startsWith(query)))
        .slice(0, 8) : [];


    const add = (value = draft) => {
        const canonical = canonicalLocationLabel(value);
        if (!canonical) return;
        onDirty?.();
        setValues((current) =>
            current.some((entry) => entry.toLowerCase() === canonical.toLowerCase())
                ? current
                : [...current, canonical],
        );
        setDraft('');
        setOpen(false);
        setHighlighted(0);
    };

    const pending = canonicalLocationLabel(draft) ?? draft.trim();
    const serialized =
        pending === ''
            ? values
            : values.some((entry) => entry.toLowerCase() === pending.toLowerCase())
              ? values
              : [...values, pending];

    return (
        <Field label={label} htmlFor={inputId} error={error}>
            <input type="hidden" name={name} value={JSON.stringify(serialized)} />
            <div className="flex flex-col gap-2">
                {values.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                        {values.map((value) => (
                            <TagPill key={value}>
                                {value}
                                <button
                                    type="button"
                                    aria-label={`Remove ${value}`}
                                    className="rounded-full outline-none hover:text-destructive focus-visible:ring-1 focus-visible:ring-ring"
                                    onClick={() => {
                                        onDirty?.();
                                        setValues((current) =>
                                            current.filter((entry) => entry !== value),
                                        );
                                    }}
                                >
                                    ×
                                </button>
                            </TagPill>
                        ))}
                    </div>
                ) : null}
                <Popover open={open && query.length > 0} onOpenChange={setOpen}>
                    <PopoverAnchor asChild>
                        <div className="relative">
                            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                            <Input
                                id={inputId}
                                role="combobox"
                                autoComplete="off"
                                aria-autocomplete="list"
                                aria-expanded={open && query.length > 0}
                                aria-controls={listId}
                                aria-activedescendant={open && suggestions[highlighted] ? `${listId}-${highlighted}` : undefined}
                                aria-invalid={error ? true : undefined}
                                aria-describedby={error ? `${inputId}-error` : undefined}
                                value={draft}
                                className="pl-9"
                                placeholder="Search city, country or region"
                                onFocus={() => setOpen(true)}
                                onChange={(event) => {
                                    setDraft(event.target.value);
                                    setOpen(true);
                                    setHighlighted(0);
                                }}
                                onBlur={() => { add(); setOpen(false); }}
                                onKeyDown={(event) => {
                                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                                        event.preventDefault();
                                        setOpen(true);
                                        setHighlighted((index) => suggestions.length
                                            ? (index + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length
                                            : 0);
                                    } else if (event.key === 'Enter') {
                                        event.preventDefault();
                                        add(open ? suggestions[highlighted] ?? draft : draft);
                                    } else if (event.key === 'Escape') {
                                        event.preventDefault();
                                        setOpen(false);
                                    }
                                }}
                            />
                        </div>
                    </PopoverAnchor>
                    <PopoverContent
                        align="start"
                        className="w-[var(--radix-popover-trigger-width)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto p-1"
                        onOpenAutoFocus={(event) => event.preventDefault()}
                        onCloseAutoFocus={(event) => event.preventDefault()}
                        onEscapeKeyDown={() => setOpen(false)}
                    >
                        <div id={listId} role="listbox" aria-label={`${label} suggestions`}>
                            {suggestions.length ? suggestions.map((option, index) => (
                                <button
                                    key={option}
                                    id={`${listId}-${index}`}
                                    type="button"
                                    role="option"
                                    aria-selected={index === highlighted}
                                    tabIndex={-1}
                                    className={`flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-left text-sm outline-none ${index === highlighted ? 'bg-accent text-accent-foreground' : 'text-popover-foreground hover:bg-hover'}`}
                                    onMouseDown={(event) => event.preventDefault()}
                                    onMouseEnter={() => setHighlighted(index)}
                                    onClick={() => add(option)}
                                >
                                    <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                                    {option}
                                </button>
                            )) : <p className="px-3 py-3 text-sm text-muted-foreground">No matching locations</p>}
                        </div>
                    </PopoverContent>
                </Popover>
            </div>
        </Field>
    );
}

export function JobForm({
    clients,
    jobId,
    revisionId,
    expectedVersion,
    preselectedClientId,
    initial,
    previewOnly = false,
}: {
    previewOnly?: boolean;
    clients: { id: string; name: string }[];
    preselectedClientId?: string;
    jobId?: string;
    revisionId?: string;
    expectedVersion?: string;
    initial?: {
        clientId: string;
        title: string;
        employmentType: string | null;
        workplaceMode: string | null;
        locations: string[];
        remoteRegions: string[];
        compensationMin: string | null;
        compensationMax: string | null;
        currency: string | null;
        payPeriod: string | null;
        bonuses?: JobBonus[] | null;
        descriptionDocument?: unknown;
        descriptionText: string;
    };
}) {
    const router = useRouter();
    const formRef = useRef<HTMLFormElement>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [saved, setSaved] = useState(false);
    const [workplaceMode, setWorkplaceMode] = useState(initial?.workplaceMode ?? '');
    const [previewDocument, setPreviewDocument] = useState<unknown>(EMPTY_JOB_DOCUMENT);
    const [preview, setPreview] = useState<Record<string, string> | null>(null);
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
    const submittedFields = useRef<Record<string, unknown>>({});
    const documentRef = useRef<unknown>(
        initial?.descriptionDocument ?? EMPTY_JOB_DOCUMENT,
    );
    const [bonuses, setBonuses] = useState<JobBonus[]>(
        (initial?.bonuses ?? []).map((bonus) => ({
            type: bonus.type,
            details: bonus.details,
        })),
    );

    const submit = async (form: HTMLFormElement): Promise<string> => {
        const data = new FormData(form);
        const nullable = (key: string) => String(data.get(key) ?? '') || null;
        const fields = {
            title: String(data.get('title') ?? ''),
            employmentType: nullable('employmentType'),
            workplaceMode: nullable('workplaceMode'),
            locations: parseListField(String(data.get('locations') ?? '')),
            remoteRegions: workplaceMode === 'onsite' ? [] : parseListField(String(data.get('remoteRegions') ?? '')),
            compensationMin: compensationValue(data.get('compensationMin')) || null,
            compensationMax: compensationValue(data.get('compensationMax')) || null,
            currency: nullable('currency'),
            payPeriod: nullable('payPeriod'),
            bonuses: bonuses
                .map((bonus) => ({ type: bonus.type, details: bonus.details.trim() }))
                .filter((bonus) => bonus.details !== ''),
            descriptionDocument: readJobEditor(form, documentRef.current),
        };
        if (!jobId && !clients.some((client) => client.id === String(data.get('clientId') ?? ''))) {
            throw new ClientJobContractError({ clientId: 'select an active client' });
        }
        submittedFields.current = fields;
        validateJobDraftInput(fields);
        if (previewOnly) return '';
        const url = jobId ? `/api/staff/jobs/${jobId}/draft` : '/api/staff/jobs';
        const payload = await staffMutation(url, {
            fields,
            ...(jobId
                ? { revisionId, expectedVersion }
                : {
                      clientId: String(data.get('clientId') ?? ''),
                      publiclyListed: data.get('publiclyListed') === 'true',
                  }),
        });
        const targetId = jobId ?? payload?.result?.jobId;
        return targetId ? `/staff/jobs/${targetId}` : '/staff/jobs';
    };

    const runSave = async (navigate = true, fromGuard = false): Promise<boolean> => {
        if (!formRef.current || busy) return false;
        if (!formRef.current.reportValidity()) return false;
        setError(null);
        setFieldErrors({});
        setBusy(true);
        try {
            const target = await submit(formRef.current);
            setDirty(false);
            setSaved(true);
            if (!previewOnly && (navigate || (!jobId && !fromGuard))) {
                router.push(staffWorkspaceUrl(target));
                return true;
            }
            if (!previewOnly) refreshStaffWorkspace(router);
            return true;
        } catch (caught) {
            const validationErrors = caught && typeof caught === 'object' && 'fieldErrors' in caught
                ? (caught as { fieldErrors: Record<string, string> }).fieldErrors : null;
            if (validationErrors && Object.keys(validationErrors).length > 0) {
                const messages = friendlyJobErrors(validationErrors, submittedFields.current);
                setFieldErrors(messages);
                const name = Object.keys(messages)[0];
                const controls: Record<string, string> = {
                    clientId: 'job-client', employmentType: 'job-employment-type', workplaceMode: 'job-workplace-mode', currency: 'job-currency', payPeriod: 'job-pay-period',
                    locations: 'job-locations', remoteRegions: 'job-remote-regions',
                };
                requestAnimationFrame(() => {
                    const input = controls[name] ? document.getElementById(controls[name])
                        : formRef.current?.querySelector<HTMLElement>(`[name="${name}"]`);
                    input?.focus();
                });
                setError(null);
            } else {
                setError(caught instanceof Error ? caught.message : 'Could not save. Please try again.');
            }
            return false;
        } finally {
            setBusy(false);
        }
    };

    useUnsavedChangesGuard({ dirty, save: () => runSave(false, true) });

    const updateBonus = (index: number, patch: Partial<JobBonus>) => {
        setDirty(true);
        setBonuses((current) =>
            current.map((bonus, position) =>
                position === index ? { ...bonus, ...patch } : bonus,
            ),
        );
    };

    return (
        <form
            ref={formRef}
            aria-busy={busy}
            className="relative grid min-w-0 gap-6 lg:grid-cols-[220px_minmax(0,1fr)]"
            onChange={(event) => {
                setDirty(true); setSaved(false);
                const name = (event.target as HTMLInputElement).name;
                if (name) setFieldErrors((current) => {
                    const next = { ...current }; delete next[name]; return next;
                });
            }}
            onSubmit={(event) => {
                event.preventDefault();
                formRef.current = event.currentTarget;
                void runSave(true);
            }}
        >
            <JobEditorNavigation />
            <fieldset disabled={busy} className="flex min-w-0 flex-col gap-6">
            <JobEditorSection id="role" number="01" title="Role essentials" icon={Briefcase}>
            {!jobId && (
                <Field label="Client" htmlFor="job-client" error={fieldErrors.clientId} required>
                    <JobFormSelect id="job-client" name="clientId" initial={preselectedClientId ?? ''}
                        options={clients.map((client) => ({ value: client.id, label: client.name }))}
                        required placeholder="Select a client"
                        invalid={Boolean(fieldErrors.clientId)}
                        describedBy={fieldErrors.clientId ? 'job-client-error' : undefined}
                        onChange={() => { setDirty(true); setSaved(false); setFieldErrors((current) => ({ ...current, clientId: undefined })); }}
                    />
                </Field>
            )}
            <Field label="Job title" htmlFor="job-title" error={fieldErrors.title} required>
                <Input
                    id="job-title"
                        aria-invalid={fieldErrors.title ? true : undefined}
                        aria-describedby={fieldErrors.title ? "job-title-error" : undefined}
                    name="title"
                    required
                    maxLength={200}
                    placeholder="e.g. Senior Product Designer"
                    defaultValue={initial?.title ?? ''}
                />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Employment type" htmlFor="job-employment-type" error={fieldErrors.employmentType}>
                    <JobFormSelect id="job-employment-type" name="employmentType" initial={initial?.employmentType ?? ''}
                        options={[{ value: 'full_time', label: 'Full time' }, { value: 'part_time', label: 'Part time' }, { value: 'contract', label: 'Contract' }, { value: 'internship', label: 'Internship' }]}
                        invalid={Boolean(fieldErrors.employmentType)}
                        describedBy={fieldErrors.employmentType ? 'job-employment-type-error' : undefined}
                        onChange={() => { setDirty(true); setSaved(false); setFieldErrors((current) => ({ ...current, employmentType: undefined })); }}
                    />
                </Field>
            </div>
            {!jobId && (
                <Field label="Visibility after publishing" htmlFor="job-public-visibility">
                    <JobFormSelect id="job-public-visibility" name="publiclyListed" clearable={false} initial={'false'}
                        options={[{ value: 'false', label: 'Internal only' }, { value: 'true', label: 'Public job board' }]}
                        invalid={Boolean(fieldErrors.publiclyListed)}
                        describedBy={fieldErrors.publiclyListed ? 'job-public-visibility-error' : undefined}
                        onChange={() => { setDirty(true); setSaved(false); setFieldErrors((current) => ({ ...current, publiclyListed: undefined })); }}
                    />
                </Field>
            )}
            </JobEditorSection>
            <JobEditorSection id="location" number="02" title="Workplace & location" icon={MapPin}>
                <Field label="Workplace mode" htmlFor="job-workplace-mode" error={fieldErrors.workplaceMode}>
                    <JobFormSelect id="job-workplace-mode" name="workplaceMode" initial={initial?.workplaceMode ?? ''}
                        options={[{ value: 'onsite', label: 'Onsite' }, { value: 'hybrid', label: 'Hybrid' }, { value: 'remote', label: 'Remote' }]}
                        invalid={Boolean(fieldErrors.workplaceMode)}
                        describedBy={fieldErrors.workplaceMode ? 'job-workplace-mode-error' : undefined}
                        onChange={(value) => { setWorkplaceMode(value); setDirty(true); setSaved(false); setFieldErrors((current) => ({ ...current, workplaceMode: undefined, remoteRegions: undefined })); }}
                    />
                </Field>
            <LocationEditor
                label="Locations"
                name="locations"
                error={fieldErrors.locations}
                inputId="job-locations"
                initial={initial?.locations ?? []}
                onDirty={() => { setDirty(true); setFieldErrors((current) => ({ ...current, locations: undefined })); }}
            />
            <fieldset hidden={workplaceMode === 'onsite'} disabled={workplaceMode === 'onsite'}><LocationEditor
                label="Remote regions"
                name="remoteRegions"
                error={fieldErrors.remoteRegions}
                inputId="job-remote-regions"
                initial={initial?.remoteRegions ?? []}
                onDirty={() => { setDirty(true); setFieldErrors((current) => ({ ...current, remoteRegions: undefined })); }}
            /></fieldset>
            </JobEditorSection>
            <JobEditorSection id="description" number="03" title="Job description" icon={FileText}>
                <details className="text-xs text-muted-foreground">
                    <summary className="w-fit cursor-pointer rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">Writing tips</summary>
                    <p className="mt-2 leading-5">About the role · Responsibilities · Requirements · Benefits. Leave out confidential details.</p>
                </details>
                {fieldErrors.descriptionDocument && <p className="text-xs text-destructive">{fieldErrors.descriptionDocument}</p>}
                <RichTextEditor
                    invalid={Boolean(fieldErrors.descriptionDocument)}
                    disabled={busy}
                    initialDocument={initial?.descriptionDocument ?? EMPTY_JOB_DOCUMENT}
                    onDocumentChange={(document) => {
                        documentRef.current = document;
                        setFieldErrors((current) => ({ ...current, descriptionDocument: undefined }));
                        setDirty(true);
                        setSaved(false);
                    }}
                />
            </JobEditorSection>
            <JobEditorSection id="compensation" number="04" title="Compensation & benefits" icon={Coins}>
            <JobCompensation initial={initial} errors={fieldErrors} onDirty={() => {
                setDirty(true); setSaved(false);
                setFieldErrors((current) => ({ ...current, compensationMin: undefined, compensationMax: undefined, currency: undefined, payPeriod: undefined }));
            }} />

            <div className="flex flex-col gap-2">
                <span className="text-sm font-medium text-foreground">Bonuses <span className="font-normal text-muted-foreground">· optional</span></span>
                {fieldErrors.bonuses && <p className="text-xs text-destructive">{fieldErrors.bonuses}</p>}
                {bonuses.map((bonus, index) => (
                    <div key={index} className="flex flex-col gap-2 sm:flex-row sm:items-end">
                        <div className="flex w-full min-w-0 flex-col gap-1.5 sm:w-36">
                            <Label htmlFor={`bonus-type-${index}`}>Type</Label>
                            <Select
                                value={bonus.type}
                                onValueChange={(value) =>
                                    updateBonus(index, { type: value })
                                }
                            >
                                <SelectTrigger
                                    id={`bonus-type-${index}`}
                                    aria-label={`Bonus ${index + 1} type`}
                                >
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {Array.from(BONUS_TYPES).map((type) => (
                                        <SelectItem key={type} value={type}>
                                            {BONUS_TYPE_LABELS[type] ?? type}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                            <Label htmlFor={`bonus-details-${index}`}>Details</Label>
                            <Input
                                id={`bonus-details-${index}`}
                                maxLength={2000}
                                placeholder="e.g. 10% signing bonus"
                                value={bonus.details}
                                onChange={(event) =>
                                    updateBonus(index, { details: event.target.value })
                                }
                            />
                        </div>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="self-end"
                            aria-label={`Remove bonus ${index + 1}`}
                            onClick={() => {
                                setDirty(true);
                                setBonuses((current) =>
                                    current.filter((_, position) => position !== index),
                                );
                            }}
                        >
                            <Trash2 aria-hidden="true" />
                        </Button>
                    </div>
                ))}
                {bonuses.length < 5 ? (
                    <Button
                        variant="outline"
                        size="sm"
                        className="self-start"
                        onClick={() => {
                            setDirty(true);
                            setBonuses((current) => [
                                ...current,
                                { type: 'cash', details: '' },
                            ]);
                        }}
                    >
                        <Plus aria-hidden="true" />
                        Add bonus
                    </Button>
                ) : null}
            </div>

            </JobEditorSection>
            {error && (
                <p role="alert" className="text-sm text-destructive">
                    {error}
                </p>
            )}
            </fieldset>
            <div className="sticky bottom-3 z-20 col-span-full flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card/95 px-4 py-3 shadow-lg backdrop-blur sm:px-5">
                <span role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                    {saved ? <Check className="h-4 w-4 text-success" aria-hidden="true" /> : <span className={`h-2 w-2 rounded-full ${dirty ? 'bg-warning' : 'bg-muted-foreground/40'}`} />}
                    {busy ? 'Saving your draft…' : dirty ? 'Unsaved changes' : saved ? 'Draft saved' : jobId ? 'Editing draft' : 'New draft'}
                </span>
                <div className="flex flex-wrap items-center gap-2">
                    <CancelJobButton dirty={dirty} disabled={busy}
                        href={previewOnly ? '/#/jobs' : staffWorkspaceUrl(jobId ? `/staff/jobs/${jobId}` : '/staff/jobs')}
                        onDiscard={() => setDirty(false)} />
                    {jobId && !previewOnly && <Button variant="ghost" asChild><Link href={staffWorkspaceUrl(`/staff/jobs/${jobId}`)}>Review saved draft</Link></Button>}
                    <Button variant="outline" disabled={busy} onClick={() => {
                        if (!formRef.current) return;
                        const snapshot = readJobEditor(formRef.current, documentRef.current);
                        setPreviewDocument(snapshot);
                        if (canonicalJobDocument(snapshot)) setFieldErrors((current) => ({ ...current, descriptionDocument: undefined }));
                        setPreview(Object.fromEntries(Array.from(new FormData(formRef.current).entries()).map(([key, value]) => [key, String(value)])));
                    }}><Eye aria-hidden="true" />Preview draft</Button>
                    <Button type="submit" disabled={busy}><Save aria-hidden="true" />
                        {busy ? 'Saving…' : jobId ? 'Save draft' : 'Create job draft'}
                    </Button>
                </div>
            </div>
            <Dialog open={preview !== null} onOpenChange={(open) => { if (!open) setPreview(null); }}>
                <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
                    <DialogHeader><DialogTitle>Draft preview</DialogTitle><DialogDescription>Review your changes before saving.</DialogDescription></DialogHeader>
                    <div className="flex flex-col gap-5 py-3">
                        <h2 className="text-2xl font-semibold">{preview?.title || 'Untitled role'}</h2>
                        <div className="flex flex-wrap gap-2">
                            {preview?.employmentType && <TagPill>{preview.employmentType.replace('_', ' ')}</TagPill>}
                            {preview?.workplaceMode && <TagPill>{preview.workplaceMode}</TagPill>}
                            {jobPreviewLocations(parseListField(preview?.locations ?? ''), parseListField(preview?.remoteRegions ?? ''), preview?.workplaceMode).map((location, index) => <TagPill key={`${location}-${index}`}>{location}</TagPill>)}
                        </div>
                        {(preview?.compensationMin || preview?.compensationMax) && <p className="text-sm font-medium">{preview?.currency} {compensationValue(preview?.compensationMin) ? preview?.compensationMin : '—'} – {compensationValue(preview?.compensationMax) ? preview?.compensationMax : '—'} {preview?.payPeriod ? `per ${preview.payPeriod}` : ''}</p>}
                        <JobDocumentView document={previewDocument} />
                        {bonuses.filter((bonus) => bonus.details.trim()).map((bonus, index) => <p key={index} className="text-sm">{BONUS_TYPE_LABELS[bonus.type] ?? 'Bonus'}: {bonus.details}</p>)}
                    </div>
                    <Button variant="outline" onClick={() => setPreview(null)} className="self-end">Back to editing</Button>
                </DialogContent>
            </Dialog>
        </form>
    );
}
