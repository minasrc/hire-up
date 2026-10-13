import { ClientJobContractError } from './client-job-contracts.js';
import { withStaffActor, withStaffTransaction } from './staff-authorization.js';
import { assertUuid } from './candidate-profile-contracts.js';

export function workspaceCreationInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['operationId', 'name', 'adminEmail'].includes(key))) {
        throw new ClientJobContractError({ input: 'Invalid workspace request.' });
    }
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const adminEmail = typeof input.adminEmail === 'string' ? input.adminEmail.trim().toLowerCase() : '';
    const errors = {};
    if ([...name].length < 2 || [...name].length > 80 || /[\p{Cc}\p{Cf}]/u.test(name)) errors.name = 'Enter a workspace name of 2 to 80 characters.';
    if (adminEmail.length > 320 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)) errors.adminEmail = 'Enter the administrator’s Google email address.';
    if (Object.keys(errors).length) throw new ClientJobContractError(errors);
    return { operationId: assertUuid(input.operationId, 'operationId'), name, adminEmail };
}

export function createStaffWorkspace(pool, identity, organizationId, input) {
    const { operationId, name, adminEmail } = workspaceCreationInput(input);
    return withStaffTransaction(pool, identity, organizationId, ['workspaces.create'], async ({ client }) =>
        (await client.query('select app.staff_workspace_create_v1($1,$2,$3) result', [operationId, name, adminEmail])).rows[0].result);
}

export function staffWorkspaceProvisioningStatus(pool, identity, organizationId) {
    return withStaffActor(pool, identity, organizationId, async ({ client }) =>
        (await client.query('select app.staff_workspace_provisioning_status_v1() result')).rows[0].result);
}
