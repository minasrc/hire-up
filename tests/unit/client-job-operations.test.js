import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { ClientJobContractError } from '../../src/lib/client-job-contracts.js';
import {
    createJobDraft,
    saveClient,
    saveClientDraft,
    saveClientWithDetails,
} from '../../src/lib/client-job-operations.js';

test('operation wrappers return structured field errors before opening a transaction', async () => {
    await assert.rejects(
        saveClient(null, null, null, {
            clientId: 'not-a-uuid',
            expectedVersion: null,
            fields: {},
            operationId: '00000000-0000-4000-8000-000000000001',
        }),
        (error) => error instanceof ClientJobContractError
            && error.code === 'INVALID_INPUT'
            && error.fieldErrors.input === 'clientId must be a UUID',
    );
    await assert.rejects(
        saveClientDraft(null, null, null, {
            clientId: 'not-a-uuid',
            expectedVersion: null,
            fields: {},
            operationId: '00000000-0000-4000-8000-000000000001',
        }),
        (error) => error instanceof ClientJobContractError
            && error.code === 'INVALID_INPUT'
            && error.fieldErrors.input === 'clientId must be a UUID',
    );
});

const emptyJobFields = (title) => ({
    title,
    employmentType: null,
    workplaceMode: null,
    locations: [],
    remoteRegions: [],
    compensationMin: null,
    compensationMax: null,
    currency: null,
    payPeriod: null,
    bonuses: [],
    descriptionDocument: {
        type: 'doc',
        content: [{
            type: 'paragraph',
            content: [{ type: 'text', text: 'Synthetic description' }],
        }],
    },
});

test('createJobDraft rejects a non-boolean publiclyListed before opening a transaction', async () => {
    const pool = {
        connect: async () => {
            throw new Error('must not open a transaction');
        },
    };
    const base = {
        jobId: randomUUID(),
        revisionId: randomUUID(),
        clientId: randomUUID(),
        fields: emptyJobFields('Synthetic role'),
        operationId: randomUUID(),
    };
    for (const publiclyListed of [null, 'true', 1]) {
        await assert.rejects(
            createJobDraft(
                pool,
                {
                    provider: 'google',
                    issuer: 'https://accounts.google.com',
                    subject: '1002',
                },
                randomUUID(),
                { ...base, publiclyListed },
            ),
            (error) => error instanceof ClientJobContractError
                && error.code === 'INVALID_INPUT'
                && error.fieldErrors.input === 'publiclyListed must be a boolean',
        );
    }
});

test('createJobDraft sends the listing flag through create_job_draft_v2', async () => {
    const statements = [];
    const jobId = randomUUID();
    const revisionId = randomUUID();
    const clientId = randomUUID();
    const operationId = randomUUID();
    const pool = {
        connect: async () => ({
            release: () => {},
            query: async (text, params) => {
                statements.push({ text, params });
                if (text.includes('resolve_staff_principal_v1')) {
                    return { rows: [{
                        user_id: randomUUID(),
                        membership_id: randomUUID(),
                        role_id: randomUUID(),
                    }] };
                }
                if (text.includes('has_permission_v1')) {
                    return { rows: params[0].map(() => ({ allowed: true })) };
                }
                if (text.includes('create_job_draft_v2')) {
                    return {
                        rows: [{
                            result: {
                                status: 'created',
                                jobId,
                                revisionId,
                                version: '1',
                            },
                        }],
                    };
                }
                return { rows: [] };
            },
        }),
    };
    const result = await createJobDraft(
        pool,
        {
            provider: 'google',
            issuer: 'https://accounts.google.com',
            subject: '1002',
        },
        randomUUID(),
        {
            jobId,
            revisionId,
            clientId,
            fields: emptyJobFields('Listed synthetic role'),
            publiclyListed: true,
            operationId,
        },
    );
    assert.equal(result.status, 'created');
    const call = statements.find(({ text }) => text.includes('create_job_draft_v2'));
    assert.ok(call, 'the v2 procedure must be called');
    assert.equal(
        call.text,
        'select app.create_job_draft_v2($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::boolean,$6::uuid,$7::uuid) as result',
    );
    assert.equal(call.params[0], jobId);
    assert.equal(call.params[1], revisionId);
    assert.equal(call.params[2], clientId);
    assert.equal(call.params[4], true);
    assert.equal(call.params[5], operationId);
    assert.ok(
        !statements.some(({ text }) => text.includes('set_job_public_listing_v1')),
        'listing must be stored atomically, not through a second mutation',
    );
});

