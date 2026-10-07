'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Download, ExternalLink } from 'lucide-react';

export interface CandidateProfile {
    candidate: {
        candidateId: string;
        fullName: string | null;
        email?: string | null;
        professionalUrl?: string | null;
        headline?: string | null;
        location?: string | null;
        professionalSummary: string | null;
        ownerName: string | null;
        createdAt: string;
        version?: string;
    };
    identifiers: { kind: string; value: string; verification: string }[];
    applications: {
        applicationId: string;
        jobTitle: string;
        clientName: string;
        stageLabel: string;
        receivedAt: string;
        submittedAchievement: string | null;
    }[];
    documents: {
        documentId: string;
        filename: string;
        lifecycle: string;
        scanState: string;
        sizeBytes: number;
        receivedAt: string;
    }[];
    notes: { noteId: string; body: string; authorName: string | null; createdAt: string }[];
    capabilities: { readApplications: boolean; readNotes: boolean; downloadDocuments: boolean };
}

export interface Comparison {
    candidateA: CandidateProfile;
    candidateB: CandidateProfile;
    matchedEmails: string[];
    matchedDocuments: {
        candidateADocumentId: string;
        candidateAFilename: string;
        candidateBDocumentId: string;
        candidateBFilename: string;
    }[];
    canMerge?: boolean;
    demoCvExcerpt?: string;
}

const date = (value: string) => new Date(value).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
});

