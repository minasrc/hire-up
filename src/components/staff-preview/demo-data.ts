import { formatStaffCalendarDate } from '@/lib/staff-dates';
import type {
    BonusType,
    Candidate,
    DemoClient,
    DemoJob,
    EmploymentType,
    JobDocument,
    PayPeriod,
    PrivacyCase,
    WorkplaceMode,
} from './types';

export const DEMO_TODAY = '2026-09-23';

export function formatReceivedDate(iso: string): string {
    return formatStaffCalendarDate(iso);
}

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
    full_time: 'Full-time',
    part_time: 'Part-time',
    contract: 'Contract',
    internship: 'Internship',
};

export const WORKPLACE_MODE_LABELS: Record<WorkplaceMode, string> = {
    onsite: 'On-site',
    hybrid: 'Hybrid',
    remote: 'Remote',
};

export const PAY_PERIOD_LABELS: Record<PayPeriod, string> = {
    year: 'year',
    month: 'month',
    day: 'day',
    hour: 'hour',
};

export const BONUS_TYPE_LABELS: Record<BonusType, string> = {
    cash: 'Cash bonus',
    equity: 'Equity',
    options: 'Options',
    stock: 'Stock',
    token: 'Token allocation',
    other: 'Other',
};

export const SOCIAL_PLATFORM_LABELS = {
    linkedin: 'LinkedIn',
    x: 'X',
    github: 'GitHub',
    other: 'Other',
} as const;

export function employmentTypeLabel(value: EmploymentType | null): string {
    return value ? EMPLOYMENT_TYPE_LABELS[value] : 'Not specified';
}

export function isJobOpen(job: DemoJob): boolean {
    return job.publicationState === 'published' && job.applicationState === 'open';
}

export type JobStatusLabel = 'Draft' | 'Open' | 'Closed';

export function jobStatusLabel(job: DemoJob): JobStatusLabel {
    if (job.publicationState === 'draft') return 'Draft';
    return job.applicationState === 'open' ? 'Open' : 'Closed';
}

export function jobLocationLabel(job: DemoJob | JobFieldsLike): string {
    if (job.workplaceMode === 'remote') {
        return job.remoteRegions.length > 0
            ? `Remote · ${job.remoteRegions.join(', ')}`
            : 'Remote';
    }
    if (job.locations.length > 0) {
        const mode = job.workplaceMode ? ` · ${WORKPLACE_MODE_LABELS[job.workplaceMode]}` : '';
        return `${job.locations.join(', ')}${mode}`;
    }
    return job.workplaceMode ? WORKPLACE_MODE_LABELS[job.workplaceMode] : 'Not specified';
}

interface JobFieldsLike {
    workplaceMode: WorkplaceMode | null;
    locations: string[];
    remoteRegions: string[];
}

export function jobCompensationLabel(job: {
    compensationMin: string | null;
    compensationMax: string | null;
    currency: string | null;
    payPeriod: PayPeriod | null;
}): string | null {
    if (!job.compensationMin || !job.compensationMax || !job.currency || !job.payPeriod) {
        return null;
    }
    return `${job.currency} ${job.compensationMin}–${job.compensationMax} per ${PAY_PERIOD_LABELS[job.payPeriod]}`;
}

export function buildJobDocument(
    summary: string,
    responsibilities: string[],
    requirements: string[],
): JobDocument {
    const text = (value: string) => ({ type: 'text', text: value });
    const list = (items: string[]) => ({
        type: 'bulletList',
        content: items.map((item) => ({
            type: 'listItem',
            content: [{ type: 'paragraph', content: [text(item)] }],
        })),
    });
    return {
        type: 'doc',
        content: [
            { type: 'heading', attrs: { level: 2 }, content: [text('Description')] },
            { type: 'paragraph', content: [text(summary)] },
            { type: 'heading', attrs: { level: 2 }, content: [text('Responsibilities')] },
            list(responsibilities),
            { type: 'heading', attrs: { level: 2 }, content: [text('Requirements')] },
            list(requirements),
        ],
    };
}

