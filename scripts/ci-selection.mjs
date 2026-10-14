import { appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectRunners } from './ci-groups.mjs';

export const JOBS = [
    'quality', 'browser-tests', 'database-foundation', 'database-staff-authorization',
    'database-privacy-foundation', 'database-privacy-operations', 'database-client-jobs',
    'staff-workspace', 'duplicate-review', 'database-staff-totp', 'telegram-intake',
    'telegram-connection', 'telegram-history', 'telegram-context', 'telegram-source-updates', 'telegram-extraction', 'telegram-cv',
    'profile-search', 'telegram-retention', 'cv-analysis', 'cv-search', 'worker-pairing',
];
const STAFF = JOBS.filter((job) => !['quality', 'database-foundation'].includes(job));
const STAFF_BROWSER = STAFF.filter((job) => !job.startsWith('database-'));
const TELEGRAM = JOBS.filter((job) => job.startsWith('telegram-'));
const all = () => ({ selection: Object.fromEntries(JOBS.map((job) => [job, true])), appChecks: true });
// A reviewed function-only migration can use its owning workflow suite, which
// applies this migration and checks its permissions, lifecycle and audit rules.
// Pin its contents: editing or deleting it must restore full schema coverage.
const SCOPED_MIGRATIONS = {
    'supabase/migrations/20261014160000_telegram_cv_recovery.sql': {
        sha256: '43f31df519076f80bbc73ce2117582ebe047232ce13ef566f257c62f5b6915f2',
        jobs: ['cv-analysis', 'telegram-cv', 'telegram-extraction', 'telegram-intake'],
    },
    'supabase/migrations/20261009090000_document_preview_versions.sql': {
        sha256: 'b4651b4fab822ef00bd063035cb8d437a2a759fc5b91b65b1127514da1d87577',
        jobs: ['staff-workspace'],
    },
};
// Reviewed presentation-only controls: keep representative keyboard, mobile,
// read-only and navigation coverage. Changed contents fall back to all staff
// browser workflows; these exceptions never scope server security or packages.
const SCOPED_UI_CONTROLS = {
    'src/components/staff-ui/select.tsx': { sha256: '5ed67b90ecb0e33feb8d18c62ec59c602b7c2a585aa0764d2900ca51522e8e19', jobs: ['browser-tests', 'staff-workspace'] },
    'src/components/staff-ui/discard-confirmation.tsx': { sha256: '6d6b5fcd3391f47ee31e15503ea68e79854a892d15ef326bab4ab1bf93214ad7', jobs: ['browser-tests', 'staff-workspace'] },
};
const readRepoFile = (file) => readFileSync(new URL(`../${file}`, import.meta.url));

