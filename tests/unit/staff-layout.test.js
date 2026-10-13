import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const { jsx } = jsxRuntime;

const compiled = ts.transpileModule(
    readFileSync(new URL('../../src/app/staff/layout.tsx', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } },
).outputText;

function staffLayout(loadStaffCapabilities) {
    const exports = {};
    const imports = {
        'react/jsx-runtime': jsxRuntime,
        '@/lib/staff-workspace-context.server': { multiWorkspaceEnabled: () => true },
        './workspace-boundary': { WorkspaceBoundary: ({ children }) => jsx('div', { 'data-workspace-boundary': 'true', children }) },
        react: { Suspense: ({ children }) => children },
        './staff-shell-summary': { StaffShellSummarySeed: () => null },
        '@/lib/workspace.server': {
            loadStaffCapabilities,
            loadStaffNotifications: async () => ({
                summary: { capabilities: { jobs: true }, attention: { openTasks: 2 } },
            }),
            loadStaffWorkspace: () => {
                assert.fail('layout must not block on workspace metrics');
            },
        },
        './session-provider': { StaffSessionProvider: ({ children, scope, userId, timeZone, timeZoneVersion, ...rest }) => jsx('div', { 'data-session': 'true', 'data-scope': scope, 'data-user-id': userId, 'data-time-zone': String(timeZone), 'data-time-zone-version': timeZoneVersion, 'data-extra': Object.keys(rest).join(','), children }) },
        './auth-recovery-notice': { AuthRecoveryNotice: () => null },
        './staff-shell': {
            StaffShell: (props) => jsx('div', {
                'data-shell': 'true',
                'data-capabilities': props.initialCapabilities ? 'present' : 'absent',
                'data-stream': Boolean(props.summaryContent),
                'data-user': props.userEmail,
                children: props.children,
            }),
        },
    };
    runInNewContext(compiled, {
        exports,
        require: (name) => {
            assert.ok(Object.hasOwn(imports, name), `Unexpected dependency: ${name}`);
            return imports[name];
        },
    });
    exports.default.seed = async () => {
        const tree = await exports.default({ children: null });
        function findShell(node) {
            if (Array.isArray(node)) return node.map(findShell).find(Boolean);
            if (!node || typeof node !== 'object') return null;
            if (node.props?.summaryContent) return node;
            return findShell(node.props?.children);
        }
        const shell = findShell(tree);
        assert.ok(shell, 'Workspace boundary and session provider must retain the streamed shell seed');
        return shell.props.summaryContent.props.children.type();
    };
    return exports.default;
}

test('unverified stages render bare children inside the staff scope', async () => {
    const Layout = staffLayout(async () => ({
        gate: { stage: 'sign_in' },
        capabilities: null,
    }));
    const html = renderToStaticMarkup(
        await Layout({ children: jsx('p', { children: 'sign-in-here' }) }),
    );
    assert.match(html, /sign-in-here/);
    assert.match(html, /staff-scope/);
    assert.doesNotMatch(html, /data-shell/);
    assert.doesNotMatch(html, /data-session/);
});

test('verified members get the shell with the lightweight capabilities', async () => {
    const Layout = staffLayout(async () => ({
        gate: {
            stage: 'verified',
            organizationId: 'organization-a', principal: {
                user_id: 'user-a', time_zone: 'Europe/Madrid', time_zone_version: '4',
            },
            session: { user: { email: 'staff@example.test' } },
        },
        capabilities: { candidates: true },
    }));
    const html = renderToStaticMarkup(
        await Layout({ children: jsx('p', { children: 'page-body' }) }),
    );
    assert.match(html, /data-shell="true"/);
    assert.match(html, /data-capabilities="present"/);
    assert.match(html, /data-session="true"/);
    assert.match(html, /data-scope="organization-a:user-a"/);
    assert.match(html, /data-workspace-boundary="true"/);
    assert.match(html, /name="staff-workspace-id" content="organization-a"/);
    assert.match(html, /data-user-id="user-a"/);
    assert.match(html, /data-time-zone="Europe\/Madrid"/);
    assert.match(html, /data-time-zone-version="4"/);
    assert.match(html, /data-extra=""/);
    assert.doesNotMatch(html, /credential|secret/);
    assert.match(html, /data-stream="true"/);
    assert.match(html, /data-user="staff@example\.test"/);
    assert.match(html, /page-body/);
});

test('the streamed shell seed uses lightweight notifications', async () => {
    const Layout = staffLayout(async () => ({
        gate: {
            stage: 'verified',
            organizationId: 'organization-a', principal: { user_id: 'user-a' },
            session: { user: { email: 'staff@example.test' } },
        },
        capabilities: { candidates: true },
    }));
    const seed = await Layout.seed();
    assert.equal(seed.props.summary.attention.openTasks, 2);
});

test('a capability outage still renders the shell so pages stay usable', async () => {
    const Layout = staffLayout(async () => ({
        gate: {
            stage: 'verified',
            organizationId: 'organization-a', principal: { user_id: 'user-a' },
            session: { user: { email: 'staff@example.test' } },
        },
        capabilities: null,
    }));
    const html = renderToStaticMarkup(
        await Layout({ children: jsx('p', { children: 'page-body' }) }),
    );
    assert.match(html, /data-shell="true"/);
    assert.match(html, /data-capabilities="absent"/);
});
