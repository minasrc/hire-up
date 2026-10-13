import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as jsxRuntime from 'react/jsx-runtime';
import ts from 'typescript';
import * as contracts from '../../src/lib/client-job-contracts.js';
import { mapClientFieldErrors } from '../../src/lib/client-form-errors.js';
import { createStaffAuthRecovery } from '../../src/lib/staff-auth-recovery.js';

const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const formCode = compile('../../src/app/staff/workspace-forms.tsx');
const mutationCode = compile('../../src/lib/staff-mutation.ts');
const id = '97000000-0000-4000-8000-000000000001';
const revisionId = '97000000-0000-4000-8000-000000000002';
const turn = () => new Promise(resolve => setImmediate(resolve));
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function subject(kind, respond) {
    const navigation = [], requests = [], events = [], states = [];
    const recovery = createStaffAuthRecovery((type, detail) => events.push({ type, detail }));
    const mutation = {};
    const request = async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return respond(); };
    runInNewContext(mutationCode, { exports: mutation, Error, Event, CustomEvent,
        require: name => { if (name === '@/lib/staff-workspace-fetch') return { staffWorkspaceFetch: request }; assert.equal(name, './staff-auth-recovery'); return { staffAuthRecovery: recovery }; },
        fetch: request,
        window: { dispatchEvent: event => events.push(event) },
    });
    const components = names => Object.fromEntries(names.map(name => [name, name]));
    const imports = {
        'react/jsx-runtime': jsxRuntime,
        react: { useEffect: () => {}, useRef: current => ({ current }), useState: initial => { const index = states.length; states.push(typeof initial === 'function' ? initial() : initial); return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; } },
        'next/navigation': { useRouter: () => ({ push: path => navigation.push(['push', path]), refresh: () => navigation.push(['refresh']) }) },
        'lucide-react': components(['Plus', 'Trash2']),
        '@/components/staff-ui/button': components(['Button']),
        '@/components/staff-ui/checkbox': components(['Checkbox']),
        '@/components/staff-ui/dialog': components(['Dialog', 'DialogContent', 'DialogDescription', 'DialogHeader', 'DialogTitle']),
        '@/components/staff-ui/input': components(['Input']),
        '@/components/staff-ui/label': components(['Label']),
        '@/components/staff-ui/select': components(['Select', 'SelectContent', 'SelectItem', 'SelectTrigger', 'SelectValue']),
        '@/components/staff-ui/textarea': components(['Textarea']),
        '@/components/staff-preview/rich-text-editor': components(['RichTextEditor']),
        '@/components/staff-preview/shared': components(['RequiredMark']),
        '@/lib/client-job-contracts.js': contracts,
        '@/lib/client-form-errors.js': { mapClientFieldErrors },
        '@/lib/staff-mutation': mutation,
        '@/lib/staff-workspace-fetch': { staffWorkspaceUrl: href => href, refreshStaffWorkspace: router => router.refresh() },
    };
    const exports = {};
    runInNewContext(formCode, { exports, Error,
        FormData: class { constructor(form) { this.form = form; } get(key) { return this.form[key] ?? null; } },
        require: name => { assert.ok(Object.hasOwn(imports, name), name); return imports[name]; },
    });
    const input = { title: 'Unsaved synthetic title', clientId: id, publiclyListed: 'false' };
    const tree = kind === 'revision'
        ? exports.NewRevisionButton({ jobId: id, expectedJobVersion: '7' })
        : exports.JobForm({ clients: [{ id, name: 'Synthetic client' }], ...(kind === 'edit' ? { jobId: id, revisionId, expectedVersion: '7' } : {}) });
    const invoke = () => kind === 'revision'
        ? tree.props.children[0].props.onClick()
        : tree.props.onSubmit({ preventDefault() {}, currentTarget: input });
    const submit = async () => { await invoke(); await turn(); };
    return { submit, navigation, requests, events, states, recovery, input };
}
for (const kind of ['create', 'edit', 'revision']) {
    test(`${kind} waits for commit then navigates once without refreshing`, async () => {
        let resolve;
        const pending = new Promise(done => { resolve = done; });
        const page = subject(kind, () => pending);
        const submitting = page.submit();
        assert.deepEqual(page.navigation, []);
        assert.equal(page.requests.length, 1);
        resolve(json(200, { ok: true, result: { jobId: id, revisionId, version: '8' } }));
        await submitting;
        await turn();
        assert.deepEqual(page.navigation, [['push', `/staff/jobs/${id}${kind === 'revision' ? '/edit' : ''}`]]);
        assert.equal(page.events.filter(event => event.type === 'staff-workspace-updated').length, 1);
        assert.equal(page.requests.length, 1);
        if (kind === 'edit') { assert.equal(page.requests[0].body.expectedVersion, '7'); assert.equal(page.requests[0].body.revisionId, revisionId); }
        if (kind === 'revision') assert.equal(page.requests[0].body.expectedJobVersion, '7');
    });
    for (const status of [400, 401, 403, 409, 428, 503]) {
        test(`${kind} ${status} retains edits and does not navigate, refresh or replay`, async () => {
            const page = subject(kind, () => json(status, { error: 'rejected' }));
            await page.submit();
            assert.deepEqual(page.navigation, []);
            assert.equal(page.requests.length, 1);
            assert.equal(page.input.title, 'Unsaved synthetic title');
            assert.ok(page.states.some(value => typeof value === 'string' && value.length > 0));
            assert.equal(page.events.filter(event => event.type === 'staff-workspace-updated').length, 0);
            assert.equal(page.recovery.getSnapshot().required, [401, 428].includes(status));
            if (page.recovery.getSnapshot().required) {
                assert.equal(page.recovery.getSnapshot().source, 'save');
                const epoch = page.recovery.beginRetry();
                page.recovery.retryReady(epoch);
                page.recovery.accepted(epoch);
                await turn();
                assert.equal(page.requests.length, 1);
                assert.deepEqual(page.navigation, []);
            }
        });
    }
    test(`${kind} transport failure never navigates or retries the write`, async () => {
        const page = subject(kind, () => { throw new Error('network unavailable'); });
        await page.submit();
        assert.deepEqual(page.navigation, []);
        assert.equal(page.requests.length, 1);
        assert.ok(page.states.includes('network unavailable'));
        assert.equal(page.events.filter(event => event.type === 'staff-workspace-updated').length, 0);
    });
}
