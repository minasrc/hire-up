export function jobStatusLabel(job) {
    if (job.publicationState === 'draft') return 'Draft';
    if (job.publicationState === 'archived') return 'Archived';
    if (job.publicationState === 'withdrawn') return 'Withdrawn';
    if (typeof job.publiclyListed !== 'boolean') return 'Visibility unavailable';
    return job.publiclyListed ? 'Listed' : 'Unlisted';
}

const EMPLOYMENT_TYPE_LABELS = {
    full_time: 'Full-time',
    part_time: 'Part-time',
    contract: 'Contract',
    internship: 'Internship',
};

const WORKPLACE_MODE_LABELS = {
    onsite: 'On-site',
    hybrid: 'Hybrid',
    remote: 'Remote',
};

export function employmentTypeLabel(value) {
    return value ? (EMPLOYMENT_TYPE_LABELS[value] ?? value) : 'Not specified';
}

export function workplaceModeLabel(value) {
    return value ? (WORKPLACE_MODE_LABELS[value] ?? value) : 'Not specified';
}

const SOCIAL_PLATFORM_LABELS = {
    linkedin: 'LinkedIn',
    x: 'X',
    github: 'GitHub',
    other: 'Other',
};

export function socialPlatformLabel(value) {
    return SOCIAL_PLATFORM_LABELS[value] ?? 'Link';
}