// Unknown paths and shared security/schema changes deliberately fail closed.
// Expand this map only with evidence of the affected suites' dependencies.
export function selectJobs(files, full = false, readFile = readRepoFile) {
    if (full || files === null) return all();
    const selected = new Set();
    let appChecks = false;
    for (const file of files) {
        if (/\.md$/i.test(file)) continue;
        selected.add('quality');
        if (file === '.github/workflows/ci.yml' || /^\.github\/workflows\/telegram-maintenance(?:-manual|-run)?\.yml$/.test(file)
            || ['scripts/ci-selection.mjs', 'scripts/ci-groups.mjs', 'scripts/run-ci-group.mjs',
                'scripts/run-telegram-maintenance.mjs'].includes(file)
            || file.startsWith('tests/unit/')) continue;
        appChecks = true;
        let jobs;
        if (file.startsWith('supabase/')) {
            const reviewed = SCOPED_MIGRATIONS[file];
            if (!reviewed) return all();
            try {
                if (createHash('sha256').update(readFile(file)).digest('hex') !== reviewed.sha256) return all();
            } catch { return all(); }
            jobs = reviewed.jobs;
        } else if (Object.hasOwn(SCOPED_UI_CONTROLS, file)) {
            const reviewed = SCOPED_UI_CONTROLS[file];
            try {
                jobs = createHash('sha256').update(readFile(file)).digest('hex') === reviewed.sha256
                    ? reviewed.jobs : STAFF_BROWSER;
            } catch { jobs = STAFF_BROWSER; }
        } else if (['src/app/staff/job-form.tsx', 'src/app/staff/form-guard.tsx',
            'src/lib/job-form-ui.js', 'src/lib/editor-job-document.js',
            'src/components/staff-preview/cancel-job-button.tsx',
            'src/components/staff-preview/job-compensation.tsx',
            'src/components/staff-preview/job-editor-layout.tsx',
            'src/components/staff-preview/job-form-select.tsx',
            'src/components/staff-preview/read-job-editor.ts',
            'src/components/staff-preview/job-document.tsx',
            'src/components/staff-preview/rich-text-editor.tsx'].includes(file)) {
            // Draft editing plus both authenticated and public job descriptions.
            jobs = ['browser-tests', 'staff-workspace'];
        } else if (file === 'src/lib/staff-auth-recovery.js' || file === 'src/lib/staff-mutation.ts') {
            // Shared client recovery/mutation UI, with no server auth or SQL changes.
            jobs = STAFF_BROWSER;
        } else if (/^tests\/support\//.test(file)
            || /^(package(?:-lock)?\.json|\.nvmrc|next\.config\.mjs|tsconfig\.json)$/.test(file)) return all();
        else if (/^src\/app\/api\/staff\/documents\//.test(file)
            || file === 'src/lib/staff-document-preview-cache.js'
            || /^src\/components\/staff-preview\/(document-preview-provider|pdf-document-preview|real-candidate-documents)\.tsx$/.test(file)) jobs = ['staff-workspace'];
        else if (/^src\/app\/staff\/(applications|clients|jobs)\//.test(file)) jobs = ['staff-workspace'];
        else if (['src/app/staff/page.tsx', 'src/app/staff/overview-sections.tsx',
            'src/app/staff/workspace-forms.tsx'].includes(file)) jobs = ['browser-tests', 'staff-workspace'];
        else if (/^src\/app\/staff\/candidates\/search\//.test(file)) jobs = ['profile-search', 'cv-search'];
        else if (/^src\/app\/staff\/candidates\/duplicates\//.test(file)) jobs = ['duplicate-review'];
        else if (['src/app/staff/candidates/[candidateId]/private-telegram-provenance.tsx', 'src/app/staff/candidates/[candidateId]/telegram-provenance-model.ts'].includes(file)) jobs = ['telegram-context'];
        else if (['src/app/staff/candidates/[candidateId]/candidate-detail.tsx', 'src/app/staff/candidates/[candidateId]/page.tsx'].includes(file)) jobs = ['staff-workspace', 'duplicate-review', 'profile-search', 'cv-analysis', 'telegram-context'];
        else if (/^src\/app\/staff\/candidates\//.test(file)) jobs = ['staff-workspace', 'duplicate-review', 'profile-search', 'cv-analysis'];
        else if (/^src\/app\/staff\/telegram-intake\/connect\//.test(file)) jobs = ['telegram-connection', 'worker-pairing'];
        else if (file === 'tests/telegram-connector/native-sdk.test.js') jobs = ['telegram-source-updates'];
        else if (file === 'tests/telegram-connector/hosted-entrypoint.test.js') jobs = ['telegram-connection'];
        else if (/^tests\/evals\/telegram-context\//.test(file)) jobs = ['telegram-extraction'];
        // Hosted supervision affects Telegram and shared processing, not job/client UI.
        else if (/^services\/telegram-hosted\//.test(file)) jobs = [...TELEGRAM, 'profile-search', 'cv-analysis', 'cv-search', 'worker-pairing'];
        else if (file === 'services/telegram-extraction-worker/provider.mjs') jobs = ['telegram-extraction', 'telegram-intake'];
        else if (file === 'src/app/staff/telegram-intake/processing-status.tsx') jobs = ['telegram-intake', 'telegram-history', 'profile-search'];
        else if (/^src\/app\/staff\/telegram-intake\/context\//.test(file)) jobs = ['telegram-context', 'telegram-connection'];
        else if (/^src\/app\/staff\/telegram-intake\/chats\//.test(file)) jobs = ['telegram-history', 'telegram-source-updates', 'telegram-connection'];
        else if (/^src\/app\/staff\/telegram-intake\/cv\//.test(file)) jobs = ['telegram-cv', 'cv-analysis'];
        else if (/^src\/app\/staff\/telegram-intake\/cv-analysis\//.test(file)) jobs = ['cv-analysis', 'cv-search'];
        else if (/^src\/app\/staff\/telegram-intake\/extraction\//.test(file)) jobs = ['telegram-extraction', 'telegram-retention', 'telegram-cv', 'cv-analysis'];
        else if (/^src\/app\/staff\/telegram-intake\//.test(file)) jobs = [...TELEGRAM, 'profile-search', 'cv-analysis', 'cv-search', 'worker-pairing'];
        else if (/^src\/app\/api\/(?:staff\/)?telegram-context(?:\/|$)/.test(file)) jobs = ['telegram-context'];
        else if (/^src\/app\/api\/(?:staff\/)?telegram-source-updates(?:\/|$)/.test(file)) jobs = ['telegram-context', 'telegram-source-updates', 'telegram-extraction', 'telegram-cv', 'telegram-retention'];
        else if (/^src\/app\/api\/(?:staff\/)?telegram-history\//.test(file)) jobs = ['telegram-history', 'telegram-context', 'telegram-source-updates', 'telegram-extraction', 'telegram-cv', 'telegram-retention', 'cv-analysis'];
        else if (/^src\/app\/api\/(?:staff\/)?telegram-connection\//.test(file)) jobs = ['telegram-connection', 'telegram-history', 'telegram-context', 'telegram-source-updates', 'telegram-extraction', 'telegram-cv', 'telegram-retention', 'cv-analysis', 'worker-pairing'];
        else if (/^src\/app\/api\/(?:staff\/)?telegram-extraction\//.test(file)) jobs = ['telegram-extraction', 'telegram-cv', 'telegram-retention', 'cv-analysis'];
        else if (/^src\/app\/api\/(?:staff\/)?telegram-cv\//.test(file)) jobs = ['telegram-cv', 'cv-analysis'];
        else if (/^src\/app\/api\/(?:staff\/)?cv-analysis\//.test(file)) jobs = ['cv-analysis', 'cv-search', 'telegram-cv'];
        else if (/^src\/app\/api\/(?:staff\/)?profile-search\//.test(file)) jobs = ['profile-search', 'cv-search'];
        else if (/^src\/app\/api\/staff\//.test(file)) jobs = STAFF;
        else if (/^(src\/app\/staff\/|src\/components\/staff)/.test(file)) jobs = STAFF_BROWSER;
        else if (/^src\/lib\/(staff-|auth-options|totp|workspace|pipeline-|candidate-|client-job-|privacy-|duplicate-review|worker-pairing)/.test(file)) jobs = STAFF;
        else if (/^src\/lib\/telegram-/.test(file)) jobs = [...STAFF];
        else if (/^(src\/lib\/(profile-search|cv-analysis)|services\/(semantic-worker|local-embeddings|cv-analysis-worker))/.test(file)) jobs = ['profile-search', 'cv-search', 'cv-analysis', 'worker-pairing'];
        else if (/^services\/(telegram-|worker-pairing|mac-worker)/.test(file)) jobs = STAFF;
        else if (/^tests\/(database|staff-workspace)\//.test(file)) jobs = testJobs(file);
        else if (/^(tests\/e2e\/|playwright\.config\.mjs|public\/)/.test(file)) jobs = ['browser-tests'];
        // Shared app entry points and components can affect every browser suite.
        else if (/^(src\/app\/(layout\.|globals\.)|src\/components\/)/.test(file)) jobs = STAFF_BROWSER;
        else if (/^src\/app\/(?!api\/|staff\/)/.test(file)) jobs = ['browser-tests'];
        else return all();
        if (!jobs) return all();
        for (const job of jobs) selected.add(job);
    }
    return { selection: Object.fromEntries(JOBS.map((job) => [job, selected.has(job)])), appChecks };
}

function testJobs(file) {
    const name = file.split('/').at(-1);
    const mapping = [
        [/^foundation\./, ['database-foundation']],
        [/^staff-authorization\./, ['database-staff-authorization']],
        [/^staff-totp\./, ['database-staff-totp']],
        [/^privacy-foundation\./, ['database-privacy-foundation']],
        [/^privacy-operations\./, ['database-privacy-operations']],
        [/^client-job-workflows\./, ['database-client-jobs']],
        [/^(staff-workspace|staff-list-pagination|candidate-profiles|candidate-upload|workspace|record-preview)\./, ['staff-workspace']],
        [/^(candidate-merge|duplicate-review)\./, ['duplicate-review']],
        [/^telegram-(?:intake|candidate-review)\./, ['telegram-intake']],
        [/^telegram-(?:connection|hosted(?:-wake)?)\./, ['telegram-connection']],
        [/^telegram-(?:history|chat-order)/, ['telegram-history']],
        [/^telegram-(?:context|candidate-context)/, ['telegram-context']],
        [/^telegram-(?:source-(?:updates|refresh)|native-(?:account|channel))/, ['telegram-source-updates']],
        [/^telegram-extraction/, ['telegram-extraction']],
        [/^telegram-cv/, ['telegram-cv']],
        [/^telegram-(retention|sync)/, ['telegram-retention', 'telegram-history']],
        [/^(profile-search|telegram-candidate-flow)/, ['profile-search']],
        [/^cv-analysis/, ['cv-analysis']],
        [/^cv-search/, ['cv-search']],
        [/^worker-pairing/, ['worker-pairing']],
    ];
    return mapping.find(([pattern]) => pattern.test(name))?.[1];
}

export function reusableRun(runs, head, repository) {
    const latest = runs.filter((run) => run.head_sha === head
        && run.event === 'pull_request' && run.head_repository?.full_name === repository)
        .sort((a, b) => b.id - a.id)[0];
    return latest?.status === 'completed' && latest.conclusion === 'success' ? latest : null;
}

const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
export async function planEvent({ eventName, event, repository, git, runs }) {
    if (eventName === 'workflow_dispatch') return { ...all(), reason: 'Manual full validation' };
    if (eventName === 'push' && sha(event.after)) {
        // Reuse only a successful run for the exact same tree, never merely a
        // commit associated with a PR. Direct pushes or changed merge results
        // still get tests. API errors fall back to normal change selection.
        const parents = git(['show', '-s', '--format=%P', event.after]).trim().split(' ');
        if (parents.length === 2 && parents.every(sha)
            && git(['rev-parse', `${event.after}^{tree}`]).trim()
                === git(['rev-parse', `${parents[1]}^{tree}`]).trim()) {
            try {
                const run = reusableRun(await runs(parents[1]), parents[1], repository);
                if (run) return { ...selectJobs([]), reason: `Reused successful PR CI run ${run.id}; identical merge tree` };
            } catch { /* No trusted proof: run the affected checks. */ }
        }
    }
    let base;
    let head;
    let range;
    if (eventName === 'pull_request') {
        base = event.pull_request?.base?.sha;
        head = event.pull_request?.head?.sha;
        range = '...';
    } else if (eventName === 'push') {
        base = event.before;
        head = event.after;
        range = '..';
    }
    if (!sha(base) || !sha(head) || /^0+$/.test(base)) return { ...all(), reason: 'Unknown change range; full validation' };
    const files = git(['diff', '--name-only', '--no-renames', '-z', `${base}${range}${head}`]).split('\0').filter(Boolean);
    return { ...selectJobs(files), reason: `Selected checks for ${files.length} changed files`, files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    let plan;
    try {
        const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
        const repository = process.env.GITHUB_REPOSITORY;
        if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository');
        plan = await planEvent({ eventName: process.env.GITHUB_EVENT_NAME, event, repository,
            git: (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }),
            runs: async (head) => JSON.parse(execFileSync('gh', ['api',
                `repos/${repository}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${head}&per_page=100`],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).workflow_runs,
        });
    } catch {
        plan = { ...all(), reason: 'Selection failed; full validation' };
    }
    appendFileSync(process.env.GITHUB_OUTPUT,
        `selection=${JSON.stringify(plan.selection)}\nrunners=${JSON.stringify(selectRunners(plan.selection))}\napp_checks=${plan.appChecks}\n`);
    console.log(JSON.stringify(plan, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `### CI selection\n${plan.reason}\n\nJobs: ${JOBS.filter((job) => plan.selection[job]).join(', ') || 'none (no unvalidated code changes)'}\n`);
}
