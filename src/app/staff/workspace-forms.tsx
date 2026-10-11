"use client";

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
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
import { RequiredMark } from '@/components/staff-preview/shared';
import {
    BONUS_TYPES,
    EMPTY_JOB_DOCUMENT,
    SOCIAL_PLATFORM_NAMES,
    SOCIAL_PLATFORMS,
    ClientJobContractError,
    normalizeClientUrlInput,
    validateClientInput,
} from '@/lib/client-job-contracts.js';
import { mapClientFieldErrors } from '@/lib/client-form-errors.js';
import { staffMutation, StaffMutationError } from '@/lib/staff-mutation';

const nativeSelectClass =
    'w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring';

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

interface SocialLink {
    platform: string;
    url: string;
}

interface JobBonus {
    type: string;
    details: string;
}

interface SocialRow {
    key: string;
    platform: string;
    url: string;
}

export interface ClientFormValues {
    name: string;
    contactName: string | null;
    contactEmail: string | null;
    telegramUsername: string | null;
    website: string | null;
    socialLinks: SocialLink[] | null;
    isStealth: boolean | null;
    anonymousDescription: string | null;
    version: string;
}

export interface SavedClient extends ClientFormValues {
    id: string;
    status: string;
    publicProfileVersion: string;
}

const CLIENT_FIELD_IDS: Record<string, string> = {
    name: 'client-name',
    contactName: 'client-contact-name',
    contactEmail: 'client-contact-email',
    telegramUsername: 'client-telegram',
    website: 'client-website',
    anonymousDescription: 'client-anon-description',
};

const TELEGRAM_HINT =
    'Use 5–32 letters, numbers or underscores, starting with a letter.'
        + ' @ is optional.';

const invalidClass = 'border-destructive focus-visible:ring-destructive';

const clientFields = (client?: ClientFormValues) => ({
    name: client?.name ?? '',
    contactName: client?.contactName ?? '',
    contactEmail: client?.contactEmail ?? '',
    telegramUsername: client?.telegramUsername ?? '',
    website: client?.website ?? '',
    anonymousDescription: client?.anonymousDescription ?? '',
    isStealth: client?.isStealth ?? false,
});

const clientLinks = (client?: ClientFormValues): SocialRow[] =>
    (client?.socialLinks ?? []).map(link => ({ ...link, key: crypto.randomUUID() }));

