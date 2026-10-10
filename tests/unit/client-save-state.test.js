import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as jsxRuntime from 'react/jsx-runtime';
import ts from 'typescript';
import * as contracts from '../../src/lib/client-job-contracts.js';
import { mapClientFieldErrors } from '../../src/lib/client-form-errors.js';
import { createStaffAuthRecovery } from '../../src/lib/staff-auth-recovery.js';

const compile = path => ts.transpileModule(
    readFileSync(new URL(path, import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } },
).outputText;
const formCode = compile('../../src/app/staff/workspace-forms.tsx');
const mutationCode = compile('../../src/lib/staff-mutation.ts');
const id = '97000000-0000-4000-8000-000000000001';
const otherId = '97000000-0000-4000-8000-000000000002';
const turn = () => new Promise(resolve => setImmediate(resolve));
const json = (status, body) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
});
const client = {
    id,
    name: 'Initial',
    contactName: 'Dana Example',
    contactEmail: 'dana@agency-one.example',
    telegramUsername: 'dana_ops',
    website: 'https://agency-one.example',
    socialLinks: [],
    isStealth: false,
    anonymousDescription: null,
    version: '1',
    publicProfileVersion: '1',
    status: 'active',
};

function nodes(value) {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== 'object') return [];
    return [...(value.type ? [value] : []), ...Object.values(value.props ?? {}).flatMap(nodes)];
}

function persistentReact() {
    const hooks = [];
    let cursor = 0;
    const react = {
        useEffect: () => {},
        useRef: initial => {
            const index = cursor++;
            if (!(index in hooks)) hooks[index] = { current: initial };
            return hooks[index];
        },
        useState: initial => {
            const index = cursor++;
            if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
            return [hooks[index], value => {
                hooks[index] = typeof value === 'function' ? value(hooks[index]) : value;
            }];
        },
    };
    return { react, reset: () => { cursor = 0; } };
}

const componentImports = names => Object.fromEntries(names.map(name => [name, name]));

function formSubject(respond, { clientId = id, initial = client, onSaved } = {}) {
    const navigation = [];
    const requests = [];
    const events = [];
    const saved = [];
    const recovery = createStaffAuthRecovery((type, detail) => events.push({ type, detail }));
    const mutation = {};
    runInNewContext(mutationCode, {
        exports: mutation,
        Error,
        Event,
        CustomEvent,
        require: name => {
            assert.equal(name, './staff-auth-recovery');
            return { staffAuthRecovery: recovery };
        },
        fetch: async (url, options) => {
            const body = JSON.parse(options.body);
            requests.push({ url, body });
            return respond(requests.length, body);
        },
        window: { dispatchEvent: event => events.push(event) },
    });
    const hooks = persistentReact();
    const imports = {
        'react/jsx-runtime': jsxRuntime,
        react: hooks.react,
        'next/navigation': { useRouter: () => ({
            push: path => navigation.push(['push', path]),
            refresh: () => navigation.push(['refresh']),
        }) },
        'lucide-react': componentImports(['Plus', 'Trash2']),
        '@/components/staff-ui/button': componentImports(['Button']),
        '@/components/staff-ui/checkbox': componentImports(['Checkbox']),
        '@/components/staff-ui/dialog': componentImports([
            'Dialog', 'DialogContent', 'DialogDescription', 'DialogHeader', 'DialogTitle',
        ]),
        '@/components/staff-ui/input': componentImports(['Input']),
        '@/components/staff-ui/label': componentImports(['Label']),
        '@/components/staff-ui/select': componentImports([
            'Select', 'SelectContent', 'SelectItem', 'SelectTrigger', 'SelectValue',
        ]),
        '@/components/staff-ui/textarea': componentImports(['Textarea']),
        '@/components/staff-preview/rich-text-editor': componentImports(['RichTextEditor']),
        '@/components/staff-preview/shared': componentImports(['RequiredMark']),
        '@/lib/client-job-contracts.js': {
            ...contracts,
            validateClientInput: value => contracts.validateClientInput(
                JSON.parse(JSON.stringify(value))),
        },
        '@/lib/client-form-errors.js': { mapClientFieldErrors },
        '@/lib/staff-mutation': mutation,
    };
    const exports = {};
    runInNewContext(formCode, {
        exports,
        Error,
        crypto: globalThis.crypto,
        require: name => {
            assert.ok(Object.hasOwn(imports, name), name);
            return imports[name];
        },
    });
    let props = {
        ...(clientId ? { clientId } : {}),
        ...(initial ? { initial } : {}),
        onSaved: value => {
            saved.push(value);
            onSaved?.(value);
        },
    };
    const render = (nextProps = props) => {
        props = nextProps;
        hooks.reset();
        return exports.ClientForm(props);
    };
    const input = () => nodes(render()).find(node => node.props.id === 'client-name');
    const changeName = value => {
        input().props.onChange({ target: { value } });
        return render();
    };
    const submit = async () => {
        render().props.onSubmit({ preventDefault() {} });
        await turn();
        await turn();
    };
    return {
        changeName, events, input, navigation, recovery, render, requests, saved, submit,
    };
}

