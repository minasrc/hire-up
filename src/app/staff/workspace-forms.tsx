"use client";

import { useRouter } from 'next/navigation';
import { useId, useRef, useState, type ReactNode } from 'react';
import { Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/staff-ui/button';
import { Checkbox } from '@/components/staff-ui/checkbox';
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
import { Textarea } from '@/components/staff-ui/textarea';
import { RichTextEditor } from '@/components/staff-preview/rich-text-editor';
import { RequiredMark, TagPill } from '@/components/staff-preview/shared';
import {
    BONUS_TYPES,
    EMPTY_JOB_DOCUMENT,
    SOCIAL_PLATFORM_NAMES,
    SOCIAL_PLATFORMS,
} from '@/lib/client-job-contracts.js';
import {
    LOCATION_OPTIONS,
    canonicalLocationLabel,
} from '@/lib/location-options.js';
import { staffMutation } from '@/lib/staff-mutation';
import { useUnsavedChangesGuard } from './form-guard';

const nativeSelectClass =
    'w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring';

function Field({
    label,
    htmlFor,
    required,
    children,
}: {
    label: string;
    htmlFor?: string;
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

interface SocialLink {
    platform: string;
    url: string;
}

interface JobBonus {
    type: string;
    details: string;
}

export function ClientForm({
    clientId,
    initial,
}: {
    clientId?: string;
    initial?: {
        name: string;
        contactName: string | null;
        contactEmail: string | null;
        telegramUsername: string | null;
        website: string | null;
        socialLinks: SocialLink[] | null;
        isStealth: boolean | null;
        anonymousDescription: string | null;
        version: string;
    };
}) {
    const router = useRouter();
    const formRef = useRef<HTMLFormElement>(null);
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    const [busy, setBusy] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [links, setLinks] = useState<SocialLink[]>(
        (initial?.socialLinks ?? []).map((link) => ({
            platform: link.platform,
            url: link.url,
        })),
    );

    const submit = async (form: HTMLFormElement): Promise<string | null> => {
        const data = new FormData(form);
        const stealth = data.get('isStealth') === 'on';
        const fields = {
            name: String(data.get('name') ?? ''),
            contactName: String(data.get('contactName') ?? '') || null,
            contactEmail: String(data.get('contactEmail') ?? '') || null,
            telegramUsername: String(data.get('telegramUsername') ?? '') || null,
            website: String(data.get('website') ?? '') || null,
            socialLinks: links
                .map((link) => ({ platform: link.platform, url: link.url.trim() }))
                .filter((link) => link.url !== ''),
            isStealth: stealth,
            anonymousDescription: stealth
                ? (String(data.get('anonymousDescription') ?? '') || null)
                : null,
        };
        const url = clientId ? `/api/staff/clients/${clientId}` : '/api/staff/clients';
        const payload = await staffMutation(url, {
            fields,
            ...(clientId ? { expectedVersion: initial?.version } : {}),
        });
        if (clientId) {
            setSaved(true);
            router.refresh();
            return null;
        }
        const targetId = payload?.result?.id ?? payload?.result?.clientId;
        if (!targetId) {
            throw new Error('Could not save. Please try again.');
        }
        return `/staff/clients/${targetId}`;
    };

    const runSave = async (navigate = true): Promise<boolean> => {
        if (!formRef.current || busy) return false;
        setError(null);
        setSaved(false);
        setBusy(true);
        try {
            const target = await submit(formRef.current);
            setDirty(false);
            if (navigate && target) {
                router.push(target);
                router.refresh();
            }
            return true;
        } catch (caught) {
            setError(
                caught instanceof Error
                    ? caught.message
                    : 'Could not save. Please try again.',
            );
            return false;
        } finally {
            setBusy(false);
        }
    };

    useUnsavedChangesGuard({ dirty, save: () => runSave(false) });

    const updateLink = (index: number, patch: Partial<SocialLink>) => {
        setDirty(true);
        setLinks((current) =>
            current.map((link, position) =>
                position === index ? { ...link, ...patch } : link,
            ),
        );
    };

    return (
        <form
            ref={formRef}
            className="flex max-w-xl flex-col gap-5"
            onChange={() => setDirty(true)}
            onSubmit={(event) => {
                event.preventDefault();
                void runSave();
            }}
        >
            <Field label="Client name" htmlFor="client-name" required>
                <Input
                    id="client-name"
                    name="name"
                    required
                    maxLength={256}
                    defaultValue={initial?.name ?? ''}
                />
            </Field>
            <Field label="Contact name" htmlFor="client-contact-name">
                <Input
                    id="client-contact-name"
                    name="contactName"
                    maxLength={256}
                    defaultValue={initial?.contactName ?? ''}
                />
            </Field>
            <Field label="Contact email" htmlFor="client-contact-email">
                <Input
                    id="client-contact-email"
                    name="contactEmail"
                    type="email"
                    maxLength={254}
                    defaultValue={initial?.contactEmail ?? ''}
                />
            </Field>
            <Field label="Telegram username" htmlFor="client-telegram">
                <Input
                    id="client-telegram"
                    name="telegramUsername"
                    maxLength={32}
                    defaultValue={initial?.telegramUsername ?? ''}
                />
            </Field>
            <Field label="Website" htmlFor="client-website">
                <Input
                    id="client-website"
                    name="website"
                    type="url"
                    defaultValue={initial?.website ?? ''}
                />
            </Field>

            <div className="flex flex-col gap-2">
                <span className="text-sm font-medium text-foreground">Social links</span>
                {links.map((link, index) => (
                    <div key={index} className="flex flex-col gap-2 sm:flex-row sm:items-end">
                        <div className="flex w-full min-w-0 flex-col gap-1.5 sm:w-40">
                            <Label htmlFor={`social-platform-${index}`}>Platform</Label>
                            <Select
                                value={link.platform}
                                onValueChange={(value) =>
                                    updateLink(index, { platform: value })
                                }
                            >
                                <SelectTrigger
                                    id={`social-platform-${index}`}
                                    aria-label={`Social link ${index + 1} platform`}
                                >
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {Array.from(SOCIAL_PLATFORMS).map((platform) => (
                                        <SelectItem key={platform} value={platform}>
                                            {SOCIAL_PLATFORM_NAMES[
                                                platform as keyof typeof SOCIAL_PLATFORM_NAMES
                                            ] ?? platform}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                            <Label htmlFor={`social-url-${index}`}>URL</Label>
                            <Input
                                id={`social-url-${index}`}
                                type="url"
                                placeholder="https://…"
                                value={link.url}
                                onChange={(event) =>
                                    updateLink(index, { url: event.target.value })
                                }
                            />
                        </div>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="self-end"
                            aria-label={`Remove social link ${index + 1}`}
                            onClick={() => {
                                setDirty(true);
                                setLinks((current) =>
                                    current.filter((_, position) => position !== index),
                                );
                            }}
                        >
                            <Trash2 aria-hidden="true" />
                        </Button>
                    </div>
                ))}
                {links.length < 8 ? (
                    <Button
                        variant="outline"
                        size="sm"
                        className="self-start"
                        onClick={() => {
                            setDirty(true);
                            setLinks((current) => [
                                ...current,
                                { platform: 'linkedin', url: '' },
                            ]);
                        }}
                    >
                        <Plus aria-hidden="true" />
                        Add social link
                    </Button>
                ) : null}
            </div>

            <label className="flex items-center gap-2 text-sm text-foreground">
                <Checkbox
                    name="isStealth"
                    value="on"
                    defaultChecked={initial?.isStealth ?? false}
                />
                Stealth client (hidden identity in public listings)
            </label>
            <Field label="Anonymous description" htmlFor="client-anon-description">
                <Textarea
                    id="client-anon-description"
                    name="anonymousDescription"
                    rows={2}
                    defaultValue={initial?.anonymousDescription ?? ''}
                />
            </Field>
            {error && (
                <p role="alert" className="text-sm text-destructive">
                    {error}
                </p>
            )}
            {saved ? (
                <p role="status" className="text-sm text-muted-foreground">
                    Changes saved.
                </p>
            ) : null}
            <Button type="submit" disabled={busy} className="self-start">
                {busy
                    ? 'Saving…'
                    : clientId
                      ? 'Save changes'
                      : 'Create client'}
            </Button>
        </form>
    );
}

function LocationEditor({
    label,
    hint,
    name,
    inputId,
    initial,
    onDirty,
}: {
    label: string;
    hint?: string;
    name: string;
    inputId: string;
    initial?: string[];
    onDirty?: () => void;
}) {
    const listId = useId();
    const [values, setValues] = useState<string[]>(initial ?? []);
    const [draft, setDraft] = useState('');

    const add = () => {
        const canonical = canonicalLocationLabel(draft) ?? draft.trim();
        if (canonical === '') return;
        onDirty?.();
        setValues((current) =>
            current.some((entry) => entry.toLowerCase() === canonical.toLowerCase())
                ? current
                : [...current, canonical],
        );
        setDraft('');
    };

    const pending = canonicalLocationLabel(draft) ?? draft.trim();
    const serialized =
        pending === ''
            ? values
            : values.some((entry) => entry.toLowerCase() === pending.toLowerCase())
              ? values
              : [...values, pending];

    return (
        <Field label={label} htmlFor={inputId}>
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
                <div className="flex items-center gap-2">
                    <Input
                        id={inputId}
                        list={listId}
                        value={draft}
                        placeholder="Type a city, country or region…"
                        onChange={(event) => setDraft(event.target.value)}
                        onBlur={add}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                                event.preventDefault();
                                add();
                            }
                        }}
                    />
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={draft.trim() === ''}
                        onClick={add}
                    >
                        Add
                    </Button>
                </div>
                <datalist id={listId}>
                    {LOCATION_OPTIONS.map((option) => (
                        <option key={option} value={option} />
                    ))}
                </datalist>
                {hint ? (
                    <span className="text-xs text-muted-foreground">{hint}</span>
                ) : null}
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
}: {
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
            remoteRegions: parseListField(String(data.get('remoteRegions') ?? '')),
            compensationMin: nullable('compensationMin'),
            compensationMax: nullable('compensationMax'),
            currency: nullable('currency'),
            payPeriod: nullable('payPeriod'),
            bonuses: bonuses
                .map((bonus) => ({ type: bonus.type, details: bonus.details.trim() }))
                .filter((bonus) => bonus.details !== ''),
            descriptionDocument: documentRef.current,
        };
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

    const runSave = async (navigate = true): Promise<boolean> => {
        if (!formRef.current || busy) return false;
        setError(null);
        setBusy(true);
        try {
            const target = await submit(formRef.current);
            setDirty(false);
            if (navigate) {
                router.push(target);
            }
            router.refresh();
            return true;
        } catch (caught) {
            setError(
                caught instanceof Error
                    ? caught.message
                    : 'Could not save. Please try again.',
            );
            return false;
        } finally {
            setBusy(false);
        }
    };

    useUnsavedChangesGuard({ dirty, save: () => runSave(false) });

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
            className="flex max-w-2xl flex-col gap-5"
            onChange={() => setDirty(true)}
            onSubmit={(event) => {
                event.preventDefault();
                void runSave();
            }}
        >
            {!jobId && (
                <Field label="Client" htmlFor="job-client" required>
                    <select
                        id="job-client"
                        name="clientId"
                        required
                        className={nativeSelectClass}
                        defaultValue={preselectedClientId ?? ''}
                    >
                        <option value="" disabled>
                            Select a client
                        </option>
                        {clients.map((client) => (
                            <option key={client.id} value={client.id}>
                                {client.name}
                            </option>
                        ))}
                    </select>
                </Field>
            )}
            {!jobId && (
                <Field label="Public board visibility" htmlFor="job-public-visibility">
                    <select
                        id="job-public-visibility"
                        name="publiclyListed"
                        className={nativeSelectClass}
                        defaultValue="false"
                    >
                        <option value="false">Unlisted</option>
                        <option value="true">Listed</option>
                    </select>
                    <span className="text-xs text-muted-foreground">
                        Unlisted jobs stay internal. Listed jobs appear publicly only
                        after you publish them.
                    </span>
                </Field>
            )}
            <Field label="Job title" htmlFor="job-title" required>
                <Input
                    id="job-title"
                    name="title"
                    required
                    maxLength={200}
                    defaultValue={initial?.title ?? ''}
                />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Employment type" htmlFor="job-employment-type">
                    <select
                        id="job-employment-type"
                        name="employmentType"
                        className={nativeSelectClass}
                        defaultValue={initial?.employmentType ?? ''}
                    >
                        <option value="">—</option>
                        <option value="full_time">Full time</option>
                        <option value="part_time">Part time</option>
                        <option value="contract">Contract</option>
                        <option value="internship">Internship</option>
                    </select>
                </Field>
                <Field label="Workplace mode" htmlFor="job-workplace-mode">
                    <select
                        id="job-workplace-mode"
                        name="workplaceMode"
                        className={nativeSelectClass}
                        defaultValue={initial?.workplaceMode ?? ''}
                    >
                        <option value="">—</option>
                        <option value="onsite">Onsite</option>
                        <option value="hybrid">Hybrid</option>
                        <option value="remote">Remote</option>
                    </select>
                </Field>
            </div>
            <LocationEditor
                label="Locations"
                name="locations"
                inputId="job-locations"
                initial={initial?.locations ?? []}
                onDirty={() => setDirty(true)}
                hint="Add one or more cities, countries or regions. Suggestions appear as you type."
            />
            <LocationEditor
                label="Remote regions"
                name="remoteRegions"
                inputId="job-remote-regions"
                initial={initial?.remoteRegions ?? []}
                onDirty={() => setDirty(true)}
                hint="Regions candidates can work from when the role is remote."
            />
            <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Compensation min" htmlFor="job-comp-min">
                    <Input
                        id="job-comp-min"
                        name="compensationMin"
                        inputMode="decimal"
                        defaultValue={initial?.compensationMin ?? ''}
                    />
                </Field>
                <Field label="Compensation max" htmlFor="job-comp-max">
                    <Input
                        id="job-comp-max"
                        name="compensationMax"
                        inputMode="decimal"
                        defaultValue={initial?.compensationMax ?? ''}
                    />
                </Field>
                <Field label="Currency" htmlFor="job-currency">
                    <Input
                        id="job-currency"
                        name="currency"
                        maxLength={3}
                        placeholder="EUR"
                        defaultValue={initial?.currency ?? ''}
                    />
                </Field>
                <Field label="Pay period" htmlFor="job-pay-period">
                    <select
                        id="job-pay-period"
                        name="payPeriod"
                        className={nativeSelectClass}
                        defaultValue={initial?.payPeriod ?? ''}
                    >
                        <option value="">—</option>
                        <option value="year">Year</option>
                        <option value="month">Month</option>
                        <option value="day">Day</option>
                        <option value="hour">Hour</option>
                    </select>
                </Field>
            </div>

            <div className="flex flex-col gap-2">
                <span className="text-sm font-medium text-foreground">Bonuses</span>
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
                                            {type}
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

            <div className="flex flex-col gap-1.5">
                <span id="job-description-label" className="text-sm font-medium text-foreground">
                    Description <RequiredMark />
                </span>
                <RichTextEditor
                    initialDocument={initial?.descriptionDocument ?? EMPTY_JOB_DOCUMENT}
                    onDocumentChange={(document) => {
                        documentRef.current = document;
                        setDirty(true);
                    }}
                />
            </div>
            {error && (
                <p role="alert" className="text-sm text-destructive">
                    {error}
                </p>
            )}
            <Button type="submit" disabled={busy} className="self-start">
                {busy ? 'Saving…' : jobId ? 'Save draft' : 'Create job draft'}
            </Button>
        </form>
    );
}

export function PublishButton({
    jobId,
    revisionId,
    expectedVersion,
    expectedClientVersion,
    reviewHash,
}: {
    jobId: string;
    revisionId: string;
    expectedVersion: string;
    expectedClientVersion: string;
    reviewHash: string;
}) {
    const router = useRouter();
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    return (
        <div>
            <Button
                disabled={busy}
                onClick={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                        await staffMutation(`/api/staff/jobs/${jobId}/publish`, {
                            revisionId, expectedVersion, expectedClientVersion, reviewHash,
                        });
                        router.refresh();
                    } catch (caught) {
                        setError(
                            caught instanceof Error
                                ? caught.message
                                : 'Could not save. Please try again.');
                    } finally {
                        setBusy(false);
                    }
                }}
            >
                {busy ? 'Publishing…' : 'Publish this revision'}
            </Button>
            {error && (
                <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>
            )}
        </div>
    );
}

