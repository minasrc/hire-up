import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { COMMANDS, GROUPS, validateResults } from './ci-groups.mjs';

export function runGroup(group, selection, {
    run = script => spawnSync('npm', ['run', script], { stdio: 'inherit' }),
    now = () => performance.now(),
    report = () => {},
} = {}) {
    const suites = Object.hasOwn(GROUPS, group) ? GROUPS[group] : null;
    if (!suites || suites.some(suite => typeof selection?.[suite] !== 'boolean')) {
        throw new Error('Invalid CI group or selection');
    }
    const chosen = suites.filter(suite => selection[suite]);
    if (!chosen.length) throw new Error('No suites selected for CI group');
    const failures = [];
    for (const suite of chosen) {
        const started = now();
        let success = true;
        for (const script of COMMANDS[suite]) {
            // Keep running other suites after a failure, as the separate jobs did.
            // Within a suite, a failed prerequisite stops its remaining commands.
            const result = run(script);
            if (result.error || result.signal || result.status !== 0) {
                success = false;
                break;
            }
        }
        report({ suite, success, seconds: Math.ceil((now() - started) / 1000) });
        if (!success) failures.push(suite);
    }
    if (failures.length) throw new Error(`Failed CI suites: ${failures.join(', ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    if (process.argv[2] === 'validate') {
        validateResults(JSON.parse(process.env.CI_RESULTS));
        console.log('All selected checks passed.');
    } else {
        runGroup(process.argv[2], JSON.parse(process.env.CI_SELECTION), {
            report: ({ suite, success, seconds }) => {
                const line = `${suite}: ${success ? 'passed' : 'failed'} (${seconds}s)`;
                console.log(line);
                if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${line}\n`);
            },
        });
    }
}
