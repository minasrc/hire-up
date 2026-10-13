import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JOBS, planEvent, reusableRun, selectJobs } from '../../scripts/ci-selection.mjs';
import { RUNNERS } from '../../scripts/ci-groups.mjs';

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

test('browser configuration selects quality and browser coverage', () => {
    assert.deepEqual(selected(['playwright.config.mjs']), ['quality', 'browser-tests']);
    assert.equal(selectJobs(['playwright.config.mjs']).appChecks, true);
});

test('directory and search UI changes run dependent workflows, without unrelated workers', () => {
    assert.deepEqual(selected(['src/app/staff/applications/applications-browser.tsx']), ['quality', 'staff-workspace']);
    assert.deepEqual(selected(['src/app/staff/candidates/candidates-browser.tsx']),
        ['quality', 'staff-workspace', 'duplicate-review', 'profile-search', 'cv-analysis']);
    assert.deepEqual(selected(['src/app/staff/candidates/search/page.tsx']), ['quality', 'profile-search', 'cv-search']);
    assert.deepEqual(selected(['src/app/for-employers/page.jsx']), ['quality', 'browser-tests']);
});

test('overview and client/job/member forms keep route guards and real workspace coverage', () => {
    for (const file of ['src/app/staff/page.tsx', 'src/app/staff/overview-sections.tsx', 'src/app/staff/workspace-forms.tsx']) {
        assert.deepEqual(selected([file]), ['quality', 'browser-tests', 'staff-workspace']);
    }
    const fixtures = readFileSync(new URL('../staff-workspace/workspace.test.js', import.meta.url), 'utf8');
    for (const regression of ['overview renders live metrics', 'job creation persists', 'member invitation records locally']) {
        assert.ok(fixtures.includes(regression), regression);
    }
    // Editing shared auth instead of the consuming form still selects every
    // dependent browser workflow, including the scoped Mac/Telegram workers.
    assert.ok(selected(['src/lib/staff-mutation.ts']).includes('worker-pairing'));
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
    for (const file of ['src/app/layout.jsx', 'src/app/staff/layout.tsx', 'src/app/staff/session-provider.tsx',
        'src/lib/staff-auth-recovery.js', 'src/lib/staff-mutation.ts']) {
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
    assert.deepEqual(jobs.filter((job) => !['plan', 'validation'].includes(job)), Object.keys(RUNNERS));
    assert.deepEqual(Object.values(RUNNERS).flat().sort(), [...JOBS].sort());
    for (const job of Object.keys(RUNNERS)) {
        const needs = job === 'browser-tests' ? '[plan, quality]' : 'plan';
        const output = ['quality', 'browser-tests', 'database-foundation'].includes(job) ? 'selection' : 'runners';
        assert.ok(workflow.includes(`  ${job}:\n    needs: ${needs}\n    if: \${{ fromJSON(needs.plan.outputs.${output})['${job}'] }}`));
    }
    assert.ok(workflow.includes(`needs: [plan, ${Object.keys(RUNNERS).join(', ')}]`));
    assert.ok(workflow.includes('run: node scripts/run-ci-group.mjs validate'));
});

test('feature APIs retain all downstream workflow consumers without unrelated staff suites', () => {
    const dependents = {
        'telegram-history': ['telegram-history', 'telegram-context', 'telegram-source-updates', 'telegram-extraction', 'telegram-cv', 'telegram-retention', 'cv-analysis'],
        'telegram-connection': ['telegram-connection', 'telegram-history', 'telegram-context', 'telegram-source-updates', 'telegram-extraction', 'telegram-cv', 'telegram-retention', 'cv-analysis', 'worker-pairing'],
        'telegram-extraction': ['telegram-extraction', 'telegram-cv', 'telegram-retention', 'cv-analysis'],
        'telegram-cv': ['telegram-cv', 'cv-analysis'],
        'profile-search': ['profile-search', 'cv-search'],
        'cv-analysis': ['cv-analysis', 'cv-search'],
    };
    for (const [feature, suites] of Object.entries(dependents)) {
        for (const prefix of ['src/app/api/staff/', 'src/app/api/']) {
            assert.deepEqual(selected([`${prefix}${feature}/route.ts`]).sort(), ['quality', ...suites].sort());
        }
    }
    // Fixtures that call these endpoints must continue to be selected, even
    // when the route is only used to prepare data for a downstream feature.
    for (const suite of JOBS.filter(suite => !['quality', 'browser-tests'].includes(suite) && !suite.startsWith('database-'))) {
        const testName = suite === 'staff-workspace' ? 'workspace' : suite;
        const fixture = readFileSync(new URL(suite === 'telegram-source-updates' ? '../database/telegram-source-updates-runtime.test.js' : `../staff-workspace/${testName}.test.js`, import.meta.url), 'utf8');
        for (const feature of Object.keys(dependents)) {
            if (fixture.includes(`/api/staff/${feature}`) || fixture.includes(`/api/${feature}/worker/`)) {
                assert.ok(dependents[feature].includes(suite), `${feature} must cover ${suite}`);
            }
        }
    }
    assert.ok(selected(['src/lib/staff-api.server.js']).includes('database-staff-authorization'));
    assert.deepEqual(selected(['supabase/migrations/new.sql']), JOBS);
});

test('Telegram page coverage includes its consumers; shared intake still covers the whole chain', () => {
    const connectionCommand = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).scripts['test:telegram-connection'];
    for (const path of ['tests/database/telegram-hosted.test.js', 'tests/staff-workspace/telegram-hosted.test.js']) {
        assert.ok(connectionCommand.includes(path), 'The connection workflow must actually run each mapped hosted test');
        assert.deepEqual(selected([path]), ['quality', 'telegram-connection']);
    }
    assert.deepEqual(selected(['src/app/staff/telegram-intake/chats/history-model.js']), ['quality', 'telegram-connection', 'telegram-history', 'telegram-source-updates']);
    assert.deepEqual(selected(['src/app/staff/telegram-intake/connect/worker-pairing-panel.tsx']), ['quality', 'telegram-connection', 'worker-pairing']);
    assert.ok(selected(['src/app/staff/telegram-intake/extraction/batch-source.tsx']).includes('cv-analysis'));
    for (const job of ['telegram-intake', 'telegram-history', 'profile-search', 'cv-analysis', 'cv-search', 'worker-pairing']) {
        assert.ok(selected(['src/app/staff/telegram-intake/intake-model.ts']).includes(job));
    }
});

