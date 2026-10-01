import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync(new URL(
    '../../src/app/staff/use-directory-navigation.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;

function setup() {
    const effects = [];
    const events = new Map();
    const timers = new Map();
    const requests = [];
    let nextTimer = 1;
    class Element {
        closest() { return this.anchor ?? this; }
    }
    class Anchor extends Element {
        constructor(href, target = '', attributes = []) {
            super();
            this.href = href;
            this.target = target;
            this.attributes = attributes;
        }
        hasAttribute(name) { return this.attributes.includes(name); }
    }
    const imports = {
        react: {
            useEffect: (effect) => effects.push(effect),
            useRef: (current) => ({ current }),
            useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
            useTransition: () => [false, (fn) => fn()],
        },
        'next/navigation': {
            useRouter: () => ({ replace: (url) => requests.push(url) }),
            useSearchParams: () => new URLSearchParams(),
        },
    };
    const exports = {};
    runInNewContext(source, {
        exports, require: (name) => imports[name], URL, URLSearchParams,
        Element, HTMLAnchorElement: Anchor,
        window: {
            location: new URL('https://example.test/staff/jobs'),
            addEventListener: (name, fn) => events.set(name, fn),
            removeEventListener: (name) => events.delete(name),
        },
        document: {
            addEventListener: (name, fn, capture) => {
                assert.equal(capture, true, 'cancel before Next Link prevents the native event');
                events.set(name, fn);
            },
            removeEventListener: (name) => events.delete(name),
        },
        setTimeout: (fn) => { const id = nextTimer++; timers.set(id, fn); return id; },
        clearTimeout: (id) => timers.delete(id),
    });
    const hook = exports.useDirectoryNavigation('/staff/jobs',
        (params) => ({ query: params.get('q') ?? '' }),
        ({ query }) => query ? new URLSearchParams({ q: query }).toString() : '');
    const cleanup = effects.map((effect) => effect());
    const click = (overrides = {}, href = 'https://example.test/staff/jobs', target = '', attributes = []) => {
        const child = new Element();
        child.anchor = new Anchor(href, target, attributes);
        events.get('click')({ button: 0, target: child, ...overrides });
    };
    const flush = () => { for (const fn of timers.values()) fn(); timers.clear(); };
    return { hook, timers, requests, click, flush, events, cleanup };
}

test('same-section navigation cancels queued search instead of restoring abandoned filters', () => {
    const state = setup();
    state.hook.update({ query: 'abandoned search' }, true);
    state.click();
    state.flush();
    assert.deepEqual(state.requests, []);
    state.hook.update({ query: 'new search' }, true);
    state.flush();
    assert.deepEqual(state.requests, ['/staff/jobs?q=new+search'], 'typing still works after cancellation');
});

test('modified clicks, new tabs and in-page links leave the active search intact', () => {
    const cases = [
        [{ ctrlKey: true }], [{ metaKey: true }], [{ shiftKey: true }], [{ altKey: true }],
        [{ button: 1 }], [{ defaultPrevented: true }],
        [{}, 'https://example.test/staff/jobs', '_blank'],
        [{}, 'https://example.test/staff/jobs', '', ['download']],
        [{}, 'https://example.test/staff/jobs#section'],
        [{}, 'https://external.test/staff/jobs'],
    ];
    for (const args of cases) {
        const state = setup();
        state.hook.update({ query: 'kept' }, true);
        state.click(...args);
        state.flush();
        assert.deepEqual(state.requests, ['/staff/jobs?q=kept'], JSON.stringify(args));
    }
});

test('history navigation and unmount cancel pending debounce', () => {
    for (const action of ['popstate', 'unmount']) {
        const state = setup();
        state.hook.update({ query: 'abandoned' }, true);
        if (action === 'popstate') state.events.get('popstate')();
        else state.cleanup.forEach((cleanup) => cleanup?.());
        state.flush();
        assert.deepEqual(state.requests, []);
    }
});
