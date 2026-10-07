import { notFound } from 'next/navigation';
import { DuplicateReviewsBrowser } from '@/app/staff/candidates/duplicates/reviews-browser';
import type { Comparison, CandidateProfile } from '@/app/staff/candidates/duplicates/comparison-panel';

export const dynamic = 'force-dynamic';

const reviews = [
    {
        id: '10000000-0000-4000-8000-000000000001',
        candidateAId: '10000000-0000-4000-8000-000000000011',
        candidateBId: '10000000-0000-4000-8000-000000000012',
        candidateAName: 'Alex Morgan',
        candidateBName: 'Alex Morgan',
        candidateAEmail: 'alex@example.test',
        candidateBEmail: 'alex@example.test',
        status: 'pending' as const,
        evidence: { emails: ['alex@example.test'], cvHashes: [] },
        newEvidence: false,
        version: 1,
        reviewedAt: null,
    },
    {
        id: '10000000-0000-4000-8000-000000000002',
        candidateAId: '10000000-0000-4000-8000-000000000013',
        candidateBId: '10000000-0000-4000-8000-000000000014',
        candidateAName: 'Sam Lee',
        candidateBName: 'Samuel Lee',
        candidateAEmail: 'sam.lee@example.test',
        candidateBEmail: 'samuel@example.test',
        status: 'pending' as const,
        evidence: { emails: [], cvHashes: ['synthetic-hash'] },
        newEvidence: false,
        version: 1,
        reviewedAt: null,
    },
];

const createdAt = '2026-09-12T10:00:00Z';
const capabilities = { readApplications: true, readNotes: true, downloadDocuments: true };

function profile(
    id: string,
    name: string,
    email: string,
    headline: string,
    location: string,
    summary: string,
    job: string,
    note: string,
    document?: { id: string; filename: string },
): CandidateProfile {
    return {
        candidate: {
            candidateId: id, fullName: name, email, professionalUrl: null,
            headline, location, professionalSummary: summary,
            ownerName: 'Demo recruiter', createdAt,
        },
        identifiers: [{ kind: 'email', value: email, verification: 'unverified' }],
        applications: [{
            applicationId: `${id}-application`, jobTitle: job, clientName: 'Sample client',
            stageLabel: 'Review', receivedAt: createdAt, submittedAchievement: summary,
        }],
        documents: document ? [{
            documentId: document.id, filename: document.filename, lifecycle: 'active',
            scanState: 'clean', sizeBytes: 81200, receivedAt: createdAt,
        }] : [],
        notes: [{ noteId: `${id}-note`, body: note, authorName: 'Demo recruiter', createdAt }],
        capabilities,
    };
}

const demoComparisons: Record<string, Comparison> = {
    [reviews[0].id]: {
        candidateA: profile(reviews[0].candidateAId, 'Alex Morgan', 'alex@example.test',
            'Growth strategist', 'London', 'B2B growth and community strategy.',
            'Marketing Lead', 'Met at a London conference.'),
        candidateB: profile(reviews[0].candidateBId, 'Alex Morgan', 'alex@example.test',
            'Smart contract engineer', 'Berlin', 'Solidity audits and protocol tooling.',
            'Founding Engineer', 'Imported from a recruiter chat. Identity is unverified.'),
        matchedEmails: ['alex@example.test'],
        matchedDocuments: [],
    },
    [reviews[1].id]: {
        candidateA: profile(reviews[1].candidateAId, 'Sam Lee', 'sam.lee@example.test',
            'Go engineer', 'Remote', 'Backend systems and distributed services.',
            'Sr Golang Engineer', 'Applied through the public site.',
            { id: 'sample-cv-a', filename: 'Sam-Lee-Resume.pdf' }),
        candidateB: profile(reviews[1].candidateBId, 'Samuel Lee', 'samuel@example.test',
            'Platform engineer', 'Madrid', 'Cloud infrastructure and Go services.',
            'Platform Engineer', 'Sourced by a recruiter; name needs confirmation.',
            { id: 'sample-cv-b', filename: 'Samuel-Profile.pdf' }),
        matchedEmails: [],
        matchedDocuments: [{
            candidateADocumentId: 'sample-cv-a', candidateAFilename: 'Sam-Lee-Resume.pdf',
            candidateBDocumentId: 'sample-cv-b', candidateBFilename: 'Samuel-Profile.pdf',
        }],
        demoCvExcerpt: 'Sam Lee\nBackend and platform engineer\nExperience: Go services, cloud infrastructure, distributed systems.\nThis is synthetic demo text; both example documents represent identical bytes.',
    },
};

export default function DuplicateReviewDemoPage() {
    if (process.env.NODE_ENV !== 'development') notFound();
    return (
        <div className="staff-scope min-h-screen bg-background px-4 py-8 text-foreground">
            <p className="mx-auto mb-6 w-full max-w-6xl text-xs text-muted-foreground">
                Local demo data
            </p>
            <DuplicateReviewsBrowser reviews={reviews} status="pending" demo
                demoComparisons={demoComparisons} />
        </div>
    );
}
