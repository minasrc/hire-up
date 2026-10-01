import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const compiled = ts.transpileModule(
    readFileSync(new URL('../../src/lib/workspace.server.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

function loaders({ stage = 'verified', fail = false, timing = false } = {}) {
    const calls = [];
    const logs = [];
    const gate = { stage, pool: {}, identity: { subject: 'private-id' }, organizationId: 'private-org' };
    const imports = {
        'server-only': {},
        react: { cache: (read) => read },
        './staff-gate.server': { staffGate: async () => gate },
        './workspace-operations': {
            getStaffCapabilities: async (...args) => {
                calls.push(['capabilities', args]);
                if (fail) throw new Error('private data');
                return { jobs: true };
            },
            getStaffWorkspace: async (...args) => {
                calls.push(['summary', args]);
                if (fail) throw new Error('private data');
                return { metrics: { candidates: 2 } };
            },
        },
    };
    const exports = {};
    runInNewContext(compiled, {
        exports, require: (name) => {
            assert.ok(Object.hasOwn(imports, name), name);
            return imports[name];
        },
        performance: { now: () => 100 },
        process: { env: { STAFF_PERFORMANCE_LOGS: timing ? '1' : undefined } },
        console: { info: (value) => logs.push(value), error: () => {} },
    });
    return { ...exports, gate, calls, logs };
}

test('navigation capabilities load without querying dashboard metrics', async () => {
    const subject = loaders();
    const result = await subject.loadStaffCapabilities();
    assert.equal(result.gate, subject.gate);
    assert.equal(result.capabilities.jobs, true);
    assert.deepEqual(subject.calls, [['capabilities', [subject.gate.pool, subject.gate.identity, 'private-org']]]);
    assert.equal(subject.logs.length, 0);
});

test('unverified stages never query capabilities or workspace records', async () => {
    for (const stage of ['signed-out', 'unresolved', 'resolved', 'mfa-pending']) {
        const subject = loaders({ stage });
        assert.equal((await subject.loadStaffCapabilities()).capabilities, null);
        assert.equal((await subject.loadStaffWorkspace()).summary, null);
        assert.equal(subject.calls.length, 0);
    }
});

test('timings stay opt-in and contain no identity or error details', async () => {
    for (const fail of [false, true]) {
        const subject = loaders({ timing: true, fail });
        await subject.loadStaffCapabilities();
        await subject.loadStaffWorkspace();
        assert.deepEqual(subject.logs.map(JSON.parse), [
            { event: 'staff-read', operation: 'capabilities', durationMs: 0 },
            { event: 'staff-read', operation: 'summary', durationMs: 0 },
        ]);
        assert.ok(subject.logs.every((line) => !line.includes('private')));
    }
});