export const DEMO_CLIENTS: DemoClient[] = [
    {
        id: 'northstar',
        name: 'Northstar Labs',
        industry: 'Fintech',
        location: 'London',
        owner: 'Jamie Taylor',
        status: 'active',
        contactName: 'Robin Lee',
        contactEmail: 'robin@northstar.example',
        telegramUsername: null,
        website: 'https://northstar-labs.example',
        socialLinks: [
            { platform: 'linkedin', url: 'https://www.linkedin.com/company/northstar-labs-example' },
        ],
        isStealth: false,
        anonymousDescription: null,
    },
    {
        id: 'meridian',
        name: 'Meridian',
        industry: 'Product software',
        location: 'Remote',
        owner: 'Priya Shah',
        status: 'active',
        contactName: 'Jules Reed',
        contactEmail: 'jules@meridian.example',
        telegramUsername: 'julesreed',
        website: 'https://meridian.example',
        socialLinks: [
            { platform: 'x', url: 'https://x.com/meridian-example' },
            { platform: 'github', url: 'https://github.com/meridian-example' },
        ],
        isStealth: false,
        anonymousDescription: null,
    },
    {
        id: 'atlas',
        name: 'Atlas Network',
        industry: 'Infrastructure',
        location: 'Dublin',
        owner: 'Alex Ford',
        status: 'active',
        contactName: 'Kai Wells',
        contactEmail: 'kai@atlas.example',
        telegramUsername: null,
        website: 'https://atlas-network.example',
        socialLinks: [],
        isStealth: true,
        anonymousDescription:
            'A confidential infrastructure company building monitoring and alerting tooling for platform teams.',
    },
];

interface DemoJobSeed {
    id: string;
    clientId: string;
    title: string;
    summary: string;
    responsibilities: string[];
    requirements: string[];
    employmentType: EmploymentType;
    workplaceMode: WorkplaceMode;
    locations: string[];
    remoteRegions: string[];
    compensationMin: string;
    compensationMax: string;
    currency: string;
    payPeriod: PayPeriod;
    bonuses?: DemoJob['bonuses'];
    publishedRevision?: number;
}

function seedJob(seed: DemoJobSeed): DemoJob {
    const revision = seed.publishedRevision ?? 1;
    return {
        id: seed.id,
        clientId: seed.clientId,
        title: seed.title,
        employmentType: seed.employmentType,
        workplaceMode: seed.workplaceMode,
        locations: seed.locations,
        remoteRegions: seed.remoteRegions,
        compensationMin: seed.compensationMin,
        compensationMax: seed.compensationMax,
        currency: seed.currency,
        payPeriod: seed.payPeriod,
        bonuses: seed.bonuses ?? [],
        descriptionDocument: buildJobDocument(
            seed.summary,
            seed.responsibilities,
            seed.requirements,
        ),
        publicationState: 'published',
        applicationState: 'open',
        jobVersion: String(revision),
        revisionId: `rev-${seed.id}-1`,
        revisionVersion: String(revision),
        draft: null,
        summary: seed.summary,
        responsibilities: seed.responsibilities,
        requirements: seed.requirements,
    };
}

