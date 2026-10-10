import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { expect, test } from '@playwright/test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const compiledForm = ts.transpileModule(
    readFileSync(new URL('../../src/app/staff/mfa/mfa-forms.tsx', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 } },
).outputText;
const reactScripts = ['react', 'react-dom'].map((name) => readFileSync(
    join(dirname(require.resolve(name)), `umd/${name}.development.js`), 'utf8',
));

const backupCodes = Array.from({ length: 10 }, (_, i) => `${String(i).padStart(8, '0')}-ABCDEF12-ABCDEF12-ABCDEF12`);

// Exercise the real client component with simulated API responses. This
// fixture never authenticates, creates a credential, or contacts a database.
async function mountForm(page, { mode = 'enroll', status = 200, error, networkError = false, missingCodes = false, stalledNavigation = false } = {}) {
    const origin = 'http://127.0.0.1:3000';
    const submissions = [];
    let workspaceRequests = 0;
    await page.route('**/*', async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path.startsWith('/api/staff/mfa/')) {
            submissions.push({ path, method: request.method(), body: request.postDataJSON() });
            if (networkError) return route.abort();
            return route.fulfill({
                status,
                contentType: 'application/json',
                body: JSON.stringify(error ? { error } : { ok: true, ...(mode !== 'verify' && !missingCodes ? { backupCodes } : {}) }),
            });
        }
        // A 204 navigation leaves the current document in place. Exercise
        // recovery without replacing the page or changing location.assign.
        if (path === '/staff' && stalledNavigation && workspaceRequests++ === 0) {
            return route.fulfill({ status: 204 });
        }
        return route.fulfill({
            contentType: 'text/html',
            body: path === '/staff' ? '<h1>Staff destination</h1>' : '<div id="root"></div>',
        });
    });
    await page.goto(`${origin}/__staff-mfa-test`);
    for (const content of reactScripts) await page.addScriptTag({ content });
    await page.addScriptTag({
        content: `const exports = {}; const require = () => React;
            ${compiledForm}
            ReactDOM.createRoot(document.getElementById('root')).render(
                React.createElement(exports.${mode === 'enroll' ? 'MfaEnrollForm' : mode === 'generate' ? 'BackupCodesGenerateForm' : 'MfaVerifyForm'}, {
                    qrDataUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
                    secret: 'SYNTHETIC-TEST-ONLY',
                })
            );`,
    });
    return { origin, submissions };
}

for (const backup of [false, true]) {
    test(`successful ${backup ? 'backup' : 'authenticator'} verification cannot resubmit when navigation stalls`, async ({ page }) => {
        const { origin, submissions } = await mountForm(page, { mode: 'verify', stalledNavigation: true });
        if (backup) {
            await page.getByRole('button', { name: 'Use a backup code', exact: true }).click();
            await page.getByLabel('Backup code', { exact: true }).fill(backupCodes[0]);
            await page.getByRole('button', { name: 'Use backup code', exact: true }).click();
        } else await submitCode(page);
        await expect(page.getByRole('status')).toContainText('verification complete');
        await expect(page.getByRole('button')).toHaveCount(0);
        await expect(page.getByRole('textbox')).toHaveCount(0);
        await expect(page).toHaveURL(`${origin}/__staff-mfa-test`);
        expect(submissions).toHaveLength(1);
        await page.getByRole('link', { name: 'Continue to workspace' }).click();
        await expect(page).toHaveURL(`${origin}/staff`);
        await expect(page.getByRole('heading', { name: 'Staff destination' })).toBeVisible();
        expect(submissions).toHaveLength(1);
    });
}

async function submitCode(page) {
    await page.getByPlaceholder('000000').fill('123456');
    await page.getByRole('button', { name: /^(Enable two-factor|Verify|Generate 10 new backup codes)$/ }).click();
}

for (const mode of ['enroll', 'verify', 'generate']) {
    test(`successful MFA ${mode} leaves the form for the staff workspace`, async ({ page }) => {
        const { origin, submissions } = await mountForm(page, { mode });
        await submitCode(page);
        if (mode !== 'verify') {
            await expect(page.getByLabel('Your backup codes')).toHaveValue(backupCodes.join('\n'));
            await expect(page.getByRole('button', { name: 'Continue to workspace' })).toBeDisabled();
            await expect(page.getByAltText('Authenticator QR code')).toHaveCount(0);
            const download = page.waitForEvent('download');
            await page.getByRole('button', { name: 'Download backup codes' }).click();
            expect((await download).suggestedFilename()).toBe('agora-backup-codes.txt');
            await page.getByLabel('I saved my backup codes').check();
            await page.getByRole('button', { name: 'Continue to workspace' }).click();
        }
        await expect(page).toHaveURL(`${origin}/staff`);
        expect(submissions).toEqual([{
            path: `/api/staff/mfa/${mode === 'generate' ? 'backup-codes' : mode}`, method: 'POST', body: { code: '123456' },
        }]);
    });
}

test('already completed enrollment offers recovery instead of an invalid-code error', async ({ page }) => {
    const { origin } = await mountForm(page, { status: 409, error: 'no pending enrollment' });
    await submitCode(page);
    await expect(page.getByRole('alert')).toContainText('already complete');
    await expect(page.getByRole('alert')).not.toContainText('Invalid code');
    await page.getByRole('link', { name: 'Continue to staff' }).click();
    await expect(page).toHaveURL(`${origin}/staff`);
});

for (const scenario of [
    { name: 'invalid code', status: 401, error: 'invalid code', message: 'Invalid code' },
    { name: 'expired session', status: 401, error: 'unauthorized', message: 'session could not be verified' },
    { name: 'unavailable service', status: 503, error: 'staff workspace not configured', message: 'temporarily unavailable' },
    { name: 'network failure', networkError: true, message: 'Could not connect' },
]) {
    test(`MFA ${scenario.name} explains the failure and allows retry`, async ({ page }) => {
        const { origin } = await mountForm(page, scenario);
        await submitCode(page);
        await expect(page.getByRole('alert')).toContainText(scenario.message);
        await expect(page.getByRole('button')).toBeEnabled();
        await expect(page).toHaveURL(`${origin}/__staff-mfa-test`);
    });
}

for (const status of [200, 401]) {
    test(`backup verification handles status ${status}`, async ({ page }) => {
        const { origin, submissions } = await mountForm(page, { mode: 'verify', status, error: status === 401 ? 'invalid backup code' : undefined });
        await page.getByRole('button', { name: 'Use a backup code', exact: true }).click();
        await page.getByLabel('Backup code', { exact: true }).fill(backupCodes[0]);
        await page.getByRole('button', { name: 'Use backup code', exact: true }).click();
        expect(submissions[0].body).toEqual({ code: backupCodes[0], method: 'backup' });
        if (status === 200) await expect(page).toHaveURL(`${origin}/staff`);
        else {
            await expect(page.getByRole('alert')).toContainText('invalid or has already been used');
            await page.getByRole('button', { name: 'Use authenticator instead' }).click();
            await expect(page.getByLabel('Authenticator code')).toHaveValue('');
        }
    });
}

test('rate limiting explains when to retry', async ({ page }) => {
    await mountForm(page, { status: 429, error: 'too many attempts' });
    await submitCode(page);
    await expect(page.getByRole('alert')).toContainText('Wait 10 minutes');
});

test('missing backup codes provides a generation recovery link', async ({ page }) => {
    await mountForm(page, { missingCodes: true });
    await submitCode(page);
    await expect(page.getByRole('link', { name: 'Generate a new set' })).toHaveAttribute('href', '/staff/mfa/backup-codes');
});