function Profile({
    profile, side, matchedIds, matchedEmails, demo,
}: {
    profile: CandidateProfile;
    side: 'A' | 'B';
    matchedIds: Set<string>;
    matchedEmails: Set<string>;
    demo: boolean;
}) {
    const { candidate, identifiers, applications, documents, notes, capabilities } = profile;
    const email = candidate.email ?? identifiers.find((item) => item.kind === 'email')?.value;
    const url = candidate.professionalUrl
        ?? identifiers.find((item) => item.kind === 'professional_url')?.value;
    const isMatchedEmail = (value: string) => matchedEmails.has(value.trim().toLowerCase());
    const primaryEmailMatches = Boolean(email && isMatchedEmail(email));
    const otherEmails = Array.from(new Set(identifiers
        .filter((item) => item.kind === 'email'
            && item.value.trim().toLowerCase() !== email?.trim().toLowerCase())
        .map((item) => item.value)));
    return <section aria-label={`Candidate ${side} profile`} className="min-w-0 space-y-5">
        <div className="space-y-1">
            <span className="text-xs font-semibold uppercase text-muted-foreground">Candidate {side}</span>
            <h3 className="text-lg font-semibold text-foreground">{candidate.fullName || 'Unnamed candidate'}</h3>
            {candidate.headline ? <p className="text-sm">{candidate.headline}</p> : null}
            {candidate.location ? <p className="text-sm text-muted-foreground">{candidate.location}</p> : null}
            {!demo ? <Link href={`/staff/candidates/${candidate.candidateId}`}
                target="_blank" rel="noopener"
                className="inline-flex items-center gap-1 text-sm text-primary underline underline-offset-4">
                Full profile <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </Link> : null}
        </div>
        <dl className="space-y-3 text-sm">
            <div className={primaryEmailMatches
                ? 'border-l-2 border-attention bg-attention/20 px-3 py-2' : ''}>
                <dt className="text-xs text-muted-foreground">Email</dt>
                <dd className="break-all">{email || 'Not provided'}</dd>
                {primaryEmailMatches ? <dd className="mt-1 text-xs font-semibold text-attention-foreground">
                    Shared email</dd> : null}
            </div>
            {otherEmails.map((value) => <div key={value}
                className={isMatchedEmail(value)
                    ? 'border-l-2 border-attention bg-attention/20 px-3 py-2' : ''}>
                <dt className="text-xs text-muted-foreground">
                    {isMatchedEmail(value) ? 'Additional shared email' : 'Other email'}
                </dt>
                <dd className="break-all">{value}</dd>
            </div>)}
            <div><dt className="text-xs text-muted-foreground">Professional URL</dt>
                <dd className="break-all">{url ? <a href={url} target="_blank" rel="noreferrer"
                    className="text-primary underline underline-offset-4">{url}</a> : 'Not provided'}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Owner</dt>
                <dd>{candidate.ownerName || 'Unassigned'}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Record created</dt>
                <dd>{date(candidate.createdAt)}</dd></div>
        </dl>
        {candidate.professionalSummary ? <div>
            <h4 className="mb-1 text-sm font-semibold">Summary</h4>
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">{candidate.professionalSummary}</p>
        </div> : null}
        <div>
            <h4 className="mb-2 text-sm font-semibold">CVs and documents</h4>
            {documents.length === 0 ? <p className="text-sm text-muted-foreground">No documents on file.</p> :
                <ul className="space-y-2">{documents.map((document) => <li key={document.documentId}
                    className={`border-l-2 px-3 py-2 text-sm ${matchedIds.has(document.documentId)
                        ? 'border-attention bg-attention/20' : 'border-border'}`}>
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="break-all font-medium">{document.filename}</span>
                        {matchedIds.has(document.documentId) ? <span
                            className="text-xs font-semibold text-attention-foreground">Identical CV content</span> : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                        {date(document.receivedAt)} · {Math.round(document.sizeBytes / 1024)} KB
                        {document.scanState !== 'clean' ? ` · ${document.scanState}` : ''}
                    </p>
                    {!demo && capabilities.downloadDocuments && document.lifecycle === 'active'
                        ? <a href={`/api/staff/documents/${document.documentId}`}
                            className="inline-flex items-center gap-1 text-xs text-primary underline underline-offset-4">
                            <Download className="h-3 w-3" aria-hidden="true" /> Download CV
                        </a> : null}
                </li>)}</ul>}
        </div>
        <div>
            <h4 className="mb-2 text-sm font-semibold">Applications</h4>
            {!capabilities.readApplications ? <p className="text-sm text-muted-foreground">Application details are restricted.</p>
                : applications.length === 0 ? <p className="text-sm text-muted-foreground">No applications on file.</p>
                    : <ul className="space-y-3">{applications.map((application) => <li
                        key={application.applicationId} className="border-l-2 border-border pl-3 text-sm">
                        <p className="font-medium">{application.jobTitle}</p>
                        <p className="text-xs text-muted-foreground">
                            {application.clientName} · {application.stageLabel} · {date(application.receivedAt)}
                        </p>
                        {application.submittedAchievement ? <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                            {application.submittedAchievement}</p> : null}
                    </li>)}</ul>}
        </div>
        <div>
            <h4 className="mb-2 text-sm font-semibold">Notes</h4>
            {!capabilities.readNotes ? <p className="text-sm text-muted-foreground">Notes are restricted.</p>
                : notes.length === 0 ? <p className="text-sm text-muted-foreground">No notes yet.</p>
                    : <ul className="space-y-3">{notes.map((note) => <li key={note.noteId}
                        className="border-l-2 border-border pl-3 text-sm">
                        <p className="whitespace-pre-wrap">{note.body}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                            {note.authorName || 'Staff'} · {date(note.createdAt)}
                        </p>
                    </li>)}</ul>}
        </div>
    </section>;
}

export function ComparisonPanel({
    comparison, hasEmailMatch, hasCvMatch, demo, actions,
}: {
    comparison: Comparison;
    hasEmailMatch: boolean;
    hasCvMatch: boolean;
    demo: boolean;
    actions: ReactNode;
}) {
    const matchedA = new Set(comparison.matchedDocuments.map((item) => item.candidateADocumentId));
    const matchedB = new Set(comparison.matchedDocuments.map((item) => item.candidateBDocumentId));
    const matchedEmails = new Set(comparison.matchedEmails.map((value) => value.trim().toLowerCase()));
    return <div className="space-y-5">
        <section aria-label="Match evidence" className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <h3 className="pt-1 text-sm font-semibold">Why these records were flagged</h3>
                {actions}
            </div>
            {hasEmailMatch ? <p className="border-l-2 border-attention bg-attention/20 px-3 py-2 text-sm">
                <span className="font-medium">Shared email:</span>{' '}
                {comparison.matchedEmails.join(', ') || 'Matching email identifier'}
            </p> : null}
            {hasCvMatch ? <div className="space-y-2 text-sm">
                <p className="font-medium">Identical CV file contents</p>
                {comparison.matchedDocuments.length > 0 ? comparison.matchedDocuments.map((match) =>
                    <div key={`${match.candidateADocumentId}:${match.candidateBDocumentId}`}
                        className="grid gap-1 border-l-2 border-attention bg-attention/20 px-3 py-2 sm:grid-cols-2">
                        <span className="break-all">A: {match.candidateAFilename}</span>
                        <span className="break-all">B: {match.candidateBFilename}</span>
                    </div>) : <p className="text-muted-foreground">
                    The files matched when flagged, but no active CV is available to inspect.
                </p>}
                {demo && comparison.demoCvExcerpt ? <details>
                    <summary className="cursor-pointer text-primary underline underline-offset-4">Preview sample CV</summary>
                    <p className="mt-2 whitespace-pre-wrap border-l-2 border-border pl-3 text-muted-foreground">
                        {comparison.demoCvExcerpt}</p>
                </details> : null}
            </div> : null}
        </section>
        <div className="grid min-w-0 gap-8 border-t border-border pt-5 md:grid-cols-2">
            <Profile profile={comparison.candidateA} side="A" matchedIds={matchedA}
                matchedEmails={matchedEmails}
                demo={demo} />
            <Profile profile={comparison.candidateB} side="B" matchedIds={matchedB}
                matchedEmails={matchedEmails}
                demo={demo} />
        </div>
    </div>;
}
