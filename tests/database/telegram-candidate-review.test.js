import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import pg from 'pg';
import { POSTGRES_17_IMAGE, assertLocalTestEnvironment, psql, startPostgresContainer, stopAndRemoveContainer } from '../support/foundation-docker.js';
import { AUTHZ_ID, installStaffFixture, staffPoolOptions } from '../support/staff-authorization.js';
import { CJ_ID, CJ_SUBJECTS, clientJobFixtureSql } from '../support/client-job-workflows.js';
import { createTelegramDraft, listTelegramDrafts, getTelegramDraft, decideTelegramDraft, updateTelegramDraft, refreshTelegramReview, registerTelegramWorker, matchTelegramReview, telegramReviewMatches } from '../../src/lib/telegram-intake-operations.js';
import { withStaffTransaction } from '../../src/lib/staff-authorization.js';
import { saveCandidateProfile, getCandidateProfile, listCandidateProfileDirectory } from '../../src/lib/candidate-profile-operations.js';
import { telegramHistoryAction, telegramHistoryStatus, telegramHistoryRecentStatus, telegramOnboardingComplete } from '../../src/lib/telegram-history-operations.js';
import { telegramExtractionStatus } from '../../src/lib/telegram-extraction-operations.js';
import { normalizeTelegramDraftFields } from '../../src/lib/telegram-intake-contracts.js';

