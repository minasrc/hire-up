import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { expect, test } from '@playwright/test';
import ts from 'typescript';
import { staffWorkspaceClientSource } from '../support/staff-workspace-client-source.js';

const require = createRequire(import.meta.url);
const reactScripts = ['react', 'react-dom'].map(name => readFileSync(
    join(dirname(require.resolve(name)), `umd/${name}.development.js`), 'utf8',
));
const compile = path => ts.transpileModule(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 },
}).outputText;
const sources = {
    workspace: staffWorkspaceClientSource,
    dates: compile('src/lib/staff-dates.js'),
    auth: compile('src/lib/staff-auth-recovery.js'),
    model: compile('src/app/staff/time-zone-model.ts'),
    provider: compile('src/app/staff/time-zone-provider.tsx'),
    settings: compile('src/app/staff/time-zone-settings.tsx'),
    date: compile('src/app/staff/staff-date.tsx'),
};

function loadComponents(React, source, refresh) {
    const tag = name => {
        const Component = React.forwardRef((props, ref) => {
            const attributes = { ...props };
            const children = attributes.children;
            delete attributes.children;
            delete attributes.variant;
            delete attributes.size;
            delete attributes.asChild;
            return React.createElement(name, { ...attributes, ref }, ...(name === 'input' ? [] : [children]));
        });
        Component.displayName = `Test${name}`;
        return Component;
    };
    const modules = {
        react: React,
        'next/navigation': { useRouter: () => ({ refresh }) },
        '@/components/staff-ui/button': { Button: tag('button') },
        '@/components/staff-ui/input': { Input: tag('input') },
        '@/components/staff-ui/label': { Label: tag('label') },
        '@/components/staff-ui/card': { Card: tag('section'), CardHeader: tag('header'), CardContent: tag('div'), CardTitle: tag('h2') },
    };
    const require = name => {
        if (!Object.hasOwn(modules, name)) throw new Error(`Unexpected fixture dependency: ${name}`);
        return modules[name];
    };
    const load = name => {
        const exports = {};
        new Function('exports', 'require', 'React', source[name])(exports, require, React);
        return exports;
    };
    modules['@/lib/staff-workspace-fetch'] = load('workspace');
    modules['@/lib/staff-dates'] = modules['../../lib/staff-dates.js'] = load('dates');
    modules['@/lib/staff-auth-recovery'] = load('auth');
    modules['./time-zone-model'] = load('model');
    modules['./time-zone-provider'] = load('provider');
    return { ...modules['./time-zone-provider'], ...load('settings'), ...load('date') };
}

function application(React, components, config, interactive) {
    const h = React.createElement;
    function Dates() {
        React.useEffect(() => { if (interactive) window.__tzDatesHydrated = true; }, []);
        return h('section', { 'aria-label': 'Date consistency fixture' },
            h('p', { id: 'preview-date' }, h(components.StaffDate, { value: '2026-09-30T23:30:00Z' })),
            h('p', { id: 'detail-date' }, h(components.StaffDate, { value: '2026-09-30T23:30:00Z' })),
            h('p', { id: 'calendar-date' }, h(components.StaffDate, { value: '2026-10-10', kind: 'calendar' })),
        );
    }
    function Ready() {
        React.useEffect(() => { if (interactive) window.__tzHydrated = true; }, []);
        return null;
    }
    const DateView = interactive && config.late
        ? React.lazy(() => new Promise(resolve => {
            window.__releaseTZDates = () => resolve({ default: Dates });
        }))
        : Dates;
    return h(React.StrictMode, null, h(components.StaffTimeZoneProvider, {
        accountId: config.accountId, savedTimeZone: config.savedTimeZone, version: config.version,
    },
    h(components.StaffTimeZoneBanner),
    h(components.TimeZoneSettings),
    h(Ready),
    h(React.Suspense, { fallback: h('p', null, 'Loading date fixture…') }, h(DateView))));
}

