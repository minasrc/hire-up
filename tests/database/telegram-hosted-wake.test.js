import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import pg from 'pg';
import { POSTGRES_17_IMAGE, assertLocalTestEnvironment, startPostgresContainer, stopAndRemoveContainer, psql } from '../support/foundation-docker.js';
import { AUTHZ_ID, SUBJECTS, installStaffFixture, staffPoolOptions } from '../support/staff-authorization.js';
import { telegramHostedPrepare, telegramHostedControl } from '../../src/lib/telegram-hosted-operations.js';
import { hostedWakeChannel, hostedWakeCursor, waitForHostedWake } from '../../src/lib/telegram-hosted-wake.js';

test('real PostgreSQL wake notifications are committed, scoped, prompt and fenced', { timeout: 120000 }, async t => {
  assertLocalTestEnvironment();
  const db = await startPostgresContainer('pghostedwake', POSTGRES_17_IMAGE, { publish: true });
  let staff, control;
  const clients = new Set();
  const close = async client => { if (clients.delete(client)) await client.end().catch(() => {}); };
  t.after(async () => { await Promise.all([...clients].map(close)); await Promise.all([staff?.end(), control?.end()]); await stopAndRemoveContainer(db); });
  const directory = new URL('../../supabase/migrations/', import.meta.url);
  for (const file of readdirSync(directory).filter(file => file.endsWith('.sql') && file >= '20260922090000_foundation_roles.sql').sort()) psql(db, readFileSync(new URL(file, directory), 'utf8'));
  const password = installStaffFixture(db), hostedPassword = randomUUID();
  psql(db, `create role hosted_wake_test login noinherit password '${hostedPassword}';grant app_telegram_hosted_service to hosted_wake_test;`);
  staff = new pg.Pool(staffPoolOptions(db, password, 2));
  const options = { ...staffPoolOptions(db, hostedPassword, 2), user: 'hosted_wake_test' };
  control = new pg.Pool(options);
  const serviceId = randomUUID(), instanceId = randomUUID();
  const initial = await telegramHostedControl(control, serviceId, { action: 'sync', instanceId });
  const leaseToken = initial.leaseToken;
  const read = () => telegramHostedControl(control, serviceId, { action: 'sync', instanceId, leaseToken });
  const prepare = () => telegramHostedPrepare(staff, { provider: 'google', issuer: 'https://accounts.google.com', subject: SUBJECTS.ADMIN1 }, AUTHZ_ID.ORG_A, serviceId, { action: 'prepare' });
  async function waiting(waitMs = 10000) {
    const snapshot = await read(), client = new pg.Client(options); clients.add(client); await client.connect();
    let ready;
    const subscribed = new Promise(resolve => { ready = resolve; });
    const query = client.query.bind(client);
    client.query = async (sql, args) => { const result = await query(sql, args); if (sql.includes('pg_try_advisory_lock')) ready(); return result; };
    const controller = new AbortController();
    const promise = waitForHostedWake(client, serviceId, { instanceId, leaseToken, cursor: hostedWakeCursor(snapshot.requests) }, { signal: controller.signal, waitMs });
    // Attach a rejection observer immediately while the fixture waits for LISTEN.
    promise.catch(() => {});
    await Promise.race([subscribed, promise]);
    return { client, controller, promise, cursor: hostedWakeCursor(snapshot.requests) };
  }
  await t.test('an actual staff enrollment wakes before the ten-second fallback and exposes no owner data', async () => {
    const wait = await waiting();
    const started = Date.now(); await prepare(); const result = await wait.promise;
    assert.equal(result.changed, true); assert.ok(Date.now() - started < 2000, 'Committed enrollment must wake promptly rather than waiting for scheduled polling');
    assert.deepEqual(Object.keys(result).sort(), ['changed', 'cursor', 'protocolVersion']);
    assert.equal(JSON.stringify(result).includes(AUTHZ_ID.ORG_A), false);
    await close(wait.client);
  });
  await t.test('global ownership admits only one held waiter without blocking the ordinary heartbeat', async () => {
    const wait = await waiting(), client = new pg.Client(options); clients.add(client); await client.connect();
    await assert.rejects(waitForHostedWake(client, serviceId, { instanceId, leaseToken, cursor: wait.cursor }, { waitMs: 100 }), error => error.status === 429);
    assert.equal((await read()).leaseToken, leaseToken, 'Waiting must hold no transaction or service-row lock');
    wait.controller.abort(); await assert.rejects(wait.promise, { name: 'AbortError' });
    await Promise.all([close(client), close(wait.client)]);
  });
  await t.test('rolled-back changes and another service channel cannot produce an acknowledged wake', async () => {
    const wait = await waiting(100);
    psql(db, `begin;update app.telegram_hosted_requests set wake_epoch=wake_epoch+1 where service_id='${serviceId}';rollback;select pg_notify('${hostedWakeChannel(randomUUID())}','wake');`);
    const result = await wait.promise; assert.equal(result.changed, false); assert.equal(result.cursor, wait.cursor);
    await close(wait.client);
  });
  await t.test('wake snapshots preserve service expiry and grant only the fenced function', async () => {
    const wait = await waiting(100);
    const expiry = () => psql(db, `select lease_expires_at::text from app.telegram_hosted_services where service_id='${serviceId}';`).trim();
    const before = expiry();
    assert.equal((await wait.promise).changed, false);
    assert.equal(expiry(), before, 'Wake requests must not extend ownership after a supervisor stops');
    const acl = psql(db, "select has_function_privilege('app_telegram_hosted_service','app.telegram_hosted_wake_snapshot_v1(uuid,uuid,uuid)','execute'),has_table_privilege('app_telegram_hosted_service','app.telegram_hosted_requests','select'),has_schema_privilege('app_executor','app','create');");
    assert.match(acl, /t\s*\|\s*f\s*\|\s*f/);
    await close(wait.client);
  });
  await t.test('a forged notification cannot bypass lease takeover and cleanup releases the lock', async () => {
    const wait = await waiting();
    psql(db, `update app.telegram_hosted_services set lease_expires_at=clock_timestamp()-interval '1 second' where service_id='${serviceId}';select pg_notify('${hostedWakeChannel(serviceId)}','wake');`);
    await assert.rejects(wait.promise, { code: '40001' });
    await close(wait.client);
    const fresh = await telegramHostedControl(control, serviceId, { action: 'sync', instanceId });
    assert.notEqual(fresh.leaseToken, leaseToken);
    const client = new pg.Client(options); clients.add(client); await client.connect();
    const result = await waitForHostedWake(client, serviceId, { instanceId, leaseToken: fresh.leaseToken, cursor: hostedWakeCursor(fresh.requests) }, { waitMs: 0 });
    assert.equal(result.changed, false); await close(client);
  });
});
