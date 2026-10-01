export type IntakeView = 'ready' | 'needs_information' | 'snoozed' | 'duplicates' | 'all';
export type MissingField = '' | 'cv' | 'firstName' | 'lastName' | 'primaryEmail';
export interface DraftFields {
    firstName?: string;
    lastName?: string;
    primaryEmail?: string;
    secondaryEmails?: string[];
    headline?: string;
    location?: string;
    professionalUrl?: string;
    professionalSummary?: string;
    compensationPreference?: string;
    telegramUsername?: string;
    telegramUserId?: string;
}
export interface IntakeDraft {
    id: string;
    version: number;
    status: 'pending' | 'snoozed' | 'duplicate' | 'approved' | 'discarded';
    fields: DraftFields;
    cv: { filename: string; status: string } | null;
    missingFields: string[];
    sourceTitle: string;
    updatedAt: string;
    candidateId?: string;
    evidenceCount?: number;
    evidenceTruncated?: boolean;
    evidence?: { id: string; text: string; senderName: string; sentAt: string }[];
}
export interface IntakeResult {
    drafts: IntakeDraft[];
    counts: Record<IntakeView, number>;
    page: number;
    hasMore: boolean;
}

export const viewLabels: Record<IntakeView, string> = {
    ready: 'Ready', needs_information: 'Needs information', snoozed: 'Snoozed',
    duplicates: 'Duplicates', all: 'All drafts',
};
export const fieldLabels: Record<string, string> = {
    firstName: 'First name', lastName: 'Last name', primaryEmail: 'Primary email',
    secondaryEmails: 'Secondary emails', headline: 'Headline', location: 'Location',
    professionalUrl: 'Professional URL', professionalSummary: 'Professional summary',
    compensationPreference: 'Compensation preference', telegramUsername: 'Telegram username', cv: 'CV',
};

export function draftName(draft: IntakeDraft) {
    return [draft.fields.firstName, draft.fields.lastName].filter(Boolean).join(' ') || 'Unnamed draft';
}

export function draftStatus(draft: IntakeDraft) {
    if (draft.status !== 'pending') return draft.status.charAt(0).toUpperCase() + draft.status.slice(1);
    return draft.missingFields.length ? 'Needs information' : 'Ready';
}

export function editableFields(fields: DraftFields) {
    return Object.fromEntries(Object.keys(fieldLabels).filter(key => key !== 'cv').map(key => [key,
        key === 'secondaryEmails' ? (fields.secondaryEmails ?? []).join('\n') : fields[key] ?? '',
    ])) as Record<string, string>;
}

export function fieldsForSave(fields: Record<string, string>): DraftFields {
    return { ...fields, secondaryEmails: (fields.secondaryEmails ?? '').split(/[\n,;]/).map(value => value.trim()).filter(Boolean) };
}

export function errorFields(value: unknown): Record<string, string> {
    if (Array.isArray(value)) return Object.fromEntries(value.map(key => [String(key), `${fieldLabels[String(key)] ?? key} is required.`]));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, error]) => [key, Array.isArray(error) ? error.join(' ') : String(error)]));
    return {};
}