const clientFields = {
    name: 'Synthetic Agency One',
    contactName: 'Dana Example',
    contactEmail: 'dana@agency-one.example',
    telegramUsername: '@dana_ops',
    website: 'https://agency-one.example',
    socialLinks: [],
    isStealth: false,
    anonymousDescription: null,
};
const staffIdentity = {
    provider: 'google',
    issuer: 'https://accounts.google.com',
    subject: '1002',
};

function clientSaveFixture({ allowed = true, snapshotError = null } = {}) {
    const clientId = randomUUID();
    const receipt = {
        id: clientId,
        version: '2',
        status: 'active',
        publicProfileVersion: '2',
    };
    const snapshot = {
        ...receipt,
        ...clientFields,
        telegramUsername: 'dana_ops',
    };
    const statements = [];
    let connects = 0;
    let releases = 0;
    const pool = {
        connect: async () => {
            connects += 1;
            return {
                release: () => { releases += 1; },
                query: async (text, params) => {
                    statements.push(text);
                    if (text.includes('resolve_staff_principal_v1')) {
                        return { rows: [{
                            user_id: randomUUID(),
                            membership_id: randomUUID(),
                            role_id: randomUUID(),
                        }] };
                    }
                    if (text.includes('has_permission_v1')) {
                        return { rows: params[0].map(() => ({ allowed })) };
                    }
                    if (text.includes('save_client_v1')) {
                        return { rows: [{ result: receipt }] };
                    }
                    if (text.includes('get_client_v1')) {
                        if (snapshotError) throw snapshotError;
                        return { rows: [{ result: snapshot }] };
                    }
                    return { rows: [] };
                },
            };
        },
    };
    const input = {
        clientId,
        expectedVersion: '1',
        fields: clientFields,
        operationId: randomUUID(),
    };
    return {
        clientId, connects: () => connects, input, pool, receipt,
        releases: () => releases, snapshot, statements,
    };
}

test('saveClientWithDetails reads a canonical snapshot before committing', async () => {
    const fixture = clientSaveFixture();
    const result = await saveClientWithDetails(
        fixture.pool, staffIdentity, randomUUID(), fixture.input);
    assert.deepEqual(result, { ...fixture.receipt, client: fixture.snapshot });
    assert.equal(fixture.connects(), 1);
    const save = fixture.statements.findIndex((text) => text.includes('save_client_v1'));
    const read = fixture.statements.findIndex((text) => text.includes('get_client_v1'));
    const commit = fixture.statements.indexOf('commit');
    assert.ok(save < read && read < commit);
    assert.ok(!fixture.statements.includes('rollback'));
    assert.equal(fixture.releases(), 1);
});

test('saveClientWithDetails denies writes before save or snapshot queries', async () => {
    const fixture = clientSaveFixture({ allowed: false });
    await assert.rejects(
        saveClientWithDetails(fixture.pool, staffIdentity, randomUUID(), fixture.input),
        { code: 'FORBIDDEN' },
    );
    assert.ok(!fixture.statements.some((text) => text.includes('save_client_v1')));
    assert.ok(!fixture.statements.some((text) => text.includes('get_client_v1')));
});

test('saveClientWithDetails rolls back when the canonical snapshot read fails', async () => {
    const failure = Object.assign(new Error('snapshot failed'), { code: '08006' });
    const fixture = clientSaveFixture({ snapshotError: failure });
    await assert.rejects(
        saveClientWithDetails(fixture.pool, staffIdentity, randomUUID(), fixture.input),
        (error) => error === failure,
    );
    assert.ok(fixture.statements.includes('rollback'));
    assert.ok(!fixture.statements.includes('commit'));
    assert.equal(fixture.releases(), 1);
});

test('saveClient keeps its metadata-only result and skips the snapshot query', async () => {
    const fixture = clientSaveFixture();
    const result = await saveClient(fixture.pool, staffIdentity, randomUUID(), fixture.input);
    assert.deepEqual(result, fixture.receipt);
    assert.equal('client' in result, false);
    assert.ok(!fixture.statements.some((text) => text.includes('get_client_v1')));
});