async function mount(page, options = {}) {
    const config = { accountId: 'account-a', savedTimeZone: 'Europe/Madrid', version: '1', late: false, ...options };
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setTimezoneOverride', { timezoneId: options.deviceZone ?? 'America/New_York' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.addInitScript(() => {
        window.__tzDetections = 0;
        const Original = Intl.DateTimeFormat;
        function Instrumented(...args) {
            if (args.length === 0) window.__tzDetections++;
            return new Original(...args);
        }
        Object.setPrototypeOf(Instrumented, Original);
        Instrumented.prototype = Original.prototype;
        Intl.DateTimeFormat = Instrumented;
    });
    const posts = [];
    const state = { status: 200, hold: false, release: null, config };
    const serverComponents = loadComponents(React, sources, () => { throw new Error('SSR must not refresh'); });
    const html = () => `<html><head><style>body{font:14px system-ui;margin:0;padding:16px;box-sizing:border-box}*{box-sizing:border-box}aside{display:flex;flex-wrap:wrap;gap:12px;margin:0 0 20px;padding:12px;border:1px solid #aaa}aside p{min-width:0;flex:1 1 220px;overflow-wrap:anywhere}input{display:block;max-width:100%;width:300px;margin:8px 0}button{padding:8px;margin:3px}section{max-width:100%}</style></head><body><div id="root">${renderToString(application(React, serverComponents, state.config, false))}</div></body></html>`;
    await page.route('**/*', async route => {
        if (new URL(route.request().url()).pathname !== '/api/staff/preferences/time-zone') {
            return route.fulfill({ contentType: 'text/html', body: html() });
        }
        const body = route.request().postDataJSON();
        const account = route.request().headers()['x-staff-account-id'];
        posts.push({ body, account });
        const savingAccount = state.config.accountId;
        if (state.hold) await new Promise(resolve => { state.release = resolve; });
        const result = { timeZone: body.timeZone, version: String(BigInt(body.expectedVersion) + 1n) };
        if (state.status === 200 && state.config.accountId === savingAccount) {
            state.config = { ...state.config, savedTimeZone: result.timeZone, version: result.version };
        }
        await route.fulfill({ status: state.status, json: state.status === 200 ? { ok: true, result } : { error: 'unavailable' } }).catch(error => {
            if (!state.hold) throw error;
        });
    });
    const hydrate = async () => {
        for (const content of reactScripts) await page.addScriptTag({ content });
        await page.addScriptTag({ content: `
            window.__tzRefreshes = 0;
            const components = (${loadComponents.toString()})(React, ${JSON.stringify(sources)}, () => { window.__tzRefreshes++; });
            const app = ${application.toString()};
            const root = ReactDOM.hydrateRoot(document.getElementById('root'), app(React, components, ${JSON.stringify(state.config)}, true));
            window.__setTZConfig = config => root.render(app(React, components, config, true));
        ` });
        await page.waitForFunction(() => window.__tzHydrated === true);
    };
    await page.goto('http://127.0.0.1:3000/__staff-time-zone-test');
    const beforeHydration = await page.locator('#preview-date').textContent();
    await hydrate();
    return {
        state, posts, errors, beforeHydration,
        banner: page.getByRole('complementary', { name: 'Time zone preference' }),
        reload: async () => { await page.reload(); await hydrate(); },
        travel: async timeZone => {
            await session.send('Emulation.setTimezoneOverride', { timezoneId: timeZone });
            await page.evaluate(() => {
                Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
                document.dispatchEvent(new Event('visibilitychange'));
            });
        },
        account: async next => {
            state.config = { ...state.config, ...next, late: false };
            await page.evaluate(config => window.__setTZConfig(config), state.config);
        },
    };
}

async function dates(page, expected) {
    await expect(page.locator('#preview-date')).toHaveText(expected);
    await expect(page.locator('#detail-date')).toHaveText(expected);
    await expect(page.locator('#calendar-date')).toHaveText('10 Oct 2026');
}
const refreshes = page => page.evaluate(() => window.__tzRefreshes);

test('saved zone hydrates without changing dates until one explicit acceptance', async ({ page }) => {
    const ui = await mount(page);
    expect(ui.beforeHydration).toBe('1 Oct 2026');
    await dates(page, '1 Oct 2026');
    await expect(ui.banner).toContainText('Use America/New_York instead of Europe/Madrid?');
    expect(ui.posts).toHaveLength(0);
    await ui.banner.getByRole('button', { name: 'Switch', exact: true }).evaluate(button => { button.click(); button.click(); });
    await dates(page, '30 Sept 2026');
    await expect.poll(() => refreshes(page)).toBe(1);
    expect(ui.posts).toEqual([{ body: { timeZone: 'America/New_York', expectedVersion: '1' }, account: 'account-a' }]);
    expect(ui.errors).toEqual([]);
});

test('an unset preference stays UTC after hydration until the device zone is accepted', async ({ page }, testInfo) => {
    const ui = await mount(page, { savedTimeZone: null, version: '0', deviceZone: 'Asia/Tokyo' });
    expect(ui.beforeHydration).toBe('30 Sept 2026');
    await dates(page, '30 Sept 2026');
    await expect(ui.banner).toContainText('Use Asia/Tokyo?');
    expect(ui.posts).toHaveLength(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath('time-zone-banner.png') });
    await ui.banner.getByRole('button', { name: 'Switch', exact: true }).click();
    await dates(page, '1 Oct 2026');
    await expect.poll(() => refreshes(page)).toBe(1);
    expect(ui.posts).toHaveLength(1);
    expect(ui.errors).toEqual([]);
});