const owner = { provider: 'google', issuer: 'https://accounts.google.com', subject: CJ_SUBJECTS.ADMIN };
const org = AUTHZ_ID.ORG_B;
test('Telegram proposals create candidates without CVs, update exact matches, fence stale profiles and preserve rejected profiles', { timeout: 180000 }, async t => {
    assertLocalTestEnvironment();
    const db = await startPostgresContainer('pgcandidateflow', POSTGRES_17_IMAGE, { publish: true });
    let pool;
    t.after(async () => { await pool?.end(); stopAndRemoveContainer(db); });
    const migrations = new URL('../../supabase/migrations/', import.meta.url);
    for (const name of readdirSync(migrations).filter(name => name >= '20260922090000_foundation_roles.sql' && name.endsWith('.sql')).sort()) {
        try { psql(db, readFileSync(new URL(name, migrations), 'utf8')); }
        catch (error) { throw new Error(`Migration ${name}: ${error.message}`); }
    }
    const password = installStaffFixture(db); psql(db, clientJobFixtureSql);
    pool = new pg.Pool(staffPoolOptions(db, password, 3));
    const args = [pool, owner, org];
    assert.equal(await telegramOnboardingComplete(...args), false);
    const approve = d => decideTelegramDraft(...args, d.id, { action: 'approve', expectedVersion: d.version, operationId: randomUUID(), reviewFlow: true, reviewedFields: Object.fromEntries(Object.entries(normalizeTelegramDraftFields(d.proposedFields ?? d.fields)).filter(([key]) => !['telegramUserId', 'ownerMembershipId'].includes(key))) });
    const created = await createTelegramDraft(...args, { fields: { firstName: 'New', lastName: 'Candidate', headline: 'Engineer' } });
    const saved = await approve(await getTelegramDraft(...args, created.id));
    assert.equal(saved.status, 'approved');
    let profile = await getCandidateProfile(...args, { candidateId: saved.candidateId });
    assert.equal(profile.candidate.fullName, 'New Candidate');
    assert.equal(profile.candidate.headline, 'Engineer');
    await t.test('another recruiter shares approved profiles but not imports, and reviews their own update field by field', async () => {
        // This fixture's second role is intentionally minimal. Give it the
        // production Recruiter grants rather than using an administrator actor.
        psql(db, `insert into app.role_permissions(organization_id,role_id,permission_key)
          values('${org}','${CJ_ID.ROLE_B_RECRUITER}','candidates.write'),
          ('${org}','${CJ_ID.ROLE_B_RECRUITER}','documents.write'),
          ('${org}','${CJ_ID.ROLE_B_RECRUITER}','documents.download') on conflict do nothing;`);
        const recruiter = { ...owner, subject: CJ_SUBJECTS.RECRUITER };
        const otherArgs = [pool, recruiter, org];
        const privateDraft = await createTelegramDraft(...args, { fields: { firstName: 'Private', lastName: 'Person' }, sourceTitle: 'Private Telegram conversation' });
        assert.equal((await listTelegramDrafts(...otherArgs, { view: 'all' })).drafts.some(d => d.id === privateDraft.id), false);
        await assert.rejects(getTelegramDraft(...otherArgs, privateDraft.id), /unavailable/i);
        const shared = await getCandidateProfile(...otherArgs, { candidateId: saved.candidateId });
        assert.equal(shared.candidate.fullName, 'New Candidate');
        const privateContext = await withStaffTransaction(pool, recruiter, org, ['candidates.read'], async ({ client }) =>
          (await client.query('select app.telegram_candidate_context_v1($1,null) as result', [saved.candidateId])).rows[0].result);
        assert.deepEqual(privateContext.sources, []);
        assert.equal(privateContext.provenanceUnavailable, false, 'even existence of another owner source stays private');
        // Existing shared profiles are matched by exact identity across owners.
        const id = randomUUID();
        await saveCandidateProfile(...args, { candidateId: id, expectedVersion: null, operationId: randomUUID(), fields: { fullName: 'Shared Person', email: 'shared-person@example.test', headline: 'Original role', location: 'Madrid' } });
        const update = await createTelegramDraft(...otherArgs, { fields: { primaryEmail: 'shared-person@example.test', headline: 'Proposed role', location: 'Barcelona' }, sourceTitle: 'Second recruiter private chat' });
        let review = await getTelegramDraft(...otherArgs, update.id);
        assert.equal(review.existingCandidate.id, id);
        await assert.rejects(getTelegramDraft(...args, update.id), /unavailable/i);
        const reviewedFields = Object.fromEntries(Object.entries(normalizeTelegramDraftFields(review.proposedFields ?? review.fields)).filter(([key]) => !['telegramUserId', 'ownerMembershipId'].includes(key)));
        reviewedFields.headline = 'Recruiter edited role'; // Edit one proposed field.
        reviewedFields.location = 'Madrid'; // Reject another proposed field.
        review = await updateTelegramDraft(...otherArgs, review.id, { expectedVersion: review.version, fields: reviewedFields });
        await decideTelegramDraft(...otherArgs, review.id, { action: 'approve', expectedVersion: review.version, operationId: randomUUID(), reviewFlow: true, reviewedFields });
        const updated = await getCandidateProfile(...args, { candidateId: id });
        assert.equal(updated.candidate.headline, 'Recruiter edited role');
        assert.equal(updated.candidate.location, 'Madrid');
        assert.ok((await listCandidateProfileDirectory(...args, { q: 'Recruiter edited role' })).rows.some(row => row.candidateId === id));
        const staleDraft = await createTelegramDraft(...otherArgs, { fields: { primaryEmail: 'shared-person@example.test', headline: 'Stale proposal' } });
        const staleReview = await getTelegramDraft(...otherArgs, staleDraft.id);
        await saveCandidateProfile(...args, { candidateId: id, expectedVersion: updated.candidate.version, operationId: randomUUID(), fields: { fullName: 'Shared Person', email: 'shared-person@example.test', headline: 'Concurrent owner edit', location: 'Madrid' } });
        await assert.rejects(decideTelegramDraft(...otherArgs, staleReview.id, { action: 'approve', expectedVersion: staleReview.version, operationId: randomUUID(), reviewFlow: true, reviewedFields: Object.fromEntries(Object.entries(normalizeTelegramDraftFields(staleReview.proposedFields ?? staleReview.fields)).filter(([key]) => !['telegramUserId', 'ownerMembershipId'].includes(key))) }), /Candidate changed/i);
    });

    const existingId = randomUUID();
    await saveCandidateProfile(...args, { candidateId: existingId, expectedVersion: null, operationId: randomUUID(), fields: { fullName: 'Existing Person', email: 'existing.flow@example.test', headline: 'Original', location: 'Madrid' } });
    const foreignCandidate = randomUUID();
    psql(db, `insert into app.candidates(id,organization_id,full_name,identity_state,lifecycle) values('${foreignCandidate}','${AUTHZ_ID.ORG_A}','Other workspace candidate','established','active');`);
    const rankedRows = await withStaffTransaction(pool, owner, org, ['candidates.read'], async ({ client }) =>
        (await client.query('select app.candidate_ranked_directory_rows_v1($1::uuid[]) as rows', [[existingId, foreignCandidate]])).rows[0].rows);
    assert.equal(rankedRows.length, 1, 'ranked directory hydration never includes another workspace');
    assert.equal(rankedRows[0].candidateId, existingId);
    assert.equal(rankedRows[0].email, 'existing.flow@example.test');
    assert.equal(rankedRows[0].headline, 'Original');
    const solidityId = randomUUID(), staffId = randomUUID(), sixYearsId = randomUUID();
    for (const [candidateId, fields] of [
        [solidityId, { fullName: 'Search Alex', email: 'search-alex@example.test', headline: 'Senior Solidity engineer', professionalSummary: 'Five years of Ethereum experience; open to remote roles.' }],
        [staffId, { fullName: 'Search Maya', email: 'search-maya@example.test', headline: 'Staff backend engineer', professionalSummary: 'Leads a Go and Python platform team.' }],
        [sixYearsId, { fullName: 'Search Morgan', email: 'search-morgan@example.test', headline: 'Python backend engineer', professionalSummary: 'Six years of experience; fully remote.' }],
    ]) await saveCandidateProfile(...args, { candidateId, fields, expectedVersion: null, operationId: randomUUID() });
    const searchIds = async q => (await listCandidateProfileDirectory(...args, { q })).rows.map(row => row.candidateId);
    assert.deepEqual(await searchIds('Solidity'), [solidityId]);
    assert.deepEqual(await searchIds('staff engineer'), [staffId]);
    assert.deepEqual(await searchIds('6 years'), [sixYearsId]);
    assert.deepEqual(await searchIds('six years of experience'), [sixYearsId]);
    assert.deepEqual(await searchIds('Solidity engineer with at least five years of experience'), [solidityId]);
    assert.deepEqual(await searchIds('Solidity engineer with six years'), []);
    assert.deepEqual(await searchIds('seven years'), [], 'unknown or different experience does not satisfy an explicit constraint');
    assert.deepEqual(await searchIds('search-alex@example.test'), [solidityId]);

    const update = await createTelegramDraft(...args, { fields: { firstName: 'Existing', lastName: 'Person', primaryEmail: 'existing.flow@example.test', headline: 'Updated' } });
    let review = await getTelegramDraft(...args, update.id);
    assert.equal(review.existingCandidate.id, existingId);
    assert.equal(review.existingCandidate.fields.headline, 'Original');
    assert.equal(review.fields.location, 'Madrid', 'unmentioned profile fields survive');
    assert.equal((await approve(review)).candidateId, existingId);
    profile = await getCandidateProfile(...args, { candidateId: existingId });
    assert.equal(profile.candidate.headline, 'Updated');
    assert.equal(profile.candidate.location, 'Madrid');
    const rejected = await createTelegramDraft(...args, { fields: { primaryEmail: 'existing.flow@example.test', headline: 'Rejected' } });
    review = await getTelegramDraft(...args, rejected.id);
    await decideTelegramDraft(...args, review.id, { action: 'discard', expectedVersion: review.version, operationId: randomUUID(), reviewFlow: true });
    profile = await getCandidateProfile(...args, { candidateId: existingId });
    assert.equal(profile.candidate.headline, 'Updated');
    let archive = await listTelegramDrafts(...args, { view: 'archived' });
    const archivedUpdate = archive.drafts.find(row => row.fields.headline === 'Rejected');
    assert.ok(archivedUpdate, 'rejected update keeps its proposed fields in the archive');
    assert.equal(archivedUpdate.existingCandidate.id, existingId);
    assert.notEqual(archivedUpdate.id, rejected.id, 'archive snapshot is independent of future extraction');
    const restored = await decideTelegramDraft(...args, archivedUpdate.id, { action: 'reopen', expectedVersion: archivedUpdate.version, operationId: randomUUID(), reviewFlow: true });
    assert.equal(restored.status, 'pending');
    assert.equal(restored.proposedFields.headline, 'Rejected');
    assert.equal((await listTelegramDrafts(...args, { view: 'archived' })).drafts.some(row => row.id === archivedUpdate.id), false);
    await decideTelegramDraft(...args, restored.id, { action: 'discard', expectedVersion: restored.version, operationId: randomUUID(), reviewFlow: true });
    const recoverable = await createTelegramDraft(...args, { fields: { firstName: 'Recoverable', lastName: 'Candidate', headline: 'Keep this information' } });
    psql(db, `insert into app.telegram_extraction_subjects(organization_id,owner_user_id,identity_key,draft_id,reviewed_fields) values('${org}','${AUTHZ_ID.USER_ADMIN2}','email:recoverable@example.test','${recoverable.id}','{}');`);
    await decideTelegramDraft(...args, recoverable.id, { action: 'discard', expectedVersion: recoverable.version, operationId: randomUUID(), reviewFlow: true });
    archive = await listTelegramDrafts(...args, { view: 'archived', q: 'Recoverable' });
    assert.equal(archive.drafts.length, 1);
    assert.equal(archive.drafts[0].fields.headline, 'Keep this information');
    const restoredNew = await decideTelegramDraft(...args, archive.drafts[0].id, { action: 'reopen', expectedVersion: archive.drafts[0].version, operationId: randomUUID(), reviewFlow: true });
    assert.equal(restoredNew.status, 'pending');
    psql(db, `do $$ begin if not exists(select 1 from app.telegram_extraction_subjects where draft_id='${restoredNew.id}' and identity_key='email:recoverable@example.test') then raise exception 'Restored candidate must accept future extraction'; end if; end $$;`);
    const stale = await createTelegramDraft(...args, { fields: { primaryEmail: 'existing.flow@example.test', headline: 'Telegram update' } });
    review = await getTelegramDraft(...args, stale.id);
    await saveCandidateProfile(...args, { candidateId: existingId, expectedVersion: profile.candidate.version, operationId: randomUUID(), fields: { fullName: 'Existing Person', email: 'existing.flow@example.test', headline: 'Concurrent edit', location: 'Paris' } });
    await assert.rejects(() => approve(review), error => error.code === '40001');
    review = await refreshTelegramReview(...args, review.id, { expectedVersion: review.version });
    assert.equal(review.fields.location, 'Paris');
    assert.equal(review.fields.headline, 'Telegram update');
    review = await updateTelegramDraft(...args, review.id, { expectedVersion: review.version, fields: { headline: 'Recruiter edited' } });
    await approve(review);
    profile = await getCandidateProfile(...args, { candidateId: existingId });
    assert.equal(profile.candidate.headline, 'Recruiter edited');
    assert.equal(profile.candidate.location, 'Paris');
    const manual = await createTelegramDraft(...args, { fields: { headline: 'Manual match' } });
    const matches = await telegramReviewMatches(...args, manual.id, 'Existing Person');
    assert.equal(matches[0].id, existingId);
    const matched = await matchTelegramReview(...args, manual.id, { expectedVersion: manual.version, candidateId: existingId });
    assert.equal(matched.fields.location, 'Paris', 'manual matching preserves unmentioned fields');
    assert.equal(matched.fields.primaryEmail, 'existing.flow@example.test');
    const approved = await approve(matched);
    assert.equal(approved.candidateId, existingId);
    assert.equal((await approve(matched)).replayed, true, 'lost approval acknowledgements replay safely');
    // A background refresh must wait for an approval's owner lock before it
    // locks another draft, otherwise the approval can deadlock reading it.
    const concurrentA = await createTelegramDraft(...args, { fields: { firstName: 'Concurrent', lastName: 'A' } });
    const concurrentB = await createTelegramDraft(...args, { fields: { firstName: 'Concurrent', lastName: 'B' } });
    let firstLocked, continueFirst, secondStarted;
    const locked = new Promise(resolve => { firstLocked = resolve; });
    const continueRead = new Promise(resolve => { continueFirst = resolve; });
    const startedSecond = new Promise(resolve => { secondStarted = resolve; });
    let secondPrepared = false;
    const firstTransaction = withStaffTransaction(...args, ['candidates.read', 'candidates.write'], async ({ client }) => {
        await client.query('select app.telegram_review_decide_v1($1,$2,$3,$4)', [concurrentA.id, concurrentA.version, 'approve', randomUUID()]);
        firstLocked(); await continueRead;
        await client.query('select app.telegram_review_draft_v1($1)', [concurrentB.id]);
    });
    await locked;
    const secondTransaction = withStaffTransaction(...args, ['candidates.read', 'candidates.write'], async ({ client }) => {
        secondStarted();
        await client.query('select app.telegram_review_draft_v1($1)', [concurrentB.id]);
        secondPrepared = true;
        await client.query('select app.telegram_review_decide_v1($1,$2,$3,$4)', [concurrentB.id, concurrentB.version, 'approve', randomUUID()]);
    });
    await startedSecond;
    try {
        await new Promise(resolve => setTimeout(resolve, 80));
        assert.equal(secondPrepared, false, 'refresh waits before taking the draft row lock');
    } finally {
        continueFirst();
        const outcomes = await Promise.allSettled([firstTransaction, secondTransaction]);
        for (const outcome of outcomes) assert.equal(outcome.status, 'fulfilled', outcome.reason?.message);
    }
    const registered = await registerTelegramWorker(...args, 'Synthetic intake worker');
    const connection = randomUUID(), account = randomUUID(), chat = randomUUID();
    const publicKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    psql(db, `insert into app.telegram_connector_workers(id,organization_id,owner_user_id,public_key_spki) values('${registered.id}','${org}','${AUTHZ_ID.USER_ADMIN2}','${publicKey}');
        insert into app.telegram_connections(id,organization_id,owner_user_id,worker_id,status,auth_expires_at,profile) values('${connection}','${org}','${AUTHZ_ID.USER_ADMIN2}','${registered.id}','connected',now()+interval '1 hour','{"telegramUserId":"123","username":"synthetic","displayName":"Synthetic"}');
        insert into app.telegram_history_limits(organization_id,owner_user_id,stored_chats) values('${org}','${AUTHZ_ID.USER_ADMIN2}',1);
        insert into app.telegram_history_accounts(id,organization_id,owner_user_id,connection_id,account_user_id) values('${account}','${org}','${AUTHZ_ID.USER_ADMIN2}','${connection}','123');
        insert into app.telegram_history_chats(id,organization_id,owner_user_id,account_id,peer_kind,peer_id,title) values('${chat}','${org}','${AUTHZ_ID.USER_ADMIN2}','${account}','user','456','Candidate chat');`);
    const availableBefore = await telegramHistoryRecentStatus(...args, { view: 'available' });
    assert.equal(availableBefore.totals.available, 1);
    assert.equal(availableBefore.totals.connected, 0);
    await assert.rejects(() => telegramHistoryAction(...args, { action: 'start', chats: [{ chatId: chat, expectedVersion: 1 }, { chatId: randomUUID(), expectedVersion: 1 }] }));
    let history = await telegramHistoryStatus(...args);
    assert.equal(history.chats[0].selected, false, 'failed Start rolls back selection');
    assert.equal(await telegramOnboardingComplete(...args), false, 'failed Start preserves onboarding');
    await telegramHistoryAction(...args, { action: 'start', chats: [{ chatId: chat, expectedVersion: 1 }] });
    history = await telegramHistoryStatus(...args);
    assert.equal(history.chats[0].selected, true);
    assert.equal(await telegramOnboardingComplete(...args), true);
    psql(db, `update app.telegram_history_chats set selected=false where id='${chat}';`);
    assert.equal(await telegramOnboardingComplete(...args), true, 'deselecting chats never resets onboarding');
    assert.equal(history.chats[0].extractionEnabled, true, 'one Start enables automatic extraction');
    assert.equal((await telegramHistoryRecentStatus(...args, { view: 'available' })).chats.length, 0);
    const connected = await telegramHistoryRecentStatus(...args, { view: 'connected' });
    assert.equal(connected.totals.connected, 1);
    await assert.rejects(() => telegramHistoryAction(...args, { action: 'start', chats: [{ chatId: chat, expectedVersion: history.chats[0].version }] }), error => error.code === '40001');
    await telegramHistoryAction(...args, { action: 'pause', chatId: chat, expectedVersion: history.chats[0].version });
    history = await telegramHistoryStatus(...args);
    assert.equal(history.chats[0].import.status, 'paused');
    assert.equal((await telegramHistoryRecentStatus(...args, { view: 'available' })).chats.length, 0, 'paused chats remain connected');
    assert.equal(history.chats[0].extractionEnabled, false, 'Pause stops candidate processing as well as synchronization');
    const idlePaused = await telegramExtractionStatus(...args);
    assert.equal(idlePaused.counts.active, 0);
    assert.equal(idlePaused.counts.paused, 1, 'a stopped chat stays visibly paused without queued work');
    const pausedJob = randomUUID();
    psql(db, `insert into app.telegram_extraction_jobs(id,organization_id,owner_user_id,chat_id,source,source_digest,message_count) values('${pausedJob}','${org}','${AUTHZ_ID.USER_ADMIN2}','${chat}','{"chat":{},"messages":[]}',sha256(convert_to('paused-test','UTF8')),0);`);
    let activity = await telegramExtractionStatus(...args);
    assert.equal(activity.counts.active, 0);
    assert.equal(activity.counts.paused, 1);
    assert.equal(activity.jobs.find(j => j.id === pausedJob).processingPaused, true);
    const filteredActivity = await telegramExtractionStatus(...args, { view: 'needs_review' });
    assert.equal(filteredActivity.counts.paused, 1, 'activity counts do not depend on the selected page or view');
    await telegramHistoryAction(...args, { action: 'resume', chatId: chat, expectedVersion: history.chats[0].version });
    history = await telegramHistoryStatus(...args);
    assert.equal(history.chats[0].extractionEnabled, true, 'Resume continues candidate extraction too');
    activity = await telegramExtractionStatus(...args);
    assert.equal(activity.counts.paused, 0);
    assert.equal(activity.counts.active, 1);
    assert.equal(activity.jobs.find(j => j.id === pausedJob).processingPaused, false);
    psql(db, `insert into app.telegram_extraction_subjects(organization_id,owner_user_id,identity_key,draft_id,reviewed_fields) values('${org}','${AUTHZ_ID.USER_ADMIN2}','email:existing.flow@example.test','${update.id}','{}');`);
    const addProposal = headline => {
        const job = randomUUID();
        psql(db, `insert into app.telegram_extraction_jobs(id,organization_id,owner_user_id,chat_id,source,source_digest,message_count,status,receipt,completed_at) values('${job}','${org}','${AUTHZ_ID.USER_ADMIN2}','${chat}','{"chat":{},"messages":[]}',sha256(convert_to('synthetic','UTF8')),0,'completed','{"draftIds":["${update.id}"]}',now());
            insert into app.telegram_extraction_proposals(organization_id,owner_user_id,job_id,draft_id,field,suggested_value,evidence,status) values('${org}','${AUTHZ_ID.USER_ADMIN2}','${job}','${update.id}','headline',to_jsonb('${headline}'::text),'[]','pending');`);
        return job;
    };
    const job = addProposal('Later Telegram information');
    review = await getTelegramDraft(...args, update.id);
    assert.equal(review.status, 'pending', 'later information reopens a profile update');
    assert.equal(review.proposedFields.headline, 'Later Telegram information');
    addProposal('Newest Telegram information');
    await assert.rejects(() => approve(review), error => error.code === '40001', 'unseen information requires another review');
    review = await getTelegramDraft(...args, update.id);
    assert.equal(review.proposedFields.headline, 'Newest Telegram information');
    const purge = () => psql(db, `begin;set local role app_executor;select set_config('app.organization_id','${org}',true);select set_config('app.actor_id','${AUTHZ_ID.USER_ADMIN2}',true);select app.telegram_retention_purge_v1('${job}');commit;`);
    assert.match(purge(), /"purged": false/, 'unresolved proposals retain evidence');
    await approve(review);
    profile = await getCandidateProfile(...args, { candidateId: existingId });
    assert.equal(profile.candidate.headline, 'Newest Telegram information', 'latest reviewed information is saved');
    assert.match(purge(), /"purged": true/, 'resolved proposals release their source');
    addProposal('Rejected later update');
    review = await getTelegramDraft(...args, update.id);
    await decideTelegramDraft(...args, review.id, { action: 'discard', expectedVersion: review.version, operationId: randomUUID(), reviewFlow: true });
    addProposal('Information after rejection');
    review = await getTelegramDraft(...args, update.id);
    assert.equal(review.status, 'pending', 'rejecting an update does not block future information');
    assert.equal(review.proposedFields.headline, 'Information after rejection');
    const indexed = psql(db, `select count(*) from app.profile_search_sources where source_id='${existingId}'`);
    assert.match(indexed, /1/, 'accepted profile updates stay in the semantic index');
});