const savedClient = (version, name) => ({
    ...client,
    name,
    version,
    publicProfileVersion: version,
});

const success = snapshot => json(200, {
    ok: true,
    result: {
        id: snapshot.id,
        version: snapshot.version,
        client: snapshot,
    },
});

test('a fresh server snapshot updates a pristine edit form and its expected version', async () => {
    const page = formSubject(() => success(savedClient('3', 'Saved after refresh')));
    page.render();
    page.render({ clientId: id, initial: savedClient('2', 'Updated by another staff member'), onSaved: () => {} });
    assert.equal(page.input().props.value, 'Updated by another staff member');
    await page.submit();
    assert.equal(page.requests[0].body.expectedVersion, '2');
});

test('a refreshed pristine form submits the new concurrency version', async () => {
    const page = formSubject(() => json(409, { error: 'Version conflict' }));
    page.render();
    page.render({ clientId: id, initial: savedClient('2', 'Refreshed'), onSaved: () => {} });
    await page.submit();
    assert.equal(page.requests[0].body.expectedVersion, '2');
});

test('a newer server snapshot preserves a dirty draft and its base until discard', async () => {
    const page = formSubject(index => index === 1
        ? json(409, { error: 'Version conflict' })
        : success(savedClient('3', 'Accepted latest edit')));
    page.changeName('Unsaved local draft');
    page.render({ clientId: id, initial: savedClient('2', 'Other staff edit'), onSaved: () => {} });
    assert.equal(page.input().props.value, 'Unsaved local draft');
    await page.submit();
    assert.equal(page.requests[0].body.expectedVersion, '1');
    assert.equal(page.requests[0].body.fields.name, 'Unsaved local draft');
    const discard = nodes(page.render()).find(node =>
        node.type === 'Button' && node.props.children === 'Discard edits and load latest');
    assert.ok(discard);
    discard.props.onClick();
    assert.equal(page.input().props.value, 'Other staff edit');
    assert.ok(!nodes(page.render()).some(node => node.props.role === 'alert'));
    page.changeName('Edit based on latest');
    await page.submit();
    assert.equal(page.requests[1].body.expectedVersion, '2');
});

test('stale refresh props cannot regress acknowledged fields or the save version', async () => {
    const page = formSubject(() => success(savedClient('3', 'New saved version')));
    page.changeName('Save version three');
    await page.submit();
    page.render({ clientId: id, initial: savedClient('2', 'Stale refresh'), onSaved: () => {} });
    assert.equal(page.input().props.value, 'New saved version');
    await page.submit();
    assert.equal(page.requests[1].body.expectedVersion, '3');
});

test('successful edits adopt canonical fields and advance the next expected version', async () => {
    const snapshots = [
        savedClient('2', 'Canonical saved name'),
        savedClient('3', 'Canonical second name'),
    ];
    const page = formSubject(index => success(snapshots[index - 1]));
    page.changeName('Draft name');
    await page.submit();
    assert.equal(page.saved.length, 1);
    assert.equal(page.saved[0].name, 'Canonical saved name');
    assert.equal(page.input().props.value, 'Canonical saved name');
    assert.deepEqual(page.navigation, []);
    assert.equal(page.events.filter(event => event.type === 'staff-workspace-updated').length, 1);
    page.changeName('Second draft');
    await page.submit();
    assert.equal(page.requests[1].body.expectedVersion, '2');
    assert.equal(page.input().props.value, 'Canonical second name');
});

for (const status of [400, 401, 403, 409, 428, 503]) {
    test(`${status} retains the draft and never saves, navigates, refreshes or replays`, async () => {
        const page = formSubject(() => json(status, { error: 'rejected' }));
        page.changeName('Draft name');
        await page.submit();
        assert.deepEqual(page.saved, []);
        assert.deepEqual(page.navigation, []);
        assert.equal(page.input().props.value, 'Draft name');
        assert.equal(page.requests.length, 1);
        assert.equal(page.requests[0].body.expectedVersion, '1');
        assert.ok(nodes(page.render()).some(node => node.props.role === 'alert'));
        assert.equal(page.recovery.getSnapshot().required, [401, 428].includes(status));
        if ([401, 428].includes(status)) {
            assert.equal(page.recovery.getSnapshot().source, 'save');
            const epoch = page.recovery.beginRetry();
            page.recovery.retryReady(epoch);
            page.recovery.accepted(epoch);
            await turn();
            assert.equal(page.requests.length, 1);
            await page.submit();
            assert.equal(page.requests.length, 2);
            assert.equal(page.requests[1].body.expectedVersion, '1');
        }
    });
}

