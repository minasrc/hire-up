
export interface CandidateExperienceEntry {
    role: string;
    company: string;
    period: string;
    description: string;
}

export interface CandidateFields {
    fullName: string;
    headline: string | null;
    location: string | null;
    email: string | null;
    professionalUrl: string | null;
    ownerMembershipId: string | null;
    professionalSummary: string | null;
    availability: 'not_specified' | 'open';
    tags: string[];
    skills: string[];
    experience: CandidateExperienceEntry[];
    source: 'manual' | 'referral' | 'import';
}

export interface CandidateDocumentMetadata {
    sha256: string;
    sizeBytes: number;
    mimeType: string;
    extension: string;
    bucket: string;
    objectKey: string;
    filename: string;
}

export interface RecruitmentCapabilities {
    readCandidates: boolean;
    writeCandidates: boolean;
    readApplications: boolean;
    addApplications: boolean;
    readJobs: boolean;
    writeJobs: boolean;
    readClients: boolean;
    writeClients: boolean;
    uploadDocuments: boolean;
    downloadDocuments: boolean;
    managePrivacy: boolean;
    readNotes?: boolean;
    writeNotes?: boolean;
    changeStage?: boolean;
}

export interface RecruitmentContextOwner {
    id: string;
    name: string;
}

export interface RecruitmentContextJob {
    id: string;
    title: string;
    clientId: string;
    clientName: string;
    publicationState: string;
    applicationState: string;
    publiclyListed: boolean;
}

export interface RecruitmentContext {
    currentMembershipId: string;
    capabilities: RecruitmentCapabilities;
    owners: RecruitmentContextOwner[];
    tags: string[];
    jobs: RecruitmentContextJob[];
}

export interface CandidateCard {
    candidateId: string;
    fullName: string;
    headline?: string | null;
    location?: string | null;
    professionalSummary?: string | null;
    email?: string | null;
    professionalUrl?: string | null;
    lifecycle: string;
    availability?: string;
    tags: string[];
    skills?: string[];
    experience?: CandidateExperienceEntry[];
    ownerMembershipId?: string | null;
    ownerName?: string | null;
    source?: string | null;
    applicationCount?: number | null;
    currentDocumentId?: string | null;
    hasCv?: boolean;
    createdAt: string;
    version: string;
}

export interface CandidateDirectoryCounts {
    all: number;
    restricted: number;
    withApplications: number | null;
}

export interface CandidateDirectoryResult {
    candidates: CandidateCard[];
    total: number;
    page: number;
    pageSize: number;
    counts: CandidateDirectoryCounts;
    context: RecruitmentContext;
}

export interface CandidateIdentifier {
    kind: string;
    value: string;
    verification: string;
}

export interface ApplicationHistoryEntry {
    sequence: number;
    fromStageLabel: string | null;
    toStageLabel: string;
    actorName: string | null;
    reason: string | null;
    occurredAt: string;
}

export interface CandidateApplication {
    applicationId: string;
    jobId?: string;
    jobTitle: string;
    clientId?: string;
    clientName: string;
    pipelineId: string;
    stageId: string;
    stageLabel: string;
    stageKind: string;
    publicReference: string;
    submittedName: string | null;
    submittedEmail: string | null;
    submittedProfessionalUrl: string | null;
    submittedAchievement: string | null;
    receivedAt: string;
    version: string;
    ownerMembershipId?: string | null;
    ownerName?: string | null;
    source?: string | null;
    history: ApplicationHistoryEntry[];
}

export interface CandidateDocument {
    documentId: string;
    filename: string;
    purpose: string;
    lifecycle: string;
    scanState: string;
    mimeType?: string | null;
    sizeBytes: number;
    receivedAt: string;
    current?: boolean;
    supersedesDocumentId?: string | null;
    version?: number;
}

export interface CandidateNote {
    noteId: string;
    body: string;
    authorName: string | null;
    createdAt: string;
}

export interface CandidateStage {
    stageId: string;
    pipelineId: string;
    key: string;
    label: string;
    kind: string;
    position: number;
}