export const DEMO_JOBS: DemoJob[] = [
    seedJob({
        id: 'job-frontend',
        clientId: 'northstar',
        title: 'Senior Frontend Engineer',
        summary:
            'Own the customer-facing web experience for a fintech dashboard used by operations teams daily.',
        responsibilities: [
            'Build and maintain React features across the onboarding and reporting surfaces.',
            'Pair with design to keep the component library accessible and consistent.',
            'Review frontend changes and mentor mid-level engineers.',
        ],
        requirements: [
            'Strong TypeScript and React experience in production applications.',
            'Track record of accessible, well-tested UI work.',
            'Comfortable partnering with product and design stakeholders.',
        ],
        employmentType: 'full_time',
        workplaceMode: 'hybrid',
        locations: ['London'],
        remoteRegions: [],
        compensationMin: '85000',
        compensationMax: '105000',
        currency: 'GBP',
        payPeriod: 'year',
        bonuses: [{ type: 'cash', details: 'Annual bonus up to 10% based on company performance.' }],
        publishedRevision: 3,
    }),
    seedJob({
        id: 'job-manager',
        clientId: 'northstar',
        title: 'Engineering Manager',
        summary:
            'Lead a small product engineering team delivering regulated payment features end to end.',
        responsibilities: [
            'Run planning, delivery and retrospectives for a team of five engineers.',
            'Coach engineers through growth plans and regular feedback.',
            'Work with product on roadmap shaping and dependency management.',
        ],
        requirements: [
            'Experience managing engineers on a product team.',
            'Background in shipping software as an individual contributor.',
            'Clear communication with technical and non-technical stakeholders.',
        ],
        employmentType: 'full_time',
        workplaceMode: 'hybrid',
        locations: ['London'],
        remoteRegions: [],
        compensationMin: '95000',
        compensationMax: '120000',
        currency: 'GBP',
        payPeriod: 'year',
        publishedRevision: 2,
    }),
    seedJob({
        id: 'job-fullstack',
        clientId: 'northstar',
        title: 'Full-stack Engineer',
        summary:
            'Work across the TypeScript stack on account and transaction features for a growing fintech.',
        responsibilities: [
            'Deliver features spanning React front ends and Node services.',
            'Write integration tests and keep observability coverage healthy.',
            'Contribute to technical design reviews.',
        ],
        requirements: [
            'Production experience with TypeScript on both client and server.',
            'Familiarity with relational data modelling.',
            'Pragmatic approach to testing and code review.',
        ],
        employmentType: 'full_time',
        workplaceMode: 'onsite',
        locations: ['Birmingham'],
        remoteRegions: [],
        compensationMin: '70000',
        compensationMax: '88000',
        currency: 'GBP',
        payPeriod: 'year',
    }),
    seedJob({
        id: 'job-product',
        clientId: 'meridian',
        title: 'Product Engineer',
        summary:
            'Join a remote-first product team shipping collaboration features for distributed teams.',
        responsibilities: [
            'Ship user-facing features from discovery notes to release.',
            'Instrument and iterate on shipped work with the product manager.',
            'Help keep the shared component set tidy and documented.',
        ],
        requirements: [
            'Experience shipping SaaS product features end to end.',
            'Comfort working async in a remote team.',
            'Solid React and TypeScript fundamentals.',
        ],
        employmentType: 'full_time',
        workplaceMode: 'remote',
        locations: [],
        remoteRegions: ['UK', 'EU'],
        compensationMin: '75000',
        compensationMax: '95000',
        currency: 'GBP',
        payPeriod: 'year',
        bonuses: [{ type: 'equity', details: 'Equity grant vesting over four years.' }],
    }),
    seedJob({
        id: 'job-designer',
        clientId: 'meridian',
        title: 'Product Designer',
        summary:
            'Cover research through delivery on a small product design team working closely with engineers.',
        responsibilities: [
            'Run lightweight discovery and usability sessions.',
            'Produce flows, prototypes and final UI specs.',
            'Maintain shared design-system patterns with engineering.',
        ],
        requirements: [
            'Portfolio of shipped product design work.',
            'Experience prototyping and testing with users.',
            'Comfort working embedded with an engineering team.',
        ],
        employmentType: 'full_time',
        workplaceMode: 'hybrid',
        locations: ['Manchester'],
        remoteRegions: [],
        compensationMin: '60000',
        compensationMax: '78000',
        currency: 'GBP',
        payPeriod: 'year',
    }),
    seedJob({
        id: 'job-designlead',
        clientId: 'meridian',
        title: 'Design Lead',
        summary:
            'Set design direction across the product suite while staying hands-on with key initiatives.',
        responsibilities: [
            'Own the design vision and critique cadence for the team.',
            'Partner with product leads on roadmap trade-offs.',
            'Line-manage two product designers.',
        ],
        requirements: [
            'Experience leading design on multi-surface products.',
            'Strong portfolio including systems-level work.',
            'Comfort presenting design rationale to leadership.',
        ],
        employmentType: 'full_time',
        workplaceMode: 'hybrid',
        locations: ['London'],
        remoteRegions: [],
        compensationMin: '90000',
        compensationMax: '115000',
        currency: 'GBP',
        payPeriod: 'year',
    }),
    seedJob({
        id: 'job-intern',
        clientId: 'meridian',
        title: 'Engineering Intern',
        summary:
            'Six-month internship pairing with engineers on real product work, with a dedicated mentor.',
        responsibilities: [
            'Ship small, well-scoped features with pairing support.',
            'Write tests and documentation for your work.',
            'Present one learning review at the end of the placement.',
        ],
        requirements: [
            'Some coursework or project experience with JavaScript or TypeScript.',
            'Curiosity about how production software is built.',
            'Availability for the full placement duration.',
        ],
        employmentType: 'internship',
        workplaceMode: 'hybrid',
        locations: ['London'],
        remoteRegions: [],
        compensationMin: '28000',
        compensationMax: '32000',
        currency: 'GBP',
        payPeriod: 'year',
    }),
    seedJob({
        id: 'job-backend',
        clientId: 'atlas',
        title: 'Backend Engineer',
        summary:
            'Build the services behind an infrastructure monitoring platform used by platform teams.',
        responsibilities: [
            'Design and implement distributed ingestion and query services.',
            'Own reliability work: alerts, runbooks and incident follow-up.',
            'Collaborate on API contracts with the frontend team.',
        ],
        requirements: [
            'Production experience with a systems or backend language (Go, Rust or similar).',
            'Familiarity with event-driven or streaming architectures.',
            'Care for observability and operational quality.',
        ],
        employmentType: 'full_time',
        workplaceMode: 'remote',
        locations: [],
        remoteRegions: ['Worldwide'],
        compensationMin: '80',
        compensationMax: '110',
        currency: 'USD',
        payPeriod: 'hour',
        publishedRevision: 4,
    }),
    seedJob({
        id: 'job-mobile',
        clientId: 'atlas',
        title: 'Mobile Engineer',
        summary:
            'Own the companion mobile app that surfaces infrastructure alerts to on-call engineers.',
        responsibilities: [
            'Ship React Native features for alerting and triage flows.',
            'Keep offline behaviour and push delivery reliable.',
            'Work with backend engineers on notification contracts.',
        ],
        requirements: [
            'Experience shipping React Native apps to both stores.',
            'Understanding of mobile networking and offline patterns.',
            'Attention to performance on lower-end devices.',
        ],
        employmentType: 'full_time',
        workplaceMode: 'hybrid',
        locations: ['Edinburgh'],
        remoteRegions: [],
        compensationMin: '72000',
        compensationMax: '92000',
        currency: 'GBP',
        payPeriod: 'year',
    }),
    seedJob({
        id: 'job-qa',
        clientId: 'atlas',
        title: 'QA Engineer',
        summary:
            'Own test strategy and release readiness for distributed infrastructure services.',
        responsibilities: [
            'Design regression and exploratory test plans for releases.',
            'Maintain automated end-to-end coverage with engineering.',
            'Coordinate release readiness reviews.',
        ],
        requirements: [
            'Experience testing distributed or backend-heavy systems.',
            'Familiarity with automated e2e tooling.',
            'Clear written communication of risk and coverage.',
        ],
        employmentType: 'contract',
        workplaceMode: 'onsite',
        locations: ['Cardiff'],
        remoteRegions: [],
        compensationMin: '400',
        compensationMax: '480',
        currency: 'GBP',
        payPeriod: 'day',
    }),
];