export function NewRevisionButton({ jobId, expectedJobVersion }: { jobId: string; expectedJobVersion: string }) {
    const router = useRouter();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    return (
        <span className="inline-flex items-center gap-3">
            <Button
                variant="outline"
                disabled={busy}
                onClick={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                        await staffMutation(`/api/staff/jobs/${jobId}/revision`, {
                            expectedJobVersion,
                        });
                        router.push(`/staff/jobs/${jobId}/edit`);
                        router.refresh();
                    } catch (caught) {
                        setError(
                            caught instanceof Error
                                ? caught.message
                                : 'Could not save. Please try again.');
                    } finally {
                        setBusy(false);
                    }
                }}
            >
                Start new revision
            </Button>
            {error && <span role="alert" className="text-sm text-destructive">{error}</span>}
        </span>
    );
}

export function DuplicateJobButton({
    sourceJobId,
    clientId,
    sourceRevisionId,
    expectedSourceVersion,
}: {
    sourceJobId: string;
    clientId: string;
    sourceRevisionId: string;
    expectedSourceVersion: string;
}) {
    const router = useRouter();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const idsRef = useRef({
        jobId: crypto.randomUUID(),
        revisionId: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
    });
    return (
        <span className="inline-flex items-center gap-3">
            <Button
                variant="outline"
                disabled={busy}
                onClick={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                        const response = await fetch(
                            `/api/staff/jobs/${sourceJobId}/duplicate`,
                            {
                                method: 'POST',
                                headers: { 'content-type': 'application/json' },
                                body: JSON.stringify({
                                    sourceRevisionId,
                                    expectedSourceVersion,
                                    clientId,
                                    jobId: idsRef.current.jobId,
                                    revisionId: idsRef.current.revisionId,
                                    operationId: idsRef.current.operationId,
                                }),
                            },
                        );
                        const payload = await response.json().catch(() => ({}));
                        if (!response.ok) {
                            throw new Error(
                                response.status === 409
                                    ? 'This job changed. Reload and try again.'
                                    : response.status === 401 || response.status === 428
                                      ? 'Your session expired. Sign in again.'
                                      : response.status === 403
                                        ? 'You do not have permission to duplicate jobs.'
                                        : payload.error
                                          ?? 'Could not duplicate this job.',
                            );
                        }
                        const newJobId = payload?.result?.jobId;
                        if (
                            typeof newJobId !== 'string'
                            || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
                                .test(newJobId)
                            || newJobId === sourceJobId
                        ) {
                            throw new Error(
                                'The duplicate was not confirmed. Reload and try again.');
                        }
                        window.dispatchEvent(new Event('staff-workspace-updated'));
                        router.push(`/staff/jobs/${newJobId}/edit`);
                        router.refresh();
                    } catch (caught) {
                        setError(
                            caught instanceof Error
                                ? caught.message
                                : 'Could not duplicate this job.');
                    } finally {
                        setBusy(false);
                    }
                }}
            >
                {busy ? 'Duplicating…' : 'Duplicate job'}
            </Button>
            {error && <span role="alert" className="text-sm text-destructive">{error}</span>}
        </span>
    );
}

