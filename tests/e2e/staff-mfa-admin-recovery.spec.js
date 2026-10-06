import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { expect, test } from '@playwright/test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(readFileSync(new URL('../../src/app/staff/members/mfa-reset-form.tsx', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 } }).outputText;
const scripts = ['react', 'react-dom'].map((name) => readFileSync(join(dirname(require.resolve(name)), `umd/${name}.development.js`), 'utf8'));
const membershipId = '00000000-0000-4000-8000-000000000001';
async function mount(page, status = 200, networkError = false) {
    const submissions = [];
    await page.route('**/*', async (route) => {
        if (route.request().method() === 'POST') {
            submissions.push(route.request().postDataJSON());
            if (networkError) return route.abort();
            return route.fulfill({ status, contentType: 'application/json', headers: { 'retry-after': '61' },
                body: JSON.stringify({ error: 'Enter a fresh code from your authenticator.' }) });
        }
        return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    });
    await page.goto('http://127.0.0.1:3000/__mfa-reset-test');
    for (const content of scripts) await page.addScriptTag({ content });
    await page.addScriptTag({ content: `const exports = {}; const require = (name) => name === 'react' ? React : { useRouter: () => ({ refresh: () => { window.didRefresh = true; } }) };
        ${compiled}
        ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(exports.MemberMfaResetForm,
            { membershipId: '${membershipId}', version: '3', displayName: 'Synthetic Member' }));` });
    await page.getByRole('button', { name: 'Reset authenticator', exact: true }).click();
    return submissions;
}
async function fill(page) {
    await page.getByLabel('Your fresh authenticator code').fill('123456');
    await page.getByLabel('I verified this member’s identity.').check();
}
test('reset requires identity confirmation and a code, then confirms recovery', async ({ page }) => {
    const submissions = await mount(page);
    await expect(page.getByText('Reset authenticator for Synthetic Member?')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirm reset' })).toBeDisabled();
    await page.getByLabel('Your fresh authenticator code').fill('123456');
    await expect(page.getByRole('button', { name: 'Confirm reset' })).toBeDisabled();
    await fill(page);
    await page.getByRole('button', { name: 'Confirm reset' }).click();
    await expect(page.getByRole('status')).toContainText('set up their authenticator again');
    expect(submissions).toEqual([{ membershipId, version: 3, reason: 'lost_authenticator', code: '123456' }]);
    expect(await page.evaluate(() => window.didRefresh)).toBe(true);
});
for (const [status, message] of [[401, 'fresh code'], [403, 'self-reset is not allowed'], [409, 'Reload the page'], [422, 'Reset was rejected'], [428, 'another tab'], [429, 'Wait 2 minutes'], [503, 'temporarily unavailable']]) {
    test(`reset failure ${status} preserves the form and clears the code`, async ({ page }) => {
        await mount(page, status);
        await fill(page);
        await page.getByRole('button', { name: 'Confirm reset' }).click();
        await expect(page.getByRole('alert')).toContainText(message);
        await expect(page.getByLabel('Your fresh authenticator code')).toHaveValue('');
        await expect(page.getByLabel('I verified this member’s identity.')).toBeChecked();
        await expect(page.getByRole('button', { name: 'Confirm reset' })).toBeDisabled();
    });
}
test('cancelling a reset clears sensitive input and confirmation', async ({ page }) => {
    const submissions = await mount(page);
    await fill(page);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Reset authenticator', exact: true }).click();
    await expect(page.getByLabel('Your fresh authenticator code')).toHaveValue('');
    await expect(page.getByLabel('I verified this member’s identity.')).not.toBeChecked();
    expect(submissions).toEqual([]);
});
test('connection failure allows recovery without pretending reset succeeded', async ({ page }) => {
    await mount(page, 200, true);
    await fill(page);
    await page.getByRole('button', { name: 'Confirm reset' }).click();
    await expect(page.getByRole('alert')).toContainText('Could not connect');
});
