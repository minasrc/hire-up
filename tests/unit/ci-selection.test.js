import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JOBS, planEvent, reusableRun, selectJobs } from '../../scripts/ci-selection.mjs';

const selected = (paths) => Object.entries(selectJobs(paths).selection).filter(([, enabled]) => enabled).map(([job]) => job);
const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const parent = 'c'.repeat(40);
const repository = 'example/agora';
const goodRun = { id: 1, head_sha: parent, event: 'pull_request', status: 'completed',
    conclusion: 'success', head_repository: { full_name: repository } };

test('docs and CI policy changes avoid unrelated application suites', () => {
    assert.deepEqual(selected(['docs/release.md', 'services/mac-worker/README.md']), []);
    assert.deepEqual(selected(['.github/workflows/ci.yml', 'scripts/ci-selection.mjs', 'tests/unit/ci-selection.test.js']), ['quality']);
    assert.equal(selectJobs(['scripts/ci-selection.mjs']).appChecks, false);
});

test('directory and search UI changes run dependent workflows, without unrelated workers', () => {
    assert.deepEqual(selected(['src/app/staff/applications/applications-browser.tsx']), ['quality', 'staff-workspace']);
    assert.deepEqual(selected(['src/app/staff/candidates/candidates-browser.tsx']),
        ['quality', 'staff-workspace', 'duplicate-review', 'profile-search', 'cv-analysis']);
    assert.deepEqual(selected(['src/app/staff/candidates/search/page.tsx']), ['quality', 'profile-search', 'cv-search']);
    assert.deepEqual(selected(['src/app/for-employers/page.jsx']), ['quality', 'browser-tests']);
});

test('document preview consumers run their authenticated workflow, not unrelated worker suites', () => {
    for (const file of ['src/app/api/staff/documents/[documentId]/route.ts',
        'src/lib/staff-document-preview-cache.js',
        'src/components/staff-preview/document-preview-provider.tsx',
        'src/components/staff-preview/pdf-document-preview.tsx',
        'src/components/staff-preview/real-candidate-documents.tsx']) {
        assert.deepEqual(selected([file]), ['quality', 'staff-workspace']);
        assert.equal(selectJobs([file]).appChecks, true);
    }
});

test('a reviewed document migration is scoped only while its exact contents are unchanged', () => {
    const file = 'supabase/migrations/20261009090000_document_preview_versions.sql';
    assert.deepEqual(selected([file]), ['quality', 'staff-workspace']);
    assert.deepEqual(selectJobs([file], false, () => 'alter table app.users drop column id;').selection,
        Object.fromEntries(JOBS.map(job => [job, true])));
    assert.deepEqual(selectJobs([file], false, () => { throw new Error('deleted'); }).selection,
        Object.fromEntries(JOBS.map(job => [job, true])));
    assert.deepEqual(selected([file, 'src/lib/staff-authorization.js']),
        selected(['src/lib/staff-authorization.js']));
    assert.deepEqual(selected([file, 'supabase/migrations/unknown.sql']), JOBS);
    const suite = readFileSync(new URL('../../tests/database/candidate-upload.test.js', import.meta.url), 'utf8');
    assert.ok(suite.includes(file.split('/').at(-1)), 'selected database suite must apply the scoped migration');
    assert.ok(suite.includes('getDocumentDownload'), 'the suite must exercise the changed function');
});

test('shared security keeps staff coverage; schema, dependencies and unknown files get everything', () => {
    const staff = selected(['src/lib/staff-authorization.js']);
    assert.ok(staff.includes('database-staff-authorization'));
    assert.ok(staff.includes('browser-tests'), 'standard E2E includes staff login/MFA');
    assert.ok(staff.includes('telegram-connection'));
    assert.ok(staff.includes('cv-analysis'));
    for (const file of ['package-lock.json', 'supabase/migrations/new.sql', 'tests/support/staff-authorization.js', 'src/lib/new-feature.js']) {
        assert.deepEqual(selected([file]), JOBS);
    }
});