export function MemberInviteForm({
    roles,
    inviteDomains,
}: {
    roles: { id: string; name: string; key: string }[];
    inviteDomains: string[];
}) {
    const router = useRouter();
    const [error, setError] = useState<string | null>(null);
    const [status, setStatus] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [invitation, setInvitation] = useState<string | null>(null);

    const submit = async (form: HTMLFormElement) => {
        const data = new FormData(form);
        await staffMutation('/api/staff/members', {
            action: 'invite',
            displayName: String(data.get('displayName') ?? ''),
            email: String(data.get('email') ?? ''),
            roleId: String(data.get('roleId') ?? ''),
        });
        setInvitation(`You have been invited to Agora. Open ${window.location.origin}/staff/sign-in and sign in with ${String(data.get('email') ?? '').trim()}. Set up your authenticator when prompted.`);
        form.reset();
        setStatus('Invitation recorded — the person signs in with that Google account.');
        router.refresh();
    };

    return (
        <form
            className="flex max-w-xl flex-col gap-5"
            onSubmit={(event) => {
                event.preventDefault();
                setError(null);
                setStatus(null);
                setInvitation(null);
                setBusy(true);
                void submit(event.currentTarget)
                    .catch((caught) =>
                        setError(
                            caught instanceof Error
                                ? caught.message
                                : 'Could not save. Please try again.',
                        ),
                    )
                    .finally(() => setBusy(false));
            }}
        >
            <Field label="Name" htmlFor="invite-name" required>
                <Input id="invite-name" name="displayName" required maxLength={256} />
            </Field>
            <Field label="Email" htmlFor="invite-email" required>
                <Input id="invite-email" name="email" type="email" required maxLength={320} />
                {inviteDomains.length > 0 && (
                    <span className="text-xs text-muted-foreground">
                        Restricted to: {inviteDomains.map((d) => `@${d}`).join(', ')}
                    </span>
                )}
            </Field>
            <Field label="Role" htmlFor="invite-role" required>
                <select
                    id="invite-role"
                    name="roleId"
                    required
                    className={nativeSelectClass}
                    defaultValue=""
                >
                    <option value="" disabled>
                        Select a role
                    </option>
                    {roles.map((role) => (
                        <option key={role.id} value={role.id}>
                            {role.name}
                        </option>
                    ))}
                </select>
            </Field>
            {error && (
                <p role="alert" className="text-sm text-destructive">{error}</p>
            )}
            {status && (
                <p role="status" className="text-sm text-muted-foreground">{status}</p>
            )}
            {invitation && (
                <div className="flex flex-col gap-2">
                    <Label htmlFor="invitation-message">Share this invitation message</Label>
                    <textarea id="invitation-message" readOnly value={invitation}
                        className="min-h-24 rounded-md border bg-background p-3 text-sm"
                        onFocus={(event) => event.currentTarget.select()} />
                    <p className="text-xs text-muted-foreground">Select and copy this message to send it to the invited person.</p>
                </div>
            )}
            <Button type="submit" disabled={busy} className="self-start">
                {busy ? 'Recording…' : 'Record invitation'}
            </Button>
        </form>
    );
}

