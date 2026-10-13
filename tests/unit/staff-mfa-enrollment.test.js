import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { createRequire } from 'node:module';
import { mfaEnrollmentLabel } from '../../src/lib/staff-mfa-label.js';

const require = createRequire(import.meta.url);
const serviceSource = readFileSync(new URL('../../src/lib/staff-mfa.server.js', import.meta.url), 'utf8')
    .replace(/^import .*;$/gm, '').replaceAll('export ', '');
function service(row = { credential_id: 'stored-id', status: 'pending', secret: 'STORED-SECRET' }) {
    const queries = [];
    let transactions = 0;
    const context = vm.createContext({
        generateTotpSecret: () => 'UNUSED-CANDIDATE',
        withStaffActor: async (pool, identity, org, operation) => {
            transactions++;
            return operation({ auditId: 'audit', correlationId: 'correlation', client: {
                query: async (sql, params) => {
                    queries.push({ sql, params });
                    return { rows: sql.includes('totp_enroll') ? [{ credential_id: 'stored-id' }] : row ? [row] : [] };
                },
            } });
        },
    });
    vm.runInContext(serviceSource, context);
    return { enroll: () => context.enrollTotp({}, {}, 'org'), queries, transactions: () => transactions };
}
test('enrollment returns the persisted secret using the same transaction as setup', async () => {
    const s = service();
    const result = await s.enroll();
    assert.equal(result.secret, 'STORED-SECRET');
    assert.equal(result.credentialId, 'stored-id');
    assert.equal(result.status, 'pending');
    assert.equal(s.transactions(), 1);
    assert.equal(s.queries.length, 2);
    assert.equal(s.queries[0].params[0], 'UNUSED-CANDIDATE');
    assert.match(s.queries[1].sql, /totp_status_v1/);
});
test('an already-active credential is returned without displaying a new candidate', async () => {
    const s = service({ credential_id: 'stored-id', status: 'active', secret: 'ACTIVE' });
    assert.equal((await s.enroll()).status, 'active');
});
test('missing or mismatched persisted credentials fail closed', async () => {
    for (const row of [null, { credential_id: 'wrong', secret: 'WRONG' }]) {
        await assert.rejects(service(row).enroll(), /could not be read/);
    }
});

const pageSource = ts.transpileModule(readFileSync(new URL('../../src/app/staff/mfa/enroll/page.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
function page(gate, enrollment, multiWorkspace = false) {
    const calls = [];
    const labels = [];
    const exports = {};
    const modules = {
        'react/jsx-runtime': require('react/jsx-runtime'),
        'next/navigation': { redirect: (url) => { throw Object.assign(new Error('redirect'), { url }); } },
        qrcode: { default: { toDataURL: async (uri) => { calls.push({ qr: uri }); return 'qr'; } } },
        '@/lib/staff-gate.server': { staffGate: async () => gate },
        '@/lib/staff-workspace-context.server': { multiWorkspaceEnabled: () => multiWorkspace },
        '@/lib/staff-mfa-label': { mfaEnrollmentLabel },
        '@/lib/staff-mfa.server': { enrollTotp: async () => { calls.push('enroll'); return enrollment; } },
        '@/lib/totp': { totpUri: ({ secret, accountName }) => { calls.push({ secret }); labels.push(accountName); return 'uri'; } },
        '../mfa-forms': { MfaEnrollForm: () => null },
    };
    vm.runInNewContext(pageSource, { exports, require: (name) => { assert.ok(modules[name], name); return modules[name]; } });
    return { render: exports.default, calls, labels };
}
const gate = { stage: 'resolved', pool: {}, identity: { subject: '123' }, organizationId: 'org', session: { user: { email: 'synthetic@example.test' } } };
test('a stale setup page redirects if another tab completed enrollment', async () => {
    const p = page(gate, { status: 'active', secret: 'DO-NOT-DISPLAY' });
    await assert.rejects(p.render(), { url: '/staff' });
    assert.deepEqual(p.calls, ['enroll']);
});
test('setup refresh rechecks pending state and renders the stored secret', async () => {
    const p = page({ ...gate, totp: { status: 'pending', secret: 'CACHED' } }, { status: 'pending', secret: 'STORED' });
    await p.render();
    assert.deepEqual(p.calls, ['enroll', { secret: 'STORED' }, { qr: 'uri' }]);
});
test('an active credential at the initial gate skips enrollment and QR generation', async () => {
    const p = page({ ...gate, totp: { status: 'active' } }, null);
    await assert.rejects(p.render(), { url: '/staff' });
    assert.deepEqual(p.calls, []);
});

test('multi-workspace setup qualifies the provisioning label but uses the stored pending secret', async () => {
    const p = page({ ...gate, principal: { workspace_name: 'Independent workspace' } }, { status: 'pending', secret: 'STORED' }, true);
    await p.render();
    assert.deepEqual(p.labels, ['synthetic@example.test (Independent workspace)']);
    assert.deepEqual(p.calls, ['enroll', { secret: 'STORED' }, { qr: 'uri' }]);
});