test('manual maintenance stays independent of hourly activation and shares the execution lock', () => {
    const scheduled = readFileSync(new URL('../../.github/workflows/telegram-maintenance.yml', import.meta.url), 'utf8');
    const manual = readFileSync(new URL('../../.github/workflows/telegram-maintenance-manual.yml', import.meta.url), 'utf8');
    const runner = readFileSync(new URL('../../.github/workflows/telegram-maintenance-run.yml', import.meta.url), 'utf8');
    assert.match(manual, /^on:\n  workflow_dispatch:\n/m);
    assert.match(runner, /^on:\n  workflow_call:\n/m);
    for (const workflow of [manual, runner]) {
        assert.doesNotMatch(workflow, /^  (schedule|push|pull_request|workflow_run|repository_dispatch):/m);
    }
    for (const workflow of [manual, scheduled]) {
        assert.match(workflow, /uses: \.\/\.github\/workflows\/telegram-maintenance-run\.yml/);
        assert.doesNotMatch(workflow, /^concurrency:/m);
        assert.doesNotMatch(workflow, /secrets: inherit/);
    }
    assert.match(runner, /^concurrency:\n  group: telegram-source-maintenance\n  cancel-in-progress: false/m);
    assert.match(runner, /run: node scripts\/run-telegram-maintenance\.mjs/);
});

test('maintenance and group policy changes avoid expensive application checks', () => {
    for (const file of ['.github/workflows/telegram-maintenance.yml', '.github/workflows/telegram-maintenance-manual.yml',
        '.github/workflows/telegram-maintenance-run.yml', 'scripts/run-telegram-maintenance.mjs',
        'scripts/ci-groups.mjs', 'scripts/run-ci-group.mjs']) {
        assert.deepEqual(selected([file]), ['quality']);
        assert.equal(selectJobs([file]).appChecks, false);
    }
});