export function ClientForm({
    clientId,
    initial,
    onSaved,
}: {
    clientId?: string;
    initial?: ClientFormValues;
    onSaved?: (client: SavedClient) => void;
}) {
    const router = useRouter();
    const formRef = useRef<HTMLFormElement>(null);
    const busyRef = useRef(false);
    const [baseVersion, setBaseVersion] = useState(initial?.version);
    const [dirty, setDirty] = useState(false);
    const [seenInitial, setSeenInitial] = useState(initial);
    const focusRequestRef = useRef<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    const [busy, setBusy] = useState(false);
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
    const [rowErrors, setRowErrors] = useState<
        Record<string, { platform?: string; url?: string }>
    >({});
    const [socialError, setSocialError] = useState<string | null>(null);
    const [values, setValues] = useState(() => clientFields(initial));
    const [links, setLinks] = useState(() => clientLinks(initial));
    const newerSnapshot = initial && baseVersion
        && BigInt(initial.version) > BigInt(baseVersion);

    const adoptLatest = () => {
        if (!initial) return;
        setBaseVersion(initial.version);
        setValues(clientFields(initial));
        setLinks(clientLinks(initial));
        setDirty(false);
        setSaved(false);
        setError(null);
        setFieldErrors({});
        setRowErrors({});
        setSocialError(null);
    };

    // React rerenders before committing: fields and their concurrency version
    // must move together. A dirty draft keeps the version it was edited against.
    if (seenInitial !== initial && !busy) {
        setSeenInitial(initial);
        if (!dirty && newerSnapshot) adoptLatest();
    }

    useEffect(() => {
        const target = focusRequestRef.current;
        if (!target) return;
        const element = formRef.current
            ?.querySelector<HTMLElement>(`#${CSS.escape(target)}`);
        if (!element || element.matches(':disabled')) return;
        focusRequestRef.current = null;
        element.focus();
    });

    const patch = (partial: Partial<typeof values>) => {
        setDirty(true);
        setSaved(false);
        setValues((current) => ({ ...current, ...partial }));
    };

    const clearFieldError = (field: string) => {
        setFieldErrors((current) => {
            if (!(field in current)) return current;
            const next = { ...current };
            delete next[field];
            return next;
        });
    };

    const change = (field: keyof typeof values, value: string | boolean) => {
        patch({ [field]: value });
        clearFieldError(field);
    };

    const clearRowError = (key: string) => {
        setRowErrors((current) => {
            if (!(key in current)) return current;
            const next = { ...current };
            delete next[key];
            return next;
        });
    };

    const clearSocialErrors = () => {
        setRowErrors({});
        setSocialError(null);
    };

    const updateLink = (key: string, partial: Partial<SocialRow>) => {
        setDirty(true);
        setSaved(false);
        clearRowError(key);
        setSocialError(null);
        setLinks((current) =>
            current.map((link) =>
                link.key === key ? { ...link, ...partial } : link,
            ),
        );
    };

    const removeLink = (key: string) => {
        setDirty(true);
        setSaved(false);
        clearSocialErrors();
        setLinks((current) => current.filter((link) => link.key !== key));
    };

    const addLink = () => {
        setDirty(true);
        setSaved(false);
        clearSocialErrors();
        setLinks((current) => [
            ...current,
            { key: crypto.randomUUID(), platform: 'linkedin', url: '' },
        ]);
    };

    const describedBy = (id: string, hasError: boolean, hasHint = false) =>
        [
            hasError ? `${id}-error` : null,
            hasHint ? `${id}-hint` : null,
        ].filter(Boolean).join(' ') || undefined;

    const applyErrors = (
        errors: Record<string, unknown>,
        submittedKeys: string[],
    ) => {
        const mapped = mapClientFieldErrors(errors, submittedKeys);
        setFieldErrors(mapped.fields);
        setRowErrors(Object.fromEntries(mapped.rows));
        setSocialError(mapped.group);
        const scalarOrder = [
            'name',
            'contactName',
            'contactEmail',
            'telegramUsername',
            'website',
            'anonymousDescription',
        ];
        let target = scalarOrder
            .filter((field) => mapped.fields[field])
            .map((field) => CLIENT_FIELD_IDS[field])[0] ?? null;
        if (!target) {
            const index = links.findIndex((link) => mapped.rows.has(link.key));
            if (index >= 0) {
                const row = mapped.rows.get(links[index].key);
                target = `social-${row?.url ? 'url' : 'platform'}-${index}`;
            } else if (mapped.group && links.length > 0) {
                target = 'social-url-0';
            }
        }
        focusRequestRef.current = target;
    };

    const submit = async () => {
        const submittedKeys = links
            .filter((link) => link.url.trim() !== '')
            .map((link) => link.key);
        const raw = {
            name: values.name,
            contactName: values.contactName || null,
            contactEmail: values.contactEmail || null,
            telegramUsername: values.telegramUsername || null,
            website: values.website || null,
            socialLinks: links
                .map((link) => ({
                    platform: link.platform,
                    url: link.url.trim(),
                }))
                .filter((link) => link.url !== ''),
            isStealth: values.isStealth,
            anonymousDescription: values.isStealth
                ? values.anonymousDescription || null
                : null,
        };
        let fields;
        try {
            fields = validateClientInput(raw);
        } catch (caught) {
            if (caught instanceof ClientJobContractError) {
                applyErrors(caught.fieldErrors, submittedKeys);
                setError('Please check the highlighted fields.');
                return;
            }
            throw caught;
        }
        setFieldErrors({});
        setRowErrors({});
        setSocialError(null);
        setValues((current) => ({
            ...current,
            name: fields.name ?? current.name,
            contactName: fields.contactName ?? '',
            contactEmail: fields.contactEmail ?? '',
            telegramUsername: fields.telegramUsername ?? '',
            website: fields.website ?? '',
            anonymousDescription: fields.anonymousDescription ?? '',
        }));
        const normalizedLinks = fields.socialLinks ?? [];
        let normalizedIndex = 0;
        setLinks((current) => current.map((link) => {
            if (link.url.trim() === '') return link;
            const normalized = normalizedLinks[normalizedIndex];
            normalizedIndex += 1;
            return normalized
                ? { ...link, platform: normalized.platform, url: normalized.url }
                : link;
        }));
        const url = clientId ? `/api/staff/clients/${clientId}` : '/api/staff/clients';
        let payload;
        try {
            payload = await staffMutation(url, {
                fields,
                ...(clientId ? { expectedVersion: baseVersion } : {}),
            });
        } catch (caught) {
            if (caught instanceof StaffMutationError
                && caught.status === 400
                && Object.keys(caught.fieldErrors).length > 0) {
                applyErrors(caught.fieldErrors, submittedKeys);
                setError('Please check the highlighted fields.');
                return;
            }
            throw caught;
        }
        if (clientId) {
            const snapshot = payload?.result?.client as SavedClient | undefined;
            setSaved(true);
            if (onSaved && snapshot?.id === clientId
                && typeof snapshot.name === 'string'
                && typeof snapshot.version === 'string'
                && /^[1-9]\d{0,18}$/.test(snapshot.version)
                && (snapshot.socialLinks == null || Array.isArray(snapshot.socialLinks))) {
                setBaseVersion(snapshot.version);
                setDirty(false);
                setValues(clientFields(snapshot));
                setLinks(clientLinks(snapshot));
                onSaved(snapshot);
            } else {
                const version = payload?.result?.version;
                if (typeof version === 'string' && /^[1-9]\d{0,18}$/.test(version)) {
                    setBaseVersion(version);
                    setDirty(false);
                }
                router.refresh();
            }
            return;
        }
        const targetId = payload?.result?.id ?? payload?.result?.clientId;
        if (!targetId) {
            throw new Error('Could not save. Please try again.');
        }
        router.push(`/staff/clients/${targetId}`);
    };

    return (
        <form
            ref={formRef}
            noValidate
            className="flex max-w-xl flex-col gap-5"
            onSubmit={(event) => {
                event.preventDefault();
                if (busyRef.current) return;
                busyRef.current = true;
                setError(null);
                setSaved(false);
                setBusy(true);
                void submit()
                    .catch((caught) =>
                        setError(
                            caught instanceof Error
                                ? caught.message
                                : 'Could not save. Please try again.',
                        ),
                    )
                    .finally(() => {
                        busyRef.current = false;
                        setBusy(false);
                    });
            }}
        >
            <fieldset
                disabled={busy}
                className="m-0 flex min-w-0 flex-col gap-5 border-0 p-0"
            >
            <Field
                label="Client name"
                htmlFor="client-name"
                required
                error={fieldErrors.name}
            >
                <Input
                    id="client-name"
                    name="name"
                    required
                    maxLength={256}
                    value={values.name}
                    aria-invalid={fieldErrors.name ? true : undefined}
                    aria-describedby={describedBy(
                        'client-name', Boolean(fieldErrors.name))}
                    className={fieldErrors.name ? invalidClass : undefined}
                    onChange={(event) => change('name', event.target.value)}
                />
            </Field>
            <Field
                label="Contact name"
                htmlFor="client-contact-name"
                required
                error={fieldErrors.contactName}
            >
                <Input
                    id="client-contact-name"
                    name="contactName"
                    required
                    maxLength={256}
                    value={values.contactName}
                    aria-invalid={fieldErrors.contactName ? true : undefined}
                    aria-describedby={describedBy(
                        'client-contact-name', Boolean(fieldErrors.contactName))}
                    className={fieldErrors.contactName ? invalidClass : undefined}
                    onChange={(event) =>
                        change('contactName', event.target.value)}
                />
            </Field>
            <Field
                label="Contact email"
                htmlFor="client-contact-email"
                required
                error={fieldErrors.contactEmail}
            >
                <Input
                    id="client-contact-email"
                    name="contactEmail"
                    type="email"
                    required
                    maxLength={254}
                    value={values.contactEmail}
                    aria-invalid={fieldErrors.contactEmail ? true : undefined}
                    aria-describedby={describedBy(
                        'client-contact-email', Boolean(fieldErrors.contactEmail))}
                    className={fieldErrors.contactEmail ? invalidClass : undefined}
                    onChange={(event) =>
                        change('contactEmail', event.target.value)}
                />
            </Field>
            <Field
                label="Telegram username"
                htmlFor="client-telegram"
                error={fieldErrors.telegramUsername}
                hint={fieldErrors.telegramUsername ? undefined : TELEGRAM_HINT}
            >
                <Input
                    id="client-telegram"
                    name="telegramUsername"
                    maxLength={33}
                    value={values.telegramUsername}
                    aria-invalid={
                        fieldErrors.telegramUsername ? true : undefined}
                    aria-describedby={describedBy(
                        'client-telegram',
                        Boolean(fieldErrors.telegramUsername),
                        !fieldErrors.telegramUsername)}
                    className={
                        fieldErrors.telegramUsername ? invalidClass : undefined}
                    onChange={(event) =>
                        change('telegramUsername', event.target.value)}
                />
            </Field>
            <Field
                label="Website"
                htmlFor="client-website"
                error={fieldErrors.website}
            >
                <Input
                    id="client-website"
                    name="website"
                    type="url"
                    inputMode="url"
                    value={values.website}
                    aria-invalid={fieldErrors.website ? true : undefined}
                    aria-describedby={describedBy(
                        'client-website', Boolean(fieldErrors.website))}
                    className={fieldErrors.website ? invalidClass : undefined}
                    onChange={(event) => change('website', event.target.value)}
                    onBlur={(event) => {
                        const normalized = normalizeClientUrlInput(
                            event.target.value);
                        if (normalized !== null
                            && normalized !== event.target.value.trim()) {
                            patch({ website: normalized });
                        }
                    }}
                />
            </Field>

            <div className="flex flex-col gap-2">
                <span className="text-sm font-medium text-foreground">Social links</span>
                {links.map((link, index) => {
                    const rowError = rowErrors[link.key] ?? {};
                    return (
                    <div key={link.key} className="flex flex-col gap-2 sm:flex-row sm:items-end">
                        <div className="flex w-full min-w-0 flex-col gap-1.5 sm:w-40">
                            <Label htmlFor={`social-platform-${index}`}>Platform</Label>
                            <Select
                                value={link.platform}
                                onValueChange={(value) =>
                                    updateLink(link.key, { platform: value })
                                }
                            >
                                <SelectTrigger
                                    id={`social-platform-${index}`}
                                    aria-label={`Social link ${index + 1} platform`}
                                    aria-invalid={
                                        rowError.platform ? true : undefined}
                                    aria-describedby={describedBy(
                                        `social-platform-${index}`,
                                        Boolean(rowError.platform))}
                                    className={
                                        rowError.platform ? invalidClass : undefined}
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
                            {rowError.platform ? (
                                <span
                                    id={`social-platform-${index}-error`}
                                    className="text-xs text-destructive"
                                >
                                    {rowError.platform}
                                </span>
                            ) : null}
                        </div>
                        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                            <Label htmlFor={`social-url-${index}`}>URL</Label>
                            <Input
                                id={`social-url-${index}`}
                                type="url"
                                inputMode="url"
                                placeholder="https://…"
                                value={link.url}
                                aria-invalid={rowError.url ? true : undefined}
                                aria-describedby={describedBy(
                                    `social-url-${index}`,
                                    Boolean(rowError.url))}
                                className={rowError.url ? invalidClass : undefined}
                                onChange={(event) =>
                                    updateLink(link.key, { url: event.target.value })
                                }
                                onBlur={(event) => {
                                    const normalized = normalizeClientUrlInput(
                                        event.target.value);
                                    if (normalized !== null
                                        && normalized !== event.target.value.trim()) {
                                        updateLink(link.key, { url: normalized });
                                    }
                                }}
                            />
                            {rowError.url ? (
                                <span
                                    id={`social-url-${index}-error`}
                                    className="text-xs text-destructive"
                                >
                                    {rowError.url}
                                </span>
                            ) : null}
                        </div>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="self-end"
                            aria-label={`Remove social link ${index + 1}`}
                            onClick={() => removeLink(link.key)}
                        >
                            <Trash2 aria-hidden="true" />
                        </Button>
                    </div>
                    );
                })}
                {socialError ? (
                    <span id="client-social-links-error" className="text-xs text-destructive">
                        {socialError}
                    </span>
                ) : null}
                {links.length < 8 ? (
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="self-start"
                        onClick={addLink}
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
                    checked={values.isStealth}
                    onCheckedChange={(checked) =>
                        change('isStealth', checked === true)}
                />
                Stealth client (hidden identity in public listings)
            </label>
            <Field
                label="Anonymous description"
                htmlFor="client-anon-description"
                required={values.isStealth}
                error={fieldErrors.anonymousDescription}
            >
                <Textarea
                    id="client-anon-description"
                    name="anonymousDescription"
                    rows={2}
                    value={values.anonymousDescription}
                    aria-invalid={
                        fieldErrors.anonymousDescription ? true : undefined}
                    aria-describedby={describedBy(
                        'client-anon-description',
                        Boolean(fieldErrors.anonymousDescription))}
                    className={
                        fieldErrors.anonymousDescription ? invalidClass : undefined}
                    onChange={(event) =>
                        change('anonymousDescription', event.target.value)}
                />
            </Field>
            </fieldset>
            {error && (
                <p role="alert" className="text-sm text-destructive">
                    {error}
                </p>
            )}
            {dirty && newerSnapshot ? (
                <div role="status" className="flex flex-col gap-2 text-sm text-muted-foreground">
                    <p>This client has newer saved changes. Your unsaved edits are still here.</p>
                    <Button type="button" variant="outline" disabled={busy}
                        className="self-start" onClick={adoptLatest}>
                        Discard edits and load latest
                    </Button>
                </div>
            ) : null}
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

export function JobForm({
    clients,
    preselectedClientId,
    jobId,
    revisionId,
    expectedVersion,
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
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const documentRef = useRef<unknown>(
        initial?.descriptionDocument ?? EMPTY_JOB_DOCUMENT,
    );
    const [bonuses, setBonuses] = useState<JobBonus[]>(
        (initial?.bonuses ?? []).map((bonus) => ({
            type: bonus.type,
            details: bonus.details,
        })),
    );

    const submit = async (form: HTMLFormElement) => {
        const data = new FormData(form);
        const nullable = (key: string) => String(data.get(key) ?? '') || null;
        const fields = {
            title: String(data.get('title') ?? ''),
            employmentType: nullable('employmentType'),
            workplaceMode: nullable('workplaceMode'),
            locations: parseList(String(data.get('locations') ?? '')),
            remoteRegions: parseList(String(data.get('remoteRegions') ?? '')),
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
        router.push(targetId ? `/staff/jobs/${targetId}` : '/staff/jobs');
    };

    const updateBonus = (index: number, patch: Partial<JobBonus>) => {
        setBonuses((current) =>
            current.map((bonus, position) =>
                position === index ? { ...bonus, ...patch } : bonus,
            ),
        );
    };

    return (
        <form
            className="flex max-w-2xl flex-col gap-5"
            onSubmit={(event) => {
                event.preventDefault();
                setError(null);
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
            <Field label="Locations (comma-separated)" htmlFor="job-locations">
                <Input
                    id="job-locations"
                    name="locations"
                    defaultValue={initial?.locations?.join(', ') ?? ''}
                />
            </Field>
            <Field label="Remote regions (comma-separated)" htmlFor="job-remote-regions">
                <Input
                    id="job-remote-regions"
                    name="remoteRegions"
                    defaultValue={initial?.remoteRegions?.join(', ') ?? ''}
                />
            </Field>
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
                            onClick={() =>
                                setBonuses((current) =>
                                    current.filter((_, position) => position !== index),
                                )
                            }
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
                        onClick={() =>
                            setBonuses((current) => [
                                ...current,
                                { type: 'cash', details: '' },
                            ])
                        }
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

const subscribeListingReadiness = () => () => {};
const listingClientReady = () => true;
const listingServerReady = () => false;

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
    const ready = useSyncExternalStore(
        subscribeListingReadiness, listingClientReady, listingServerReady);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    return (
        <span className="inline-flex items-center gap-3">
            <Button
                variant="outline"
                size="sm"
                disabled={!ready || busy}
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
