'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FileSpreadsheet, RotateCcw, Upload } from 'lucide-react';

import { Badge } from '@/components/staff-ui/badge';
import { Button } from '@/components/staff-ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/staff-ui/card';
import { Checkbox } from '@/components/staff-ui/checkbox';
import { Input } from '@/components/staff-ui/input';
import { Label } from '@/components/staff-ui/label';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/staff-ui/table';
import { cn } from '@/lib/utils';
import type { ImportReviewRow, RecruitmentContext } from '@/lib/recruitment-types';
import { isUuid } from '@/lib/recruitment-contracts';
import { useUnsavedChangesGuard } from '../../form-guard';
import {
    CSV_MAX_BYTES,
    CsvParseError,
    parseCsv,
    suggestColumnTarget,
} from '@/lib/csv-parse';

type ImportStep = 'file' | 'map' | 'review' | 'results';

type CsvData = {
    headers: string[];
    labels: string[];
    rows: string[][];
};

type ReviewRow = ImportReviewRow & {
    selected: boolean;
};

type CommitResult = {
    status: string;
    candidateId: string | null;
};

const COMMIT_STATUSES = new Set(['created', 'replayed', 'duplicate', 'blocked']);
const REVIEW_STATUSES = new Set([
    'ready', 'invalid', 'duplicate', 'blocked', 'possible_match',
]);

const STEPS: { key: ImportStep; label: string }[] = [
    { key: 'file', label: 'File' },
    { key: 'map', label: 'Map columns' },
    { key: 'review', label: 'Review' },
    { key: 'results', label: 'Results' },
];

const TARGETS: { key: string; label: string; required?: boolean }[] = [
    { key: 'fullName', label: 'Name', required: true },
    { key: 'email', label: 'Email' },
    { key: 'headline', label: 'Role / headline' },
    { key: 'location', label: 'Location' },
    { key: 'tags', label: 'Tags' },
    { key: 'professionalSummary', label: 'Summary' },
    { key: 'notes', label: 'Notes' },
];

const NOTE_TARGET = 'notes';

const selectClass =
    'w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring';

const splitTags = (value: string): string[] => {
    const seen = new Set<string>();
    for (const piece of value.split(/[;,|]/)) {
        const tag = piece.trim();
        if (tag !== '' && !seen.has(tag.toLowerCase())) {
            seen.add(tag.toLowerCase());
        }
    }
    return Array.from(seen);
};

const rowPreview = (row: string[], mapping: Record<string, number>) => {
    const name = mapping.fullName !== undefined
        ? (row[mapping.fullName] ?? '').trim()
        : '';
    const email = mapping.email !== undefined
        ? (row[mapping.email] ?? '').trim()
        : '';
    return { name, email };
};