export function createDemoClients(): DemoClient[] {
    return DEMO_CLIENTS.map((client) => ({
        ...client,
        socialLinks: client.socialLinks.map((link) => ({ ...link })),
    }));
}

export function createDemoJobs(): DemoJob[] {
    return DEMO_JOBS.map((job) => ({
        ...job,
        locations: [...job.locations],
        remoteRegions: [...job.remoteRegions],
        bonuses: job.bonuses.map((bonus) => ({ ...bonus })),
        responsibilities: [...job.responsibilities],
        requirements: [...job.requirements],
        descriptionDocument: structuredClone(job.descriptionDocument),
        draft: job.draft ? structuredClone(job.draft) : null,
    }));
}

export const TAG_VOCABULARY = ['React', 'TypeScript', 'Rust', 'Design', 'Backend', 'Remote'];

export const OWNERS = ['Jamie Taylor', 'Priya Shah', 'Alex Ford'];

export const DEMO_USER = 'Jamie Taylor';

export interface SampleCsvRecord {
    name: string;
    role: string;
    email: string;
    location: string;
    skills: string[];
    notes: string;
}

export const SAMPLE_CSV_COLUMNS = ['Full name', 'Job title', 'Email', 'Skills', 'Notes'];

export const SAMPLE_CSV_RECORDS: SampleCsvRecord[] = [
    {
        name: 'Nina Patel',
        role: 'Backend Engineer',
        email: 'nina.patel@sample-import.example',
        location: 'Remote (UK)',
        skills: ['Rust', 'Backend'],
        notes: 'Met at the spring engineering meetup.',
    },
    {
        name: 'Owen Brooks',
        role: 'Product Designer',
        email: 'owen.brooks@sample-import.example',
        location: 'Lisbon',
        skills: ['Design', 'Remote'],
        notes: 'Portfolio shared through a referral.',
    },
    {
        name: 'Alex Morgan',
        role: 'Senior Frontend Engineer',
        email: 'alex.morgan@sample-import.example',
        location: 'London',
        skills: ['React', 'TypeScript'],
        notes: 'Matches an existing workspace record.',
    },
];