test('transport failures retain the draft and never save, navigate or retry', async () => {
    const page = formSubject(() => { throw new Error('network unavailable'); });
    page.changeName('Draft name');
    await page.submit();
    assert.deepEqual(page.saved, []);
    assert.deepEqual(page.navigation, []);
    assert.equal(page.input().props.value, 'Draft name');
    assert.equal(page.requests.length, 1);
    assert.equal(page.requests[0].body.expectedVersion, '1');
    assert.match(JSON.stringify(page.render()), /network unavailable/);
});

test('legacy metadata responses refresh once and advance the next expected version', async () => {
    const page = formSubject(() => json(200, {
        ok: true,
        result: { id, version: '2' },
    }));
    page.changeName('Draft name');
    await page.submit();
    assert.deepEqual(page.saved, []);
    assert.deepEqual(page.navigation, [['refresh']]);
    await page.submit();
    assert.equal(page.requests[1].body.expectedVersion, '2');
});

test('client creation still navigates to the returned id without refreshing', async () => {
    const page = formSubject(() => json(200, { ok: true, result: { id } }), {
        clientId: null,
        initial: client,
    });
    await page.submit();
    assert.deepEqual(page.navigation, [['push', `/staff/clients/${id}`]]);
});

function detailSubject(initialClient = client, capabilities = {
    writeClients: true,
    jobs: true,
    writeJobs: true,
    applications: true,
}) {
    const detailCode = compile('../../src/app/staff/clients/[clientId]/client-detail.tsx');
    const hooks = persistentReact();
    const imports = {
        'react/jsx-runtime': jsxRuntime,
        react: hooks.react,
        'next/link': { default: 'Link' },
        'lucide-react': { ArrowLeft: 'ArrowLeft' },
        '@/lib/client-job-contracts': { SOCIAL_PLATFORM_NAMES: contracts.SOCIAL_PLATFORM_NAMES },
        '@/lib/workspace-types': {},
        '@/components/staff-preview/shared': componentImports([
            'FieldLabel', 'PageHeader', 'StatusBadge',
        ]),
        '@/components/staff-ui/button': { Button: 'Button' },
        '@/components/staff-ui/card': componentImports([
            'Card', 'CardContent', 'CardDescription', 'CardHeader', 'CardTitle',
        ]),
        '../../workspace-forms': { ClientForm: 'ClientForm' },
    };
    const exports = {};
    runInNewContext(detailCode, {
        exports,
        require: name => {
            assert.ok(Object.hasOwn(imports, name), name);
            return imports[name];
        },
    });
    let props = { initialClient, capabilities };
    const render = (nextProps = props) => {
        props = nextProps;
        hooks.reset();
        return exports.ClientDetail(props);
    };
    return { render };
}

test('client detail adopts current saves but rejects stale props and callbacks', () => {
    const detail = detailSubject();
    let tree = detail.render();
    let form = nodes(tree).find(node => node.type === 'ClientForm');
    form.props.onSaved(savedClient('3', 'Canonical saved name'));
    tree = detail.render();
    assert.equal(nodes(tree).find(node => node.type === 'PageHeader').props.title,
        'Canonical saved name');

    const stale = savedClient('2', 'Stale server name');
    detail.render({ initialClient: stale, capabilities: {
        writeClients: true, jobs: true, writeJobs: true, applications: true,
    } });
    tree = detail.render();
    assert.equal(nodes(tree).find(node => node.type === 'PageHeader').props.title,
        'Canonical saved name');

    form = nodes(tree).find(node => node.type === 'ClientForm');
    form.props.onSaved(savedClient('2', 'Late stale callback'));
    form.props.onSaved({ ...savedClient('4', 'Other client'), id: otherId });
    tree = detail.render();
    assert.equal(nodes(tree).find(node => node.type === 'PageHeader').props.title,
        'Canonical saved name');

    detail.render({ initialClient: stale, capabilities: {
        writeClients: false, jobs: true, writeJobs: true, applications: true,
    } });
    tree = detail.render();
    assert.ok(!nodes(tree).some(node => node.type === 'ClientForm'));
});
