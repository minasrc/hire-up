import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import { POSTGRES_17_IMAGE, assertLocalTestEnvironment, psql, startPostgresContainer, stopAndRemoveContainer } from '../support/foundation-docker.js';
import { AUTHZ_ID, SUBJECTS, installStaffFixture, staffPoolOptions } from '../support/staff-authorization.js';
import { withStaffTransaction } from '../../src/lib/staff-authorization.js';

// Optional synthetic volume acceptance. No provider, production credentials,
// candidate fixtures or embedding inference are needed to exercise deletion.
test('maintenance drains 100,000 expired search results fairly within bounded calls', { skip: process.env.TELEGRAM_RETENTION_SCALE !== '1', timeout: 180_000 }, async t => {
    assertLocalTestEnvironment();
    const container = await startPostgresContainer('pgretentionvolume', POSTGRES_17_IMAGE, { publish: true });
    let staffPool; let maintenancePool;
    t.after(async () => { await Promise.all([staffPool?.end(), maintenancePool?.end()]); await stopAndRemoveContainer(container); });
    const directory = new URL('../../supabase/migrations/', import.meta.url);
    const migrations = readdirSync(directory).filter(name => name >= '20260922090000_foundation_roles.sql' && name <= '20261002190000_telegram_retention.sql' && name.endsWith('.sql')).sort();
    assert(migrations.includes('20261002190000_telegram_retention.sql'));
    for (const name of migrations) psql(container, readFileSync(fileURLToPath(new URL(name, directory)), 'utf8'));
    const password = installStaffFixture(container);
    staffPool = new pg.Pool(staffPoolOptions(container, password, 1));
    const maintenancePassword = randomUUID();
    psql(container, `create role retention_volume login noinherit nosuperuser nocreatedb nocreaterole nobypassrls password '${maintenancePassword}'; grant app_telegram_maintenance to retention_volume;`);
    maintenancePool = new pg.Pool({ ...staffPoolOptions(container, maintenancePassword, 1), user: 'retention_volume' });
    const organization = AUTHZ_ID.ORG_A; const owner = AUTHZ_ID.USER_ADMIN1;
    const expiredQuery = randomUUID(); const liveQuery = randomUUID();
    const otherQueries = Array.from({ length: 12 }, () => ({ id: randomUUID(), owner: randomUUID() }));
    const queryValues = (id, user, expired) => `('${id}','${organization}','${user}',gen_random_uuid(),sha256('synthetic'), 'Synthetic private search',encode(sha256('synthetic'),'hex'),'approved',false,'completed',array_fill(0::real,array[384]),now()+interval '${expired ? '-1 minute' : '1 day'}')`;
    psql(container, `
        insert into app.profile_search_sources(organization_id,source_type,source_id,status)
        select '${organization}','candidate',gen_random_uuid(),'ready' from generate_series(1,100000);
        insert into app.profile_search_queries(id,organization_id,owner_user_id,operation_id,request_digest,query_text,query_sha256,scope,ready_only,status,embedding,expires_at) values
        ${[queryValues(expiredQuery, owner, true), queryValues(liveQuery, owner, false), ...otherQueries.map(q => queryValues(q.id, q.owner, true))].join(',')};
        insert into app.profile_search_results(query_id,source_id,organization_id,owner_user_id,source_revision,score,ordinal,source_type,public_source_id)
        select '${expiredQuery}',id,organization_id,'${owner}',1,0.5,0,source_type,source_id from app.profile_search_sources;
        insert into app.profile_search_results(query_id,source_id,organization_id,owner_user_id,source_revision,score,ordinal,source_type,public_source_id)
        select '${liveQuery}',id,organization_id,'${owner}',1,0.5,0,source_type,source_id from app.profile_search_sources order by id limit 7;
        ${otherQueries.map(q => `insert into app.profile_search_results(query_id,source_id,organization_id,owner_user_id,source_revision,score,ordinal,source_type,public_source_id) select '${q.id}',id,organization_id,'${q.owner}',1,0.5,0,source_type,source_id from app.profile_search_sources order by id limit 3;`).join('\n')}
        analyze app.profile_search_sources; analyze app.profile_search_queries; analyze app.profile_search_results; analyze app.telegram_maintenance_owners;
    `);
    const snapshot = () => JSON.parse(psql(container, `select json_build_object(
        'remaining',(select count(*) from app.profile_search_results where query_id<>'${liveQuery}'),
        'liveRows',(select count(*) from app.profile_search_results where query_id='${liveQuery}'),
        'liveIntact',(select status='completed' and query_text='Synthetic private search' and cardinality(embedding)=384 from app.profile_search_queries where id='${liveQuery}'),
        'uncleared',(select count(*) from app.profile_search_queries where id<>'${liveQuery}' and (status<>'expired' or query_text is not null or embedding is not null)),
        'otherUncleared',(select count(*) from app.profile_search_queries where owner_user_id<>'${owner}' and status<>'expired'),
        'otherRemaining',(select count(*) from app.profile_search_results where owner_user_id<>'${owner}'),
        'sources',(select count(*) from app.profile_search_sources)
    )`).trim());
    assert.equal(snapshot().remaining, 100_036);
    // The actual staff status seam must immediately stop serving an expired
    // query, even while almost all physical result rows still await maintenance.
    const status = await withStaffTransaction(staffPool, { provider: 'google', issuer: 'https://accounts.google.com', subject: SUBJECTS.ADMIN1 }, organization, ['candidates.read', 'candidates.write'], async ({ client }) => (await client.query('select app.profile_search_status_v1($1,false,$2,null) result', ['approved', expiredQuery])).rows[0].result);
    assert.equal(status.status, 'expired'); assert.equal(status.query, null); assert.deepEqual(status.results, []); assert.equal(status.nextAfter, null);
    assert(snapshot().remaining > 99_000, 'expired queries are unusable before physical cleanup completes');
    const maintain = async limit => {
        const client = await maintenancePool.connect();
        try {
            await client.query("begin; set local role app_telegram_maintenance; set local statement_timeout='10s'; set local lock_timeout='500ms'");
            const started = performance.now();
            const result = (await client.query('select app.telegram_maintenance_v1($1) result', [limit])).rows[0].result;
            await client.query('commit'); return { result, milliseconds: performance.now() - started };
        } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
    };
    await assert.rejects(maintain(null), { code: '22023' });
    const durations = []; let calls = 0; let totalDeleted = 0; let before = snapshot();
    while (before.remaining > 0 && calls < 32) {
        const { result, milliseconds } = await maintain(10); durations.push(milliseconds); calls += 1;
        assert(milliseconds < 10_000, 'each bounded transaction finishes inside its 10s deadline');
        for (const [key, maximum] of [['ownersProcessed', 10], ['queriesExpired', 100], ['queryResultRowsDeleted', 5000], ['batchesPurged', 50]]) {
            assert(Number.isInteger(result[key]) && result[key] >= 0 && result[key] <= maximum, `${key} respects its global bound`);
        }
        const after = snapshot();
        assert.equal(before.remaining - after.remaining, result.queryResultRowsDeleted, 'reported deletion matches committed rows');
        assert(result.queryResultRowsDeleted > 0, `immediately repeated calls progress without advancing clocks or resetting due_at: ${JSON.stringify({ calls, result, remaining: after.remaining })}`);
        assert.equal(after.liveRows, 7); assert.equal(after.liveIntact, true); assert.equal(after.sources, 100_000);
        if (calls >= 3) assert.equal(after.otherUncleared, 0, 'a large owner does not starve small expired queries');
        if (calls >= 3) assert.equal(after.otherRemaining, 0, 'small owners receive cleanup budget before the large owner drains');
        if (calls >= 3) assert.equal(after.uncleared, 0, 'all expired query text/vectors clear before physical result cleanup finishes');
        if (after.remaining > 0) assert.equal(result.remainingWork, true);
        totalDeleted += result.queryResultRowsDeleted; before = after;
    }
    assert.equal(before.remaining, 0, '100k results drain using the shared budget, rather than a 500-row per-owner bottleneck');
    assert.equal(before.uncleared, 0);
    const idle = await maintain(10); assert.equal(idle.result.queryResultRowsDeleted, 0); assert.equal(snapshot().liveRows, 7);
    durations.sort((a, b) => a - b);
    t.diagnostic(JSON.stringify({ seededExpiredResults: 100_036, maintenanceDeleted: totalDeleted, calls, p50Ms: Math.round(durations[Math.floor(durations.length / 2)]), p95Ms: Math.round(durations[Math.ceil(durations.length * 0.95) - 1]), maxMs: Math.round(durations.at(-1)) }));
});