export function InviteDomainsForm({ domains }: { domains: string[] }) {
    const router = useRouter();
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [saved, setSaved] = useState(false);

    const submit = async (form: HTMLFormElement) => {
        const data = new FormData(form);
        await staffMutation('/api/staff/members', {
            action: 'setInviteDomains',
            domains: parseList(String(data.get('domains') ?? '')),
        });
        setSaved(true);
        router.refresh();
    };

    return (
        <form
            className="flex max-w-xl flex-col gap-3"
            onSubmit={(event) => {
                event.preventDefault();
                setError(null);
                setSaved(false);
                setBusy(true);
                void submit(event.currentTarget)
                    .catch((caught) =>
                        setError(
                            caught instanceof Error
                                ? caught.message
                                : 'Could not save. Please try again.',
                        ),
                    )
                    .finally(() => setBusy(false));
            }}
        >
            <Field
                label="Allowed invite domains (comma-separated, empty = any)"
                htmlFor="invite-domains"
            >
                <Input
                    id="invite-domains"
                    name="domains"
                    defaultValue={domains.join(', ')}
                    placeholder="agora4.xyz"
                />
            </Field>
            {error && (
                <p role="alert" className="text-sm text-destructive">{error}</p>
            )}
            {saved ? (
                <p role="status" className="text-sm text-muted-foreground">
                    Invite domains saved.
                </p>
            ) : null}
            <Button type="submit" disabled={busy} className="self-start">
                {busy ? 'Saving…' : 'Save domains'}
            </Button>
        </form>
    );
}