export function ImportWizard({ context }: { context: RecruitmentContext }) {
    const router = useRouter();
    const [step, setStep] = useState<ImportStep>('file');
    const [csv, setCsv] = useState<CsvData | null>(null);
    const [fileName, setFileName] = useState('');
    const [error, setError] = useState('');
    const [mapping, setMapping] = useState<Record<string, number>>({});
    const [owner, setOwner] = useState<string>(
        context.currentMembershipId ?? '',
    );
    const [sharedTag, setSharedTag] = useState('');
    const [jobId, setJobId] = useState('');
    const [reviewRows, setReviewRows] = useState<ReviewRow[]>([]);
    const [results, setResults] = useState<CommitResult[]>([]);
    const [busy, setBusy] = useState(false);
    const [confirmed, setConfirmed] = useState(false);
    const operationIdsRef = useRef<Map<string, string>>(new Map());

    const dirty = csv !== null && step !== 'results';
    useUnsavedChangesGuard({ dirty });

    const operationIdFor = (index: number) => {
        const key = String(index);
        const existing = operationIdsRef.current.get(key);
        if (existing) return existing;
        const created = crypto.randomUUID();
        operationIdsRef.current.set(key, created);
        return created;
    };

    const buildRecord = (row: string[], index: number) => {
        const value = (target: string) =>
            mapping[target] !== undefined
                ? (row[mapping[target]] ?? '').trim()
                : '';
        const shared = splitTags(sharedTag);
        const mapped = splitTags(value('tags'));
        const seen = new Set(shared.map((tag) => tag.toLowerCase()));
        const tags = [...shared];
        for (const tag of mapped) {
            if (!seen.has(tag.toLowerCase())) {
                seen.add(tag.toLowerCase());
                tags.push(tag);
            }
        }
        return {
            fields: {
                fullName: value('fullName'),
                headline: value('headline') || null,
                location: value('location') || null,
                email: value('email') || null,
                professionalUrl: null,
                ownerMembershipId: owner || null,
                professionalSummary: value('professionalSummary') || null,
                availability: 'not_specified',
                tags,
                skills: [],
                experience: [],
                source: 'import',
            },
            note: value('notes') || null,
            operationId: operationIdFor(index),
        };
    };

    const onFile = async (file: File | undefined) => {
        setError('');
        if (!file) return;
        if (file.size > CSV_MAX_BYTES) {
            setError('The file is larger than 1 MB. Split it into smaller files.');
            return;
        }
        try {
            const bytes = await file.arrayBuffer();
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            const parsed = parseCsv(text);
            if (parsed.rows.length === 0) {
                setError('The CSV file has no data rows.');
                return;
            }
            setCsv(parsed);
            setFileName(file.name);
            const next: Record<string, number> = {};
            parsed.labels.forEach((label, position) => {
                const target = suggestColumnTarget(label);
                if (target && next[target] === undefined) next[target] = position;
            });
            setMapping(next);
            setReviewRows([]);
            setResults([]);
            setConfirmed(false);
            operationIdsRef.current = new Map();
            setStep('map');
        } catch (parseError) {
            setError(
                parseError instanceof CsvParseError
                    ? parseError.message
                    : 'The CSV file must be valid UTF-8 text.',
            );
        }
    };

    const reset = () => {
        setCsv(null);
        setFileName('');
        setMapping({});
        setReviewRows([]);
        setResults([]);
        setError('');
        setConfirmed(false);
        setStep('file');
        operationIdsRef.current = new Map();
    };

    const payloadError = (payload: { error?: unknown; fields?: unknown } | null) => {
        if (payload && typeof payload.error === 'string') return payload.error;
        const fields = payload?.fields;
        if (fields && typeof fields === 'object') {
            const first = Object.values(fields).find(
                (value) => typeof value === 'string' && value !== '');
            if (typeof first === 'string') return first;
        }
        return null;
    };

    const mappingConflict = (): boolean => {
        const used = new Set<number>();
        for (const position of Object.values(mapping)) {
            if (used.has(position)) return true;
            used.add(position);
        }
        return false;
    };

    const startReview = async () => {
        if (!csv) return;
        if (mappingConflict()) {
            setError('Each column can only feed one field.');
            return;
        }
        setBusy(true);
        setError('');
        try {
            const records = csv.rows.map((row, index) => buildRecord(row, index));
            const response = await fetch('/api/staff/candidates/import', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    accept: 'application/json',
                },
                body: JSON.stringify({
                    action: 'review',
                    jobId: jobId || undefined,
                    records,
                }),
            });
            const payload = await response.json().catch(() => null);
            if (!response.ok) {
                setError(
                    payloadError(payload)
                        ?? 'The import could not be reviewed. Check the file and try again.',
                );
                return;
            }
            const review = payload?.result?.rows;
            const valid = Array.isArray(review)
                && review.length === csv.rows.length
                && review.every((row) =>
                    Number.isInteger(row?.index)
                    && row.index >= 0
                    && row.index < csv.rows.length
                    && REVIEW_STATUSES.has(row?.status));
            if (!valid) {
                setError('The review result was incomplete. Try again.');
                return;
            }
            setReviewRows(
                (review as ImportReviewRow[]).map((row) => ({
                    ...row,
                    selected: row.status === 'ready',
                })),
            );
            setConfirmed(false);
            setStep('review');
        } catch {
            setError('The review request failed. Check your connection and try again.');
        } finally {
            setBusy(false);
        }
    };

    const commit = async () => {
        if (!csv || !confirmed) return;
        const chosen = reviewRows.filter((row) => row.selected);
        setBusy(true);
        setError('');
        try {
            const records = chosen.map((row) =>
                buildRecord(csv.rows[row.index], row.index));
            const response = await fetch('/api/staff/candidates/import', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    accept: 'application/json',
                },
                body: JSON.stringify({
                    action: 'commit',
                    jobId: jobId || undefined,
                    records,
                }),
            });
            const payload = await response.json().catch(() => null);
            if (!response.ok) {
                setError(
                    payloadError(payload)
                        ?? 'The import failed. Check your connection and try again.',
                );
                return;
            }
            const outcome = payload?.result?.results;
            const valid = Array.isArray(outcome)
                && outcome.length === chosen.length
                && outcome.every((entry) =>
                    COMMIT_STATUSES.has(entry?.status)
                    && (entry.status === 'blocked' || isUuid(entry.candidateId)));
            if (!valid) {
                setError(
                    'The import result was incomplete. Nothing new was added; review the rows and try again.',
                );
                return;
            }
            setResults(outcome as CommitResult[]);
            setStep('results');
            router.refresh();
        } catch {
            setError('The import request failed. Check your connection and try again.');
        } finally {
            setBusy(false);
        }
    };

    const selectedCount = reviewRows.filter((row) => row.selected).length;
    const resultCounts = useMemo(() => {
        const counts = { created: 0, duplicate: 0, other: 0 };
        for (const result of results) {
            if (result.status === 'created' || result.status === 'replayed') {
                counts.created += 1;
            } else if (result.status === 'duplicate') {
                counts.duplicate += 1;
            } else {
                counts.other += 1;
            }
        }
        return counts;
    }, [results]);

    const stepIndex = STEPS.findIndex((entry) => entry.key === step);
    const targets = context.capabilities?.writeNotes === true
        ? TARGETS
        : TARGETS.filter((target) => target.key !== NOTE_TARGET);
    const canAddApplications = context.capabilities?.addApplications === true;

    return (
        <div className="flex flex-col gap-6">
            <ol className="flex flex-wrap items-center gap-2">
                {STEPS.map((entry, index) => (
                    <li
                        key={entry.key}
                        className={cn(
                            'flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium',
                            index === stepIndex
                                ? 'border-ring bg-nav-active text-foreground'
                                : index < stepIndex
                                  ? 'border-border text-foreground'
                                  : 'border-border text-muted-foreground',
                        )}
                        aria-current={index === stepIndex ? 'step' : undefined}
                    >
                        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-secondary text-[10px]">
                            {index + 1}
                        </span>
                        {entry.label}
                    </li>
                ))}
            </ol>

            {error ? (
                <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {error}
                </p>
            ) : null}

            {step === 'file' ? (
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Choose a CSV file</CardTitle>
                        <CardDescription>
                            Up to 1 MB and 100 rows. The first row must be a header row.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <label className="flex cursor-pointer flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-10 text-center hover:bg-secondary/30">
                            <FileSpreadsheet
                                className="h-8 w-8 text-muted-foreground"
                                aria-hidden="true"
                            />
                            <span className="text-sm font-medium text-foreground">
                                Select a CSV file
                            </span>
                            <span className="text-xs text-muted-foreground">
                                Names, emails, roles, locations, tags, summaries or notes.
                            </span>
                            <input
                                type="file"
                                accept=".csv,text/csv"
                                className="sr-only"
                                data-testid="import-file-input"
                                onChange={(event) => onFile(event.target.files?.[0])}
                            />
                        </label>
                    </CardContent>
                </Card>
            ) : null}

            {step === 'map' && csv ? (
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Map columns</CardTitle>
                        <CardDescription>
                            {fileName} · {csv.rows.length} row{csv.rows.length === 1 ? '' : 's'}.
                            Choose which column feeds each candidate field.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-5">
                        <div className="grid gap-4 sm:grid-cols-2">
                            {targets.map((target) => (
                                <div key={target.key} className="flex flex-col gap-1.5">
                                    <Label htmlFor={`map-${target.key}`}>
                                        {target.label}
                                        {target.required ? ' (required)' : ''}
                                    </Label>
                                    <select
                                        id={`map-${target.key}`}
                                        className={selectClass}
                                        value={mapping[target.key] ?? ''}
                                        onChange={(event) => {
                                            const next = { ...mapping };
                                            if (event.target.value === '') {
                                                delete next[target.key];
                                            } else {
                                                next[target.key] = Number(event.target.value);
                                            }
                                            setMapping(next);
                                            setConfirmed(false);
                                            setReviewRows([]);
                                        }}
                                    >
                                        <option value="">Skip</option>
                                        {csv.labels.map((label, position) => (
                                            <option key={position} value={position}>
                                                {label}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            ))}
                        </div>

                        <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-3">
                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor="import-owner">Owner</Label>
                                <select
                                    id="import-owner"
                                    className={selectClass}
                                    value={owner}
                                    onChange={(event) => setOwner(event.target.value)}
                                >
                                    <option value="">Unassigned</option>
                                    {(context.owners ?? []).map((entry) => (
                                        <option key={entry.id} value={entry.id}>
                                            {entry.name}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor="import-tag">Tag every row</Label>
                                <Input
                                    id="import-tag"
                                    placeholder="e.g. fintech-talent"
                                    value={sharedTag}
                                    onChange={(event) => setSharedTag(event.target.value)}
                                />
                            </div>
                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor="import-job">Add to job (optional)</Label>
                                <select
                                    id="import-job"
                                    className={selectClass}
                                    value={canAddApplications ? jobId : ''}
                                    disabled={!canAddApplications}
                                    onChange={(event) => {
                                        setJobId(event.target.value);
                                        setConfirmed(false);
                                    }}
                                >
                                    <option value="">Do not add</option>
                                    {(context.jobs ?? []).map((job) => (
                                        <option key={job.id} value={job.id}>
                                            {job.title}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        </div>

                        <div className="flex items-center justify-between gap-3">
                            <Button variant="ghost" onClick={reset}>
                                <RotateCcw aria-hidden="true" />
                                Choose another file
                            </Button>
                            <Button
                                onClick={() => void startReview()}
                                disabled={mapping.fullName === undefined || busy}
                            >
                                <Upload aria-hidden="true" />
                                {busy ? 'Checking…' : 'Review import'}
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            ) : null}

            {step === 'review' && csv ? (
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Review rows</CardTitle>
                        <CardDescription>
                            Select the rows to import. Rows flagged as invalid,
                            duplicate or blocked cannot be imported.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-4">
                        <div className="overflow-hidden rounded-lg border border-border">
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead className="w-10">Include</TableHead>
                                        <TableHead>Name</TableHead>
                                        <TableHead className="hidden sm:table-cell">Email</TableHead>
                                        <TableHead>Status</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {reviewRows.map((row) => {
                                        const preview = rowPreview(
                                            csv.rows[row.index], mapping,
                                        );
                                        const selectable =
                                            row.status === 'ready'
                                            || row.status === 'possible_match';
                                        return (
                                            <TableRow key={row.index}>
                                                <TableCell>
                                                    <Checkbox
                                                        checked={row.selected}
                                                        disabled={!selectable}
                                                        onCheckedChange={(checked) =>
                                                            setReviewRows((current) =>
                                                                current.map((entry) =>
                                                                    entry.index === row.index
                                                                        ? { ...entry, selected: checked === true }
                                                                        : entry,
                                                                ),
                                                            )
                                                        }
                                                        aria-label={`Include row ${row.index + 2}`}
                                                    />
                                                </TableCell>
                                                <TableCell className="font-medium">
                                                    {preview.name || '—'}
                                                </TableCell>
                                                <TableCell className="hidden text-muted-foreground sm:table-cell">
                                                    {preview.email || '—'}
                                                </TableCell>
                                                <TableCell>
                                                    <div className="flex flex-col gap-1">
                                                        <Badge
                                                            variant={
                                                                row.status === 'ready'
                                                                    ? 'secondary'
                                                                    : 'outline'
                                                            }
                                                        >
                                                            {row.status === 'possible_match'
                                                                ? 'Possible match'
                                                                : row.status}
                                                        </Badge>
                                                        {row.reason ? (
                                                            <span className="text-xs text-muted-foreground">
                                                                {row.reason}
                                                            </span>
                                                        ) : null}
                                                    </div>
                                                </TableCell>
                                            </TableRow>
                                        );
                                    })}
                                </TableBody>
                            </Table>
                        </div>
                        <div className="flex items-start gap-3 rounded-md border border-border px-3 py-2">
                            <Checkbox
                                id="import-confirm"
                                checked={confirmed}
                                onCheckedChange={(checked) =>
                                    setConfirmed(checked === true)}
                            />
                            <Label htmlFor="import-confirm" className="text-sm font-normal">
                                I reviewed these rows and want to add them to the
                                workspace.
                            </Label>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                            <Button
                                variant="ghost"
                                onClick={() => {
                                    setConfirmed(false);
                                    setStep('map');
                                }}
                            >
                                Back to mapping
                            </Button>
                            <Button
                                onClick={() => void commit()}
                                disabled={selectedCount === 0 || !confirmed || busy}
                            >
                                {busy
                                    ? 'Importing…'
                                    : `Import ${selectedCount} candidate${selectedCount === 1 ? '' : 's'}`}
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            ) : null}

            {step === 'results' ? (
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Import complete</CardTitle>
                        <CardDescription>
                            {resultCounts.created} candidate{resultCounts.created === 1 ? '' : 's'} added.
                            {resultCounts.duplicate > 0
                                ? ` ${resultCounts.duplicate} skipped as duplicates.`
                                : ''}
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-4">
                        <div className="overflow-hidden rounded-lg border border-border">
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>Row</TableHead>
                                        <TableHead>Result</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {reviewRows
                                        .filter((row) => row.selected)
                                        .map((row, position) => (
                                            <TableRow key={row.index}>
                                                <TableCell className="text-muted-foreground">
                                                    {row.index + 2}
                                                </TableCell>
                                                <TableCell>
                                                    {results[position]?.status === 'created'
                                                        || results[position]?.status === 'replayed'
                                                        ? 'Added'
                                                        : results[position]?.status === 'duplicate'
                                                          ? 'Skipped — existing candidate'
                                                          : 'Not imported'}
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                </TableBody>
                            </Table>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                            <Button variant="ghost" onClick={reset}>
                                Import another file
                            </Button>
                            <Button asChild>
                                <Link href="/staff/candidates">View candidates</Link>
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            ) : null}
        </div>
    );
}
