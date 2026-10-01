import assert from 'node:assert/strict';
import test from 'node:test';
import { createSemanticWorker } from '../../services/semantic-worker/worker.mjs';
import { createLocalClient } from '../../services/semantic-worker/local.mjs';
import { registerTelegramWorker } from '../../src/lib/telegram-intake-operations.js';
import { cvSearchFixture, drain, search, other, org } from '../support/cv-search-runtime.js';
import { cvRelevanceProfiles, cvRelevanceQueries } from '../fixtures/cv-search-relevance.js';

async function allResults(f, detail, actor) {
  const results = [...detail.results]; let cursor = detail.nextAfter;
  const seenCursors = new Set();
  while (cursor) {
    assert.ok(!seenCursors.has(cursor), 'Pagination must make progress'); seenCursors.add(cursor);
    const page = await f.status({ queryId: detail.queryId, after: cursor }, actor);
    assert.equal(page.status, 'completed'); results.push(...page.results); cursor = page.nextAfter;
  }
  assert.equal(new Set(results.map(row => row.sourceId)).size, results.length, 'Each candidate appears once across components/pages');
  return results;
}
const publicRanking = results => results.map(({ sourceId, score, matchedComponent, matchedDocument, matchedText }) => ({ sourceId, score, matchedComponent, matchedDocument, matchedText }));

// Requires the already-running pinned local model; does not start/download a
// model, contact Telegram, or use production records. Ordinary CI skips it.
test('actual E5 retrieves CV-only multilingual passages and preserves document-ineligible rankings', {
  timeout: 1200000, skip: !process.env.SEMANTIC_EMBEDDING_TOKEN_FILE,
}, async t => {
  const base = new URL(process.env.SEMANTIC_EMBEDDING_URL ?? 'http://127.0.0.1:8818/v1/embeddings');
  assert.equal(base.hostname, '127.0.0.1'); assert.equal(base.protocol, 'http:');
  const local = createLocalClient({ embeddingUrl: base.origin, embeddingTokenFile: process.env.SEMANTIC_EMBEDDING_TOKEN_FILE });
  const f = await cvSearchFixture(t);
  const runtime = createSemanticWorker({ host: f.host, ...local, vault: f.store() });
  const registeredOther = await registerTelegramWorker(f.pool, other, org, 'Synthetic profile-only relevance worker');
  const profileOnlyRuntime = createSemanticWorker({ host: f.makeHost(registeredOther.token), ...local, vault: f.store('profile-only', registeredOther.token) });
  const profilesById = new Map();
  for (const profile of cvRelevanceProfiles) {
    assert.equal(Object.hasOwn(profile.fields, 'headline'), false);
    assert.equal(Object.hasOwn(profile.fields, 'professionalSummary'), false);
    assert.equal(Object.hasOwn(profile.fields, 'location'), false);
    assert.ok(Buffer.byteLength(profile.text) <= 65536);
    assert.equal(profile.blocks.map(block => block.text).join('\n\n'), profile.text);
    profilesById.set(await f.candidate(profile.fields), profile);
  }
  await drain(runtime);
  const baseline = [];
  for (const { query } of cvRelevanceQueries.slice(0, 2)) {
    const detail = await search(f, profileOnlyRuntime, query, { includeCv: false }, other);
    baseline.push({ query, coverage: detail.coverage, ranking: publicRanking(await allResults(f, detail, other)) });
  }
  await assert.rejects(f.action({ action: 'retryIndex', scope: 'approved', readyOnly: false, includeCv: true }, other), error => error.code === '42501' || error.status === 403);
  for (const [id, profile] of profilesById) await f.reviewedCv(id, profile.text, { blocks: profile.blocks });
  await drain(runtime);

  for (const before of baseline) {
    const detail = await search(f, profileOnlyRuntime, before.query, { includeCv: false }, other);
    assert.deepEqual(publicRanking(await allResults(f, detail, other)), before.ranking,
      'CV indexing must not change scores, order or excerpts without document access');
    assert.deepEqual(detail.coverage, before.coverage, 'Profile-only coverage must not disclose CV indexing');
    assert.equal(detail.coverage.cv, null);
  }

  let recall = 0, reciprocalRank = 0, tailHits = 0, tailTotal = 0;
  const languageHits = { en: 0, es: 0 }, languageTotal = { en: 0, es: 0 };
  const rows = [];
  for (const query of cvRelevanceQueries) {
    const detail = await search(f, runtime, query.query);
    assert.equal(detail.coverage.pending, 0); assert.equal(detail.coverage.failed, 0);
    assert.equal(detail.coverage.eligible, cvRelevanceProfiles.length);
    assert.equal(detail.coverage.fullyIndexed, cvRelevanceProfiles.length);
    const results = await allResults(f, detail);
    assert.equal(results.length, cvRelevanceProfiles.length, 'No candidate or CV passage corpus may be silently capped');
    const relevant = new Set(query.relevantKeys), top = results.slice(0, 10);
    const keys = top.map(row => profilesById.get(row.sourceId).key);
    const first = results.findIndex(row => relevant.has(profilesById.get(row.sourceId).key));
    const queryRecall = keys.filter(key => relevant.has(key)).length / relevant.size;
    recall += queryRecall; reciprocalRank += first < 0 ? 0 : 1 / (first + 1);
    for (const [id, profile] of profilesById) if (relevant.has(profile.key)) {
      const hit = top.find(row => row.sourceId === id);
      languageTotal[profile.language]++; if (hit) languageHits[profile.language]++;
      if (profile.position === 'end') { tailTotal++; if (hit) tailHits++; }
      if (hit) {
        assert.equal(hit.matchedComponent, 'cv'); assert.ok(hit.matchedDocument?.id);
        assert.ok(profile.text.includes(hit.matchedText), 'Excerpt must be verbatim retained CV text');
      }
      if (profile.nearLimit) {
        assert.ok(Buffer.byteLength(profile.text) >= 64000);
        assert.ok(hit, 'The near64KiB CV tail must be retrieved in both query languages');
        const { rows: [winning] } = await f.admin.query(`select ch.start_byte from app.profile_search_results r
          join app.profile_search_chunks ch on ch.source_id=r.source_id and ch.ordinal=r.ordinal and ch.revision=r.source_revision
          where r.query_id=$1 and r.public_source_id=$2`, [detail.queryId, id]);
        assert.ok(winning?.start_byte > 60000, 'Winning passage must come from the long CV tail');
      }
    }
    rows.push({ queryId: query.id, recallAt10: queryRecall, reciprocalRank: first < 0 ? 0 : 1 / (first + 1) });
  }
  const metrics = { syntheticOnly: true, model: 'intfloat/multilingual-e5-small', profiles: profilesById.size,
    queries: cvRelevanceQueries.length, cvOnlyRecallAt10: recall / cvRelevanceQueries.length,
    mrr: reciprocalRank / cvRelevanceQueries.length, tailRecallAt10: tailHits / tailTotal,
    englishCvRecallAt10: languageHits.en / languageTotal.en, spanishCvRecallAt10: languageHits.es / languageTotal.es };
  t.diagnostic(JSON.stringify({ ...metrics, perQuery: rows }));
  assert.ok(metrics.cvOnlyRecallAt10 >= 0.85, JSON.stringify(metrics));
  assert.ok(metrics.mrr >= 0.8, JSON.stringify(metrics));
  assert.ok(metrics.tailRecallAt10 >= 0.85, JSON.stringify(metrics));
});