export function MemberRevokeButton({
    membershipId,
    roleId,
    version,
}: {
    membershipId: string;
    roleId: string;
    version: string;
}) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const revoke = async () => {
        await staffMutation('/api/staff/members', {
            action: 'changeMembership',
            membershipId,
            roleId,
            status: 'revoked',
            version: Number(version),
        });
        setOpen(false);
        router.refresh();
    };

    return (
        <>
            <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
                Revoke
            </Button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Revoke membership</DialogTitle>
                        <DialogDescription>
                            The member loses staff workspace access immediately. This
                            cannot be undone from here.
                        </DialogDescription>
                    </DialogHeader>
                    {error && (
                        <p role="alert" className="text-sm text-destructive">{error}</p>
                    )}
                    <div className="flex justify-end gap-2">
                        <Button
                            variant="outline"
                            onClick={() => setOpen(false)}
                            disabled={busy}
                        >
                            Cancel
                        </Button>
                        <Button
                            variant="destructive"
                            disabled={busy}
                            onClick={() => {
                                setBusy(true);
                                setError(null);
                                void revoke()
                                    .catch((caught) =>
                                        setError(
                                            caught instanceof Error
                                                ? caught.message
                                                : 'Could not save. Please try again.',
                                        ),
                                    )
                                    .finally(() => setBusy(false));
                            }}
                        >
                            {busy ? 'Revoking…' : 'Revoke membership'}
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </>
    );
}

export function JobListingToggle({
    jobId,
    listed,
    expectedVersion,
}: {
    jobId: string;
    listed: boolean;
    expectedVersion: string;
}) {
    const router = useRouter();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    return (
        <span className="inline-flex items-center gap-3">
            <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                        await staffMutation(`/api/staff/jobs/${jobId}/listing`, {
                            listed: !listed,
                            expectedVersion,
                        });
                        router.refresh();
                    } catch (caught) {
                        setError(
                            caught instanceof Error
                                ? caught.message
                                : 'Could not save. Please try again.');
                    } finally {
                        setBusy(false);
                    }
                }}
            >
                {listed ? 'Unlist job' : 'List job'}
            </Button>
            {error && <span role="alert" className="text-sm text-destructive">{error}</span>}
        </span>
    );
}