export interface CandidateWorkspace {
    candidate: CandidateCard & {
        version: string;
        professionalSummary: string | null;
    };
    identifiers: CandidateIdentifier[];
    applications: CandidateApplication[];
    stages: CandidateStage[];
    documents: CandidateDocument[];
    notes: CandidateNote[];
    capabilities: RecruitmentCapabilities;
    context?: RecruitmentContext;
}

export interface ApplicationCard {
    applicationId: string;
    candidateId: string;
    candidateName: string;
    candidateLocation: string | null;
    jobId: string;
    jobTitle: string;
    clientId: string;
    clientName: string;
    stageId: string;
    stageKey: string;
    stageLabel: string;
    stageKind: string;
    stageIsInitial: boolean;
    pipelineId: string;
    receivedAt: string;
    publicReference: string;
    version: string;
    ownerMembershipId: string | null;
    ownerName: string | null;
    source: string | null;
}

export interface ApplicationStageCount {
    key: string;
    label: string;
    kind: string;
    count: number;
}

export interface ApplicationDirectoryResult {
    applications: ApplicationCard[];
    total: number;
    page: number;
    pageSize: number;
    allCount: number;
    stages: ApplicationStageCount[];
    clients: { id: string; name: string }[];
    jobs: { id: string; title: string; clientId: string }[];
    context: RecruitmentContext;
}

export interface StaffJobCard {
    id: string;
    title: string;
    clientId: string;
    clientName: string;
    clientIsStealth: boolean;
    slug: string;
    publicationState: string;
    applicationState: string;
    publiclyListed: boolean;
    publishedRevisionId: string | null;
    draftRevisionId: string | null;
    ownerMembershipId: string | null;
    version: string;
    createdAt: string;
    employmentType: string | null;
    workplaceMode: string | null;
    locations: string[];
    remoteRegions: string[];
    descriptionText: string;
    applicationCount: number | null;
}

export interface JobRevision {
    id: string;
    jobId: string;
    revisionNumber: number;
    version: string;
    status: string;
    title: string;
    employmentType: string | null;
    workplaceMode: string | null;
    locations: string[];
    remoteRegions: string[];
    descriptionDocument?: unknown;
    descriptionText?: string | null;
    compensationMin?: string | null;
    compensationMax?: string | null;
    currency?: string | null;
    payPeriod?: string | null;
    publishedAt?: string | null;
    publishedCompanyName?: string | null;
    [key: string]: unknown;
}

export interface JobWorkspace {
    job: StaffJobCard & Record<string, unknown>;
    draft: JobRevision | null;
    published: JobRevision | null;
    publicationNeedsReview?: boolean;
    context?: RecruitmentContext;
    [key: string]: unknown;
}

export interface ClientWorkspace {
    client: {
        id: string;
        name: string;
        status: string;
        contactName: string | null;
        contactEmail: string | null;
        telegramUsername?: string | null;
        website: string | null;
        socialLinks?: { platform: string; url: string }[] | null;
        isStealth: boolean;
        anonymousDescription: string | null;
        version: string;
        [key: string]: unknown;
    };
    context: RecruitmentContext;
    jobs: StaffJobCard[];
    jobTotal: number | null;
    openRoles: number | null;
    applicationCount: number | null;
    interviewingCount: number | null;
    recentApplications: ApplicationCard[];
}

export interface PrivacyCaseSubject {
    subjectId: string;
    candidateId: string | null;
    legacyRecordId: string | null;
    reviewedAt: string | null;
}

export interface PrivacyCaseEvent {
    action: string;
    occurredAt: string;
    evidenceCode: string | null;
}

export interface PrivacyCaseRow {
    id: string;
    kind: string;
    status: string;
    receivedAt: string;
    dueAt: string | null;
    verifiedAt: string | null;
    resolvedAt: string | null;
    version: string;
    subjects: PrivacyCaseSubject[];
    events: PrivacyCaseEvent[];
}

export interface PrivacyCaseList {
    cases: PrivacyCaseRow[];
}

export interface ImportReviewRow {
    index: number;
    status: 'ready' | 'duplicate' | 'possible_match' | 'invalid' | 'blocked';
    reason: string | null;
    candidateId: string | null;
}

export interface ImportReviewResult {
    rows: ImportReviewRow[];
}