export function createDemoCandidates(): Candidate[] {
    return [
        {
            id: 'demo-01',
            name: 'Alex Morgan',
            headline: 'Senior Frontend Engineer',
            location: 'London',
            email: 'alex.morgan@reserved.example',
            owner: 'Jamie Taylor',
            source: 'Application',
            tags: ['React', 'TypeScript'],
            availability: 'Open to opportunities',
            restricted: false,
            addedDaysAgo: 2,
            summary:
                'Frontend engineer with eight years building design systems and web applications. Most recently led the component platform group at a fintech scale-up.',
            experience: [
                {
                    role: 'Senior Frontend Engineer',
                    company: 'Sample product team',
                    period: '2022–2026',
                    description: 'Led reusable component and accessibility work.',
                },
                {
                    role: 'Frontend Engineer',
                    company: 'Sample fintech team',
                    period: '2018–2022',
                    description: 'Delivered customer-facing web applications.',
                },
            ],
            skills: ['React', 'TypeScript', 'Design systems', 'Accessibility'],
            documents: [
                { id: 'doc-011', name: 'CV — Alex Morgan', state: 'Available', version: 3 },
                { id: 'doc-012', name: 'CV — Alex Morgan (previous version)', state: 'Available', version: 2 },
            ],
            applications: [
                {
                    id: 'app-101',
                    jobId: 'job-frontend',
                    clientId: 'northstar',
                    job: 'Senior Frontend Engineer',
                    client: 'Northstar Labs',
                    stage: 'Reviewing',
                    receivedAt: '2026-09-22',
                },
                {
                    id: 'app-102',
                    jobId: 'job-product',
                    clientId: 'meridian',
                    job: 'Product Engineer',
                    client: 'Meridian',
                    stage: 'Interview',
                    receivedAt: '2026-09-05',
                },
            ],
            notes: [
                {
                    id: 'note-011',
                    body: 'Strong system-design instincts. Wants a team with an established design system.',
                    author: 'Jamie Taylor',
                    createdLabel: 'Mar 14',
                },
            ],
        },
        {
            id: 'demo-02',
            name: 'Alice Chen',
            headline: 'Backend Engineer',
            location: 'Bristol',
            email: 'alice.chen@reserved.example',
            owner: 'Priya Shah',
            source: 'Referral',
            tags: ['Rust', 'Backend'],
            availability: 'Open to opportunities',
            restricted: false,
            addedDaysAgo: 5,
            summary:
                'Backend engineer focused on distributed services and payments infrastructure. Previously platform lead at a logistics startup.',
            experience: [
                {
                    role: 'Backend Engineer',
                    company: 'Sample payments team',
                    period: '2022–2026',
                    description:
                        'Built distributed payment services and improved service reliability.',
                },
                {
                    role: 'Platform Engineer',
                    company: 'Sample logistics company',
                    period: '2019–2022',
                    description:
                        'Maintained event-driven services and internal platform tooling.',
                },
            ],
            skills: ['Rust', 'PostgreSQL', 'Distributed systems'],
            documents: [{ id: 'doc-021', name: 'CV — Alice Chen', state: 'Available', version: 1 }],
            applications: [
                {
                    id: 'app-103',
                    jobId: 'job-backend',
                    clientId: 'atlas',
                    job: 'Backend Engineer',
                    client: 'Atlas Network',
                    stage: 'New',
                    receivedAt: '2026-09-23',
                },
            ],
            notes: [],
        },
        {
            id: 'demo-03',
            name: 'Sam Rivera',
            headline: 'Product Designer',
            location: 'Manchester',
            email: 'sam.rivera@reserved.example',
            owner: 'Jamie Taylor',
            source: 'Application',
            tags: ['Design', 'Remote'],
            availability: 'Open to opportunities',
            restricted: false,
            addedDaysAgo: 9,
            summary:
                'Product designer covering research through delivery. Comfortably ships in early-stage teams and documents decisions well.',
            experience: [
                {
                    role: 'Product Designer',
                    company: 'Sample design team',
                    period: '2021–2026',
                    description:
                        'Led product discovery and prototyping with engineering teams.',
                },
            ],
            skills: ['Product design', 'User research', 'Prototyping'],
            documents: [{ id: 'doc-031', name: 'CV — Sam Rivera', state: 'Scanning', version: 1 }],
            applications: [
                {
                    id: 'app-104',
                    jobId: 'job-designer',
                    clientId: 'meridian',
                    job: 'Product Designer',
                    client: 'Meridian',
                    stage: 'Reviewing',
                    receivedAt: '2026-09-18',
                },
            ],
            notes: [
                {
                    id: 'note-031',
                    body: 'Portfolio review scheduled. Strong fit for teams that pair design with research.',
                    author: 'Priya Shah',
                    createdLabel: 'Mar 11',
                },
            ],
        },
        {
            id: 'demo-04',
            name: 'Jordan Blake',
            headline: 'Data Engineer',
            location: 'Leeds',
            email: 'jordan.blake@reserved.example',
            owner: 'Alex Ford',
            source: 'CSV import',
            tags: ['Backend'],
            availability: 'Not specified',
            restricted: false,
            addedDaysAgo: 14,
            summary:
                'Data engineer with warehouse modelling and streaming pipeline experience. Added during the last network import.',
            documents: [],
            applications: [],
            notes: [],
        },
        {
            id: 'demo-05',
            name: 'Taylor Quinn',
            headline: 'Engineering Manager',
            location: 'London',
            email: 'taylor.quinn@reserved.example',
            owner: 'Priya Shah',
            source: 'Application',
            tags: ['Backend'],
            availability: 'Not specified',
            restricted: true,
            addedDaysAgo: 21,
            summary: '',
            documents: [{ id: 'doc-051', name: 'CV — Taylor Quinn', state: 'Restricted', version: 2 }],
            applications: [
                {
                    id: 'app-105',
                    jobId: 'job-manager',
                    clientId: 'northstar',
                    job: 'Engineering Manager',
                    client: 'Northstar Labs',
                    stage: 'New',
                    receivedAt: '2026-09-20',
                },
            ],
            notes: [
                {
                    id: 'note-051',
                    body: 'Restricted record — notes are hidden in this preview.',
                    author: 'Jamie Taylor',
                    createdLabel: 'Mar 3',
                },
            ],
        },
        {
            id: 'demo-06',
            name: 'Casey Lin',
            headline: 'Mobile Engineer',
            location: 'Edinburgh',
            email: 'casey.lin@reserved.example',
            owner: 'Jamie Taylor',
            source: 'Referral',
            tags: ['React', 'Remote'],
            availability: 'Open to opportunities',
            restricted: false,
            addedDaysAgo: 3,
            summary:
                'Mobile engineer shipping React Native apps for consumer products. Referred by a former colleague.',
            documents: [{ id: 'doc-061', name: 'CV — Casey Lin', state: 'Available', version: 1 }],
            applications: [
                {
                    id: 'app-106',
                    jobId: 'job-mobile',
                    clientId: 'atlas',
                    job: 'Mobile Engineer',
                    client: 'Atlas Network',
                    stage: 'Interview',
                    receivedAt: '2026-09-12',
                },
            ],
            notes: [],
        },
        {
            id: 'demo-07',
            name: 'Riley Osei',
            headline: 'Site Reliability Engineer',
            location: 'Dublin',
            email: 'riley.osei@reserved.example',
            owner: 'Alex Ford',
            source: 'Application',
            tags: ['Backend', 'Remote'],
            availability: 'Open to opportunities',
            restricted: false,
            addedDaysAgo: 30,
            summary:
                'Reliability engineer with incident response and observability background across regulated industries.',
            documents: [{ id: 'doc-071', name: 'CV — Riley Osei', state: 'Available', version: 2 }],
            applications: [],
            notes: [
                {
                    id: 'note-071',
                    body: 'Prefers teams with established on-call rotations.',
                    author: 'Alex Ford',
                    createdLabel: 'Feb 20',
                },
            ],
        },
        {
            id: 'demo-08',
            name: 'Devon Park',
            headline: 'Full-stack Engineer',
            location: 'Birmingham',
            email: 'devon.park@reserved.example',
            owner: 'Priya Shah',
            source: 'Application',
            tags: ['TypeScript', 'Backend'],
            availability: 'Open to opportunities',
            restricted: false,
            addedDaysAgo: 6,
            summary:
                'Full-stack engineer comfortable across TypeScript services and React front ends. Interested in product-focused teams.',
            documents: [{ id: 'doc-081', name: 'CV — Devon Park', state: 'Available', version: 1 }],
            applications: [
                {
                    id: 'app-107',
                    jobId: 'job-fullstack',
                    clientId: 'northstar',
                    job: 'Full-stack Engineer',
                    client: 'Northstar Labs',
                    stage: 'New',
                    receivedAt: '2026-09-23',
                },
            ],
            notes: [],
        },
        {
            id: 'demo-09',
            name: 'Morgan Ellis',
            headline: 'Design Lead',
            location: 'London',
            email: 'morgan.ellis@reserved.example',
            owner: 'Jamie Taylor',
            source: 'Referral',
            tags: ['Design'],
            availability: 'Not specified',
            restricted: false,
            addedDaysAgo: 45,
            summary:
                'Design lead who has built and managed small product design teams. Currently consulting.',
            documents: [{ id: 'doc-091', name: 'CV — Morgan Ellis', state: 'Unavailable', version: 1 }],
            applications: [
                {
                    id: 'app-108',
                    jobId: 'job-designlead',
                    clientId: 'meridian',
                    job: 'Design Lead',
                    client: 'Meridian',
                    stage: 'Reviewing',
                    receivedAt: '2026-08-30',
                },
            ],
            notes: [],
        },
        {
            id: 'demo-10',
            name: 'Avery Novak',
            headline: 'Platform Engineer',
            location: 'Glasgow',
            email: 'avery.novak@reserved.example',
            owner: 'Alex Ford',
            source: 'CSV import',
            tags: ['Rust', 'Remote'],
            availability: 'Open to opportunities',
            restricted: false,
            addedDaysAgo: 1,
            summary:
                'Platform engineer working on internal developer tooling and infrastructure automation.',
            documents: [{ id: 'doc-101', name: 'CV — Avery Novak', state: 'Scanning', version: 1 }],
            applications: [],
            notes: [],
        },
        {
            id: 'demo-11',
            name: 'Rowan Adeyemi',
            headline: 'QA Engineer',
            location: 'Cardiff',
            email: 'rowan.adeyemi@reserved.example',
            owner: 'Priya Shah',
            source: 'Application',
            tags: ['Backend'],
            availability: 'Open to opportunities',
            restricted: false,
            addedDaysAgo: 11,
            summary:
                'QA engineer specialising in test strategy for distributed systems and release readiness.',
            documents: [{ id: 'doc-111', name: 'CV — Rowan Adeyemi', state: 'Available', version: 1 }],
            applications: [
                {
                    id: 'app-109',
                    jobId: 'job-qa',
                    clientId: 'atlas',
                    job: 'QA Engineer',
                    client: 'Atlas Network',
                    stage: 'Reviewing',
                    receivedAt: '2026-09-16',
                },
            ],
            notes: [],
        },
        {
            id: 'demo-12',
            name: 'Jamie Moreau',
            headline: 'Engineering Intern',
            location: 'London',
            email: 'jamie.moreau@reserved.example',
            owner: 'Jamie Taylor',
            source: 'Application',
            tags: ['React'],
            availability: 'Open to opportunities',
            restricted: false,
            addedDaysAgo: 4,
            summary:
                'Final-year computer science student with internship experience on React storefront teams.',
            documents: [],
            applications: [
                {
                    id: 'app-110',
                    jobId: 'job-intern',
                    clientId: 'meridian',
                    job: 'Engineering Intern',
                    client: 'Meridian',
                    stage: 'New',
                    receivedAt: '2026-09-21',
                },
            ],
            notes: [],
        },
    ];
}

