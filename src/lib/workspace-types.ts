export type StaffTaskCategory = 'review' | 'interviews' | 'notes';

export interface StaffWorkspaceCapabilities {
    candidates: boolean;
    telegram?: boolean; // Feature enabled and both candidate API permissions granted.
    applications: boolean;
    clients: boolean;
    jobs: boolean;
    members: boolean;
    tasks: boolean;
    writeTasks: boolean;
    writeClients: boolean;
    writeJobs: boolean;
}

export interface StaffWorkspaceMetrics {
    candidates: number | null;
    applications: number | null;
    openRoles: number | null;
}

export interface StaffWorkspaceAttention {
    reviewApplications: number | null;
    pendingInvites: number | null;
    openTasks: number | null;
}

export interface StaffWorkspaceClientHiring {
    clientId: string;
    name: string;
    isStealth: boolean;
    openRoles: number;
    applications: number | null;
}

export interface StaffWorkspaceRecentApplication {
    applicationId: string;
    candidateId: string;
    candidateName: string;
    jobId: string;
    jobTitle: string;
    clientId: string;
    clientName: string;
    receivedAt: string;
}

export interface StaffWorkspaceNotifications {
    capabilities: StaffWorkspaceCapabilities;
    attention: StaffWorkspaceAttention;
}

export interface StaffWorkspaceSummary {
    capabilities: StaffWorkspaceCapabilities;
    metrics: StaffWorkspaceMetrics;
    attention: StaffWorkspaceAttention;
    clientsHiring: StaffWorkspaceClientHiring[];
    clientsHiringTotal: number | null;
    recentApplications: StaffWorkspaceRecentApplication[];
}

export interface StaffTask {
    id: string;
    title: string;
    category: StaffTaskCategory;
    completedAt: string | null;
    createdAt: string;
    version: string;
}

export interface StaffTaskCounts {
    open: number;
    completed: number;
    all: number;
    review: number;
    interviews: number;
    notes: number;
}

export interface StaffTaskListResult {
    tasks: StaffTask[];
    total: number;
    counts: StaffTaskCounts;
}