test('keeping a zone persists dismissal and a later travel zone can prompt again', async ({ page }) => {
    const ui = await mount(page);
    await ui.banner.getByRole('button', { name: 'Keep current' }).click();
    await expect(ui.banner).toHaveCount(0);
    expect(ui.posts).toHaveLength(0);
    await ui.reload();
    await expect(ui.banner).toHaveCount(0);
    await dates(page, '1 Oct 2026');
    const before = await page.evaluate(() => window.__tzDetections);
    await ui.travel('America/New_York');
    expect(await page.evaluate(() => window.__tzDetections)).toBe(before);
    await page.clock.install({ time: await page.evaluate(() => Date.now()) });
    await page.clock.runFor(60_001);
    await ui.travel('Asia/Tokyo');
    await expect(ui.banner).toContainText('Asia/Tokyo');
    await expect(page.getByText('Dates are shown in Europe/Madrid.', { exact: true })).toBeVisible();
    expect(ui.posts).toHaveLength(0);
    expect(ui.errors).toEqual([]);
});

test('equivalent IANA aliases do not trigger a travel prompt', async ({ page }) => {
    const ui = await mount(page, { savedTimeZone: 'US/Eastern', deviceZone: 'America/New_York' });
    await dates(page, '30 Sept 2026');
    await expect(ui.banner).toHaveCount(0);
    expect(ui.posts).toHaveLength(0);
    expect(ui.errors).toEqual([]);
});

test('failed saves retain the saved zone and retry only after another acceptance', async ({ page }) => {
    const ui = await mount(page);
    ui.state.status = 503;
    await ui.banner.getByRole('button', { name: 'Switch', exact: true }).click();
    await expect(ui.banner.getByRole('alert')).toContainText('current zone has not changed');
    await dates(page, '1 Oct 2026');
    expect(ui.posts).toHaveLength(1);
    expect(await refreshes(page)).toBe(0);
    ui.state.status = 200;
    await ui.banner.getByRole('button', { name: 'Retry', exact: true }).click();
    await dates(page, '30 Sept 2026');
    await expect.poll(() => refreshes(page)).toBe(1);
    expect(ui.posts).toHaveLength(2);
    expect(ui.errors.filter(error => !error.includes('503'))).toEqual([]);
});

test('the manual selector validates input and saves once without another device prompt', async ({ page }, testInfo) => {
    const ui = await mount(page);
    await page.getByLabel('Time zone', { exact: true }).fill('Invalid/Zone');
    await page.getByRole('button', { name: 'Save time zone', exact: true }).click();
    expect(ui.posts).toHaveLength(0);
    await page.getByLabel('Time zone', { exact: true }).fill('Asia/Tokyo');
    await page.getByRole('button', { name: 'Save time zone', exact: true }).click();
    await expect(page.getByText('Dates are shown in Asia/Tokyo.', { exact: true })).toBeVisible();
    await expect(ui.banner).toHaveCount(0);
    await expect.poll(() => refreshes(page)).toBe(1);
    expect(ui.posts).toHaveLength(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath('time-zone-settings.png') });
    expect(ui.errors).toEqual([]);
});

test('a zone change before a streamed date boundary hydrates causes no hydration errors', async ({ page }) => {
    const ui = await mount(page, { late: true });
    expect(await page.evaluate(() => window.__tzDatesHydrated)).not.toBe(true);
    await ui.banner.getByRole('button', { name: 'Switch', exact: true }).click();
    await expect.poll(() => refreshes(page)).toBe(1);
    await page.evaluate(() => window.__releaseTZDates());
    await page.waitForFunction(() => window.__tzDatesHydrated === true);
    await dates(page, '30 Sept 2026');
    expect(ui.errors).toEqual([]);
});

test('switching accounts ignores the previous account’s pending save response', async ({ page }) => {
    const ui = await mount(page);
    ui.state.hold = true;
    await ui.banner.getByRole('button', { name: 'Switch', exact: true }).click();
    await expect.poll(() => ui.posts.length).toBe(1);
    await ui.account({ accountId: 'account-b', savedTimeZone: 'Asia/Tokyo', version: '5' });
    await expect(page.getByText('Dates are shown in Asia/Tokyo.', { exact: true })).toBeVisible();
    await dates(page, '1 Oct 2026');
    ui.state.release();
    await expect.poll(() => refreshes(page)).toBe(0);
    expect(ui.posts[0].account).toBe('account-a');
    expect(ui.posts).toHaveLength(1);
    expect(ui.errors).toEqual([]);
});
