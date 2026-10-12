import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JOBS, selectJobs } from '../../scripts/ci-selection.mjs';
import { COMMANDS, GROUPS, RUNNERS, selectRunners, validateResults } from '../../scripts/ci-groups.mjs';
import { runGroup } from '../../scripts/run-ci-group.mjs';

const selection = enabled => Object.fromEntries(JOBS.map(suite => [suite, enabled.includes(suite)]));
const results = selected => ({ plan: { result: 'success', outputs: { selection: JSON.stringify(selected) } },
    ...Object.fromEntries(Object.keys(RUNNERS).map(runner => [runner, { result: 'success' }])) });

test('grouped runners preserve every suite and existing npm command', () => {
    assert.deepEqual(Object.values(RUNNERS).flat().sort(), [...JOBS].sort());
    assert.equal(new Set(Object.values(RUNNERS).flat()).size, JOBS.length);
    const scripts = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url))).scripts;
    for (const suite of Object.values(GROUPS).flat()) {
        assert.ok(COMMANDS[suite]?.length);
        for (const command of COMMANDS[suite]) assert.ok(scripts[command], `${suite}: ${command}`);
    }
    assert.deepEqual(COMMANDS['staff-workspace'], ['test:staff-workspace', 'test:db:candidate-upload']);
});

test('only selected suites run, in sequence, and every failure reaches the gate', () => {
    const calls = [], reports = [];
    assert.throws(() => runGroup('staff-workflows', selection(['staff-workspace', 'worker-pairing']), {
        run: script => { calls.push(script); return { status: script === 'test:db:candidate-upload' ? 1 : 0 }; },
        report: result => reports.push(result),
    }), /Failed CI suites: staff-workspace/);
    assert.deepEqual(calls, ['test:staff-workspace', 'test:db:candidate-upload', 'test:worker-pairing']);
    assert.deepEqual(reports.map(({suite, success}) => ({suite, success})), [
        { suite: 'staff-workspace', success: false }, { suite: 'worker-pairing', success: true },
    ]);
});

test('failed prerequisite, missing executable or killed command cannot pass a group', () => {
    for (const failure of [{status: 1}, {status: null, signal: 'SIGTERM'}, {error: new Error('missing npm')}]) {
        const calls = [];
        assert.throws(() => runGroup('staff-workflows', selection(['staff-workspace']), {
            run: script => { calls.push(script); return failure; },
        }), /Failed CI suites/);
        assert.deepEqual(calls, ['test:staff-workspace']);
    }
    assert.throws(() => runGroup('unknown', selection([])), /Invalid CI group/);
    assert.throws(() => runGroup('database-checks', {}), /Invalid CI group or selection/);
    assert.throws(() => runGroup('database-checks', selection([])), /No suites selected/);
});

test('aggregate rejects failed, cancelled, skipped or missing selected groups and planning failures', () => {
    const selected = selection(['quality', 'telegram-history']);
    assert.deepEqual(Object.entries(selectRunners(selected)).filter(([,on]) => on).map(([runner]) => runner), ['quality', 'telegram-workflows']);
    for (const state of ['failure', 'cancelled', 'skipped', undefined]) {
        const value = results(selected);
        value['telegram-workflows'] = state ? {result: state} : undefined;
        assert.throws(() => validateResults(value), /Required runner telegram-workflows/);
    }
    const good = results(selected);
    good['search-workflows'].result = 'skipped';
    assert.doesNotThrow(() => validateResults(good));
    good.plan.result = 'failure';
    assert.throws(() => validateResults(good), /CI selection failed/);
    const invalid = results({ ...selected, unknown: true });
    assert.throws(() => validateResults(invalid), /Invalid CI selection/);
    assert.doesNotThrow(() => validateResults(results(selectJobs([]).selection)));
});

test('hourly maintenance retains bounded cleanup and manual execution', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/telegram-maintenance.yml', import.meta.url), 'utf8');
    const runner = readFileSync(new URL('../../.github/workflows/telegram-maintenance-run.yml', import.meta.url), 'utf8');
    assert.ok(workflow.includes("cron: '7 * * * *'"));
    assert.ok(workflow.includes('workflow_dispatch:'));
    assert.ok(workflow.includes('uses: ./.github/workflows/telegram-maintenance-run.yml'));
    assert.ok(runner.includes('timeout-minutes: 5'));
    assert.ok(runner.includes('run: node scripts/run-telegram-maintenance.mjs'));
});