test('shared layouts cover every staff browser workflow without unrelated database-only jobs', () => {
    for (const file of ['src/app/layout.jsx', 'src/app/staff/layout.tsx', 'src/app/staff/session-provider.tsx']) {
        const jobs = selected([file]);
        assert.ok(jobs.includes('browser-tests'));
        assert.ok(jobs.includes('staff-workspace'));
        assert.ok(jobs.includes('cv-analysis'));
        assert.ok(jobs.includes('worker-pairing'));
        assert.ok(!jobs.some((job) => job.startsWith('database-')));
    }
    assert.ok(selected(['src/app/api/staff/mfa/verify/route.ts']).includes('database-staff-totp'));
    assert.deepEqual(selected(['src/app/(public)/layout.jsx']), ['quality', 'browser-tests']);
});

test('suite tests route correctly and unmapped tests cannot silently disappear', () => {
    assert.deepEqual(selected(['tests/database/staff-totp.test.js']), ['quality', 'database-staff-totp']);
    assert.deepEqual(selected(['tests/staff-workspace/record-preview.test.js']), ['quality', 'staff-workspace']);
    assert.deepEqual(selected(['tests/database/new-feature.test.js']), JOBS);
});

test('reuse requires the latest completed successful same-repository PR run for the exact head', () => {
    assert.equal(reusableRun([goodRun], parent, repository), goodRun);
    assert.equal(reusableRun([goodRun, { ...goodRun, id: 2, conclusion: 'failure' }], parent, repository), null);
    assert.equal(reusableRun([{ ...goodRun, status: 'in_progress' }], parent, repository), null);
    assert.equal(reusableRun([{ ...goodRun, head_sha: head }], parent, repository), null);
    assert.equal(reusableRun([{ ...goodRun, event: 'push' }], parent, repository), null);
    assert.equal(reusableRun([{ ...goodRun, head_repository: { full_name: 'other/repo' } }], parent, repository), null);
});

function pushPlan({ sameTree = true, parents = `${base} ${parent}`, runs = async () => [goodRun] } = {}) {
    return planEvent({ eventName: 'push', event: { before: base, after: head }, repository, runs,
        git: (args) => {
            if (args[0] === 'show') return parents;
            if (args[0] === 'rev-parse') return args[1].startsWith(head) && !sameTree ? 'changed-tree' : 'same-tree';
            assert.equal(args[0], 'diff');
            assert.ok(args.includes('--no-renames'));
            return 'src/app/staff/applications/page.tsx\0';
        } });
}

test('identical green merge reuses validation without reinstalling dependencies or running tests', async () => {
    const plan = await pushPlan();
    assert.deepEqual(Object.values(plan.selection), JOBS.map(() => false));
    assert.match(plan.reason, /Reused successful PR CI run/);
});

test('changed merge, failed proof, API outage and direct pushes still validate affected code', async () => {
    for (const options of [{ sameTree: false }, { runs: async () => [] },
        { runs: async () => { throw new Error('API unavailable'); } }, { parents: base }]) {
        const plan = await pushPlan(options);
        assert.equal(plan.selection.quality, true);
        assert.equal(plan.selection['staff-workspace'], true);
    }
});

test('PR selection uses merge-base diff, includes deleted paths and rejects untrusted revisions', async () => {
    const args = [];
    const plan = await planEvent({ eventName: 'pull_request', repository,
        event: { pull_request: { base: { sha: base }, head: { sha: head } } },
        git: (input) => { args.push(input); return 'src/app/staff/jobs/deleted.tsx\0'; } });
    assert.equal(plan.selection['staff-workspace'], true);
    assert.equal(args[0].at(-1), `${base}...${head}`);
    const invalid = await planEvent({ eventName: 'pull_request', event: {}, repository,
        git: () => { throw new Error('Must not execute git'); } });
    assert.ok(Object.values(invalid.selection).every(Boolean));
    const manual = await planEvent({ eventName: 'workflow_dispatch', event: {} });
    assert.ok(Object.values(manual.selection).every(Boolean));
});

test('all workflow suites are controlled by the selector and the aggregate gate covers every job', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const jobs = [...workflow.split(/^jobs:\n/m)[1].matchAll(/^  ([a-z][a-z-]+):$/gm)].map((match) => match[1]);
    assert.deepEqual(jobs.filter((job) => !['plan', 'validation'].includes(job)), JOBS);
    for (const job of JOBS) {
        assert.ok(workflow.includes(`  ${job}:\n    needs: plan\n    if: \${{ fromJSON(needs.plan.outputs.selection)['${job}'] }}`));
    }
    assert.ok(workflow.includes(`needs: [plan, ${JOBS.join(', ')}]`));
    assert.ok(workflow.includes("if (enabled && results[job]?.result !== 'success')"));
});
