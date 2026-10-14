import 'server-only';
import { getClient, listJobDirectory } from './client-job-operations.js';
import { listApplicationDirectory } from './pipeline-operations.js';
import { getStaffCapabilities } from './workspace-operations.js';
import { withStaffTransaction } from './staff-authorization.js';
import { employmentTypeLabel, workplaceModeLabel, jobStatusLabel } from './job-display.js';
import type { StaffWorkspaceCapabilities } from './workspace-types';
import type { JobRow } from '@/app/staff/jobs/jobs-browser';
import type { ClientRole } from '@/components/staff-ui/client-roles';

type Context = { pool: Parameters<typeof getClient>[0]; identity: Parameters<typeof getClient>[1]; organizationId: string };
type RoleMetadata = { id: string; locations: string[]; remoteRegions: string[]; locationDisplay: string | null; workplaceMode: string | null; employmentType: string | null; applications: number | null };

export async function readClientRoles(context: Context, clientId: string, input: { q?: string; status?: string; page?: string } = {}, canReadApplications = false) {
    const directory = await listJobDirectory(context.pool, context.identity, context.organizationId, {
        q: input.q ?? '', client: clientId, state: input.status ?? 'all', page: input.page ?? '1',
    });
    const metadata: RoleMetadata[] = await withStaffTransaction(context.pool, context.identity, context.organizationId,
        ['clients.read', 'jobs.read'], async ({ client }: { client: { query: (sql: string, args: unknown[]) => Promise<{ rows: { result: RoleMetadata[] }[] }> } }) => {
            const { rows } = await client.query('select app.client_role_card_metadata_v1($1::uuid, $2::uuid[], $3::boolean) as result',
                [clientId, directory.rows.map((job: JobRow) => job.id), canReadApplications]);
            return rows[0].result;
        });
    const cards: ClientRole[] = directory.rows.map((job: JobRow) => {
        const extra = metadata.find(entry => entry.id === job.id);
        const places = extra?.workplaceMode === 'remote' ? extra.remoteRegions : extra?.locations;
        const location = [places?.join(', ') || extra?.locationDisplay, extra?.workplaceMode ? workplaceModeLabel(extra.workplaceMode) : null,
            extra?.employmentType ? employmentTypeLabel(extra.employmentType) : null].filter(Boolean).join(' · ');
        return { id: job.id, title: job.title, location, status: jobStatusLabel(job), applications: extra?.applications ?? null, draft: Boolean(job.draftRevisionId && job.publicationState !== 'draft') };
    });
    return { total: directory.total, roles: cards };
}

export async function readClientView(context: Context, clientId: string) {
    const result = await getClient(context.pool, context.identity, context.organizationId, { clientId });
    const client = result?.client ?? result;
    const capabilities = await getStaffCapabilities(context.pool, context.identity, context.organizationId) as StaffWorkspaceCapabilities;
    const [roles, open, applications] = await Promise.allSettled([
        capabilities.jobs ? readClientRoles(context, clientId, {}, capabilities.applications) : Promise.resolve(null),
        capabilities.jobs ? listJobDirectory(context.pool, context.identity, context.organizationId, { client: clientId, state: 'published', intake: 'open' }) : Promise.resolve(null),
        capabilities.applications ? listApplicationDirectory(context.pool, context.identity, context.organizationId, { client: clientId, stage: 'all' }) : Promise.resolve(null),
    ]);
    return { client, capabilities,
        roles: roles.status === 'fulfilled' ? roles.value : null,
        recentApplications: applications.status === 'fulfilled' ? applications.value?.rows.slice(0, 5) ?? [] : null,
        metrics: { openRoles: open.status === 'fulfilled' ? open.value?.total ?? null : null,
            applications: applications.status === 'fulfilled' ? applications.value?.total ?? null : null,
            interviewing: applications.status === 'fulfilled' ? applications.value?.stages.filter((stage: { key: string }) => stage.key === 'interview').reduce((sum: number, stage: { count: number }) => sum + stage.count, 0) ?? null : null },
        errors: { roles: roles.status === 'rejected', applications: applications.status === 'rejected' },
    };
}
