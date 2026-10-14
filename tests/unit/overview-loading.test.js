import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as jsxRuntime from 'react/jsx-runtime';
import ts from 'typescript';
const compiled = ts.transpileModule(readFileSync(new URL('../../src/app/staff/page.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
function nodes(value) {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== 'object') return [];
    return [...(value.type ? [value] : []), ...Object.values(value.props ?? {}).flatMap(nodes)];
}
function subject({ capabilities = { tasks: true, writeTasks: true }, summary = { capabilities: { tasks: true, writeTasks: true } }, readSummary, denied = false } = {}) {
    const calls = [];
    const exports = {};
    const imports = {
        'react/jsx-runtime': jsxRuntime,
        react: { Suspense: 'Suspense' },
        'next/link': { default: 'Link', __esModule: true },
        'lucide-react': { ArrowRight: 'ArrowRight', Send: 'Send' },
        '@/lib/telegram-intake-operations': { listTelegramDrafts: async () => ({ drafts: [], counts: { all: 0 } }) },
        '@/lib/pipeline-operations': { listApplicationDirectory: async () => ({ rows: [], total: 0 }) },
        '@/components/staff-ui/card': { Card: 'Card', CardContent: 'CardContent' },
        '@/components/staff-preview/shared': { PageHeader: 'PageHeader' },
        '@/lib/staff-gate.server': { requireStaffVerified: async () => { calls.push('gate'); if (denied) throw new Error('denied'); } },
        '@/lib/workspace.server': {
            loadStaffCapabilities: async () => { calls.push('capabilities'); return { capabilities, gate: { stage: 'verified' } }; },
            loadStaffWorkspace: async () => { calls.push('summary'); return readSummary ? readSummary() : { summary }; },
        },
        './overview-sections': { ClientsHiring: 'ClientsHiring', OverviewMetrics: 'OverviewMetrics', ApplicationReviewTasks: 'ApplicationReviewTasks', overviewReviewLinkClass: '' },
        './staff-todo-list': { StaffTodoList: 'StaffTodoList' },
        './summary-retry': { SummaryRetry: 'SummaryRetry' },
    };
    runInNewContext(compiled, { exports, require: name => { assert.ok(Object.hasOwn(imports, name), name); return imports[name]; } });
    return { calls, render: exports.default };
}
async function sections(page) {
    const tree = await page.render();
    const all = nodes(tree);
    const tasks = all.find(node => node.type.name === 'OverviewTasks');
    assert.ok(tasks, 'tasks must be an independent server component');
    const summary = all.filter(node => node.type.name === 'OverviewSection');
    assert.equal(summary.length, 2);
    const taskBoundary = all.find(node => node.type === 'Suspense' && node.props.children === tasks);
    assert.ok(taskBoundary, 'task rendering must not sit inside a dashboard suspense boundary');
    return { tasks, summary };
}
test('tasks become renderable while the dashboard read is still pending', async () => {
    let release;
    let dashboardSettled = false;
    const pending = new Promise(resolve => { release = resolve; });
    const page = subject({ readSummary: () => pending });
    const { tasks, summary } = await sections(page);
    const reading = summary[0].type(summary[0].props).then(value => { dashboardSettled = true; return value; });
    const task = await tasks.type(tasks.props);
    assert.equal(task.type, 'StaffTodoList');
    assert.equal(task.props.writeEnabled, true);
    assert.equal(dashboardSettled, false);
    release({ summary: { capabilities: { tasks: true } } });
    await reading;
});
test('summary outages do not remove tasks or their controls', async () => {
    const page = subject({ summary: null });
    const { tasks, summary } = await sections(page);
    assert.equal((await tasks.type(tasks.props)).type, 'StaffTodoList');
    for (const section of summary) {
        const result = await section.type(section.props);
        if (section.props.section === 'metrics') assert.match(JSON.stringify(result), /Workspace summary is temporarily unavailable/);
        else assert.equal(result, null);
    }
});
for (const capabilities of [null, { tasks: false, writeTasks: true }]) {
    test(`task capabilities fail closed when ${capabilities === null ? 'unavailable' : 'denied'}`, async () => {
        const page = subject({ capabilities });
        const { tasks } = await sections(page);
        const result = await tasks.type(tasks.props);
        assert.ok(!nodes(result).some(node => node.type === 'StaffTodoList'));
        assert.match(JSON.stringify(result), capabilities === null ? /Task tracking is temporarily unavailable/ : /collaboration.read permission/);
        assert.ok(!page.calls.includes('summary'));
    });
}
test('task read permission does not imply write permission', async () => {
    const page = subject({ capabilities: { tasks: true, writeTasks: false } });
    const { tasks } = await sections(page);
    assert.equal((await tasks.type(tasks.props)).props.writeEnabled, false);
});
test('the verified gate remains mandatory before rendering the overview', async () => {
    const page = subject({ denied: true });
    await assert.rejects(page.render(), /denied/);
    assert.deepEqual(page.calls, ['gate']);
});