test('browser job consumes the quality build without rebuilding or falling back to dev', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const quality = workflow.split('  quality:\n')[1].split('  browser-tests:\n')[0];
    const browser = workflow.split('  browser-tests:\n')[1].split('  database-foundation:\n')[0];
    assert.equal((workflow.match(/^\s+(?:run: )?npm run build$/gm) ?? []).length, 1);
    assert.ok(quality.includes("node --input-type=module -e 'await import(\"./playwright.config.mjs\")'"));
    assert.ok(quality.includes('browser_build_id: ${{ steps.upload-browser-build.outputs.artifact-id }}'));
    assert.ok(quality.includes("tar --exclude='.next/cache' -czf \"$RUNNER_TEMP/browser-build.tgz\" .next"));
    assert.ok(quality.includes('name: browser-build-${{ github.run_id }}-${{ github.run_attempt }}'));
    assert.ok(quality.includes('retention-days: 1'));
    assert.ok(browser.includes('artifact-ids: ${{ needs.quality.outputs.browser_build_id }}'));
    assert.ok(browser.includes('BUILD_ARTIFACT_ID: ${{ needs.quality.outputs.browser_build_id }}'));
    assert.ok(browser.indexOf('Require the build from this workflow') < browser.indexOf('Download browser build'));
    assert.ok(browser.includes('test -s .next/BUILD_ID'));
    assert.ok(browser.includes('E2E_SERVER_MODE: production'));
    assert.ok(browser.includes('run: npm run test:e2e -- --output=test-results/browser-ci'));
    assert.ok(browser.includes('if: failure()'));
    assert.ok(browser.includes('path: test-results/browser-ci/'));
    assert.doesNotMatch(browser, /npm run (build|dev)/);
    for (const section of [quality, browser]) {
        for (const line of ["E2E_REAL_BACKEND: '0'", "NEXT_PUBLIC_SUPABASE_URL: ''", "NEXT_PUBLIC_SUPABASE_ANON_KEY: ''", "SUPABASE_SERVICE_ROLE_KEY: ''", 'NEXTAUTH_URL: http://127.0.0.1:3000', 'NEXTAUTH_SECRET: local-playwright-secret']) assert.ok(section.includes(line), line);
    }
});

test('conversation search and freshness retain separate workflow checks', () => {
    assert.deepEqual(selected(['src/app/staff/telegram-intake/context/page.tsx']), ['quality', 'telegram-connection', 'telegram-context']);
    const hosted = readFileSync(new URL('../staff-workspace/telegram-hosted.test.js', import.meta.url), 'utf8');
    for (const action of ['View conversation', 'Search messages', 'Import full history']) assert.ok(hosted.includes(action), 'The hosted connection suite covers the import/search journey');
    for (const path of ['src/app/api/staff/telegram-context/route.ts', 'tests/database/telegram-context.test.js', 'tests/staff-workspace/telegram-context.test.js']) assert.deepEqual(selected([path]), ['quality', 'telegram-context']);
    for (const path of ['tests/database/telegram-source-updates-runtime.test.js', 'tests/database/telegram-source-refresh-runtime.test.js', 'tests/database/telegram-native-account-runtime.test.js', 'tests/database/telegram-native-channel-runtime.test.js']) assert.deepEqual(selected([path]), ['quality', 'telegram-source-updates']);
    assert.deepEqual(selected(['tests/telegram-connector/native-sdk.test.js']), ['quality', 'telegram-source-updates']);
    assert.deepEqual(selected(['tests/telegram-connector/hosted-entrypoint.test.js']), ['quality', 'telegram-connection']);
    assert.deepEqual(selected(['tests/evals/telegram-context/harness.test.mjs']), ['quality', 'telegram-extraction']);
    assert.deepEqual(selected(['src/app/staff/candidates/[candidateId]/private-telegram-provenance.tsx']), ['quality', 'telegram-context']);
    assert.ok(selected(['src/app/staff/candidates/[candidateId]/candidate-detail.tsx']).includes('telegram-context'));
    const suites = selected(['src/app/api/telegram-source-updates/worker/complete/route.ts']);
    for (const suite of ['telegram-context','telegram-source-updates','telegram-extraction','telegram-cv','telegram-retention']) assert.ok(suites.includes(suite));
    assert.deepEqual(selected(['supabase/migrations/20261011120000_telegram_context_search.sql']), JOBS);
});