export function createDemoPrivacyCases(): PrivacyCase[] {
    return [
        {
            id: 'case-01',
            reference: 'PR-1042',
            kind: 'Restriction',
            status: 'In progress',
            due: 'Demo deadline',
            subjectId: 'demo-05',
            steps: [
                { label: 'Received', state: 'done' },
                { label: 'Records reviewed', state: 'done' },
                { label: 'Verification recorded', state: 'done' },
                { label: 'Local action', state: 'done' },
                { label: 'Pending follow-up', state: 'current' },
            ],
            timeline: [
                { label: 'Request received', detail: 'Restriction request logged for the subject record.' },
                { label: 'Records reviewed', detail: 'Staff reviewed the record scope for this case.' },
                { label: 'Verification recorded', detail: 'Subject verification was recorded in the case file.' },
                { label: 'Restriction applied locally', detail: 'The record is flagged as restricted in this preview.' },
                { label: 'Follow-up pending', detail: 'Recipient follow-up and ledger confirmation are outstanding.' },
            ],
            pendingBlocks: [
                {
                    title: 'Recipient follow-up pending',
                    detail:
                        'Downstream recipients have not been notified in this preview. This block shows where that work would be tracked.',
                },
                {
                    title: 'Ledger confirmation pending',
                    detail:
                        'No ledger confirmation has been recorded. This preview shows the state hierarchy only — nothing is executed.',
                },
            ],
            reviewedRecords: ['cand_demo-05', 'doc_051', 'app_105'],
        },
        {
            id: 'case-02',
            reference: 'PR-1043',
            kind: 'Access',
            status: 'Received',
            due: 'Awaiting triage',
            subjectId: 'demo-02',
            steps: [
                { label: 'Received', state: 'done' },
                { label: 'Records reviewed', state: 'pending' },
                { label: 'Verification recorded', state: 'pending' },
                { label: 'Local action', state: 'pending' },
                { label: 'Pending follow-up', state: 'pending' },
            ],
            timeline: [
                { label: 'Request received', detail: 'Access request logged and awaiting triage.' },
            ],
            pendingBlocks: [
                {
                    title: 'Triage not started',
                    detail: 'This case has not been reviewed yet. No records are attached.',
                },
            ],
            reviewedRecords: [],
        },
    ];
}
