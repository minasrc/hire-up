import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { expect, test } from '@playwright/test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const reactScripts = ['react', 'react-dom'].map((name) => readFileSync(
    join(dirname(require.resolve(name)), `umd/${name}.development.js`), 'utf8',
));
const compile = (file) => ts.transpileModule(
    readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 } },
).outputText;
const notice = compile('src/app/staff/auth-recovery-notice.tsx');
const mutation = compile('src/lib/staff-mutation.ts');
const authState = compile('src/lib/staff-auth-recovery.js');
const authComponents = compile('src/app/staff/auth-recovery.tsx');

for (const scenario of [
    { status: 428, message: 'Verify your authenticator', label: 'Verify authenticator', href: '/staff/mfa/verify' },
    { status: 401, message: 'Sign in again', label: 'Sign in again', href: '/staff/sign-in' },
    { status: 503, message: 'temporarily unavailable' },
]) {
    test(`save failure ${scenario.status} retains edits and offers appropriate recovery`, async ({ page }) => {
        await page.route('**/*', (route) => route.fulfill(
            new URL(route.request().url()).pathname.startsWith('/api/')
                ? { status: scenario.status, contentType: 'application/json', body: JSON.stringify({ error: 'denied' }) }
                : { contentType: 'text/html', body: '<div id="notice"></div><input aria-label="Unsaved edit"><button id="save">Save</button><p id="error" role="status"></p>' },
        ));
        await page.goto('http://127.0.0.1:3000/__recovery-test');
        for (const content of reactScripts) await page.addScriptTag({ content });
        await page.addScriptTag({ content: `
            const state = (() => { const exports = {}; ${authState}; return exports; })();
            const imports = {
                react: React,
                '@/lib/staff-auth-recovery': state,
                './staff-auth-recovery': state,
                'next-auth/react': { useSession: () => ({ update: async () => ({ user: { email: 'synthetic@test.invalid' } }) }) },
                '@/components/staff-ui/button': { Button: ({ children, size, variant, ...props }) => React.createElement('button', props, children) },
            };
            const require = name => {
                if (!Object.hasOwn(imports, name)) throw new Error('Unexpected dependency: ' + name);
                return imports[name];
            };
            imports['./auth-recovery'] = (() => { const exports = {}; ${authComponents}; return exports; })();
            const recovery = (() => { const exports = {}; ${notice}; return exports; })();
            const mutations = (() => { const exports = {}; ${mutation}; return exports; })();
            ReactDOM.createRoot(document.getElementById('notice')).render(React.createElement(recovery.AuthRecoveryNotice));
            document.getElementById('save').onclick = async () => {
                try { await mutations.staffMutation('/api/staff/clients', { name: 'unsaved' }); }
                catch (error) { document.getElementById('error').textContent = error.message; }
            };
        ` });
        await page.getByRole('textbox', { name: 'Unsaved edit' }).fill('Work in progress');
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(page.getByRole('status')).toContainText(scenario.message);
        await expect(page.getByRole('textbox')).toHaveValue('Work in progress');
        await expect(page).toHaveURL(/__recovery-test$/);
        if (scenario.href) {
            const link = page.getByRole('link', { name: scenario.label });
            await expect(link).toHaveAttribute('href', scenario.href);
            await expect(link).toHaveAttribute('target', '_blank');
        } else {
            await expect(page.getByRole('link')).toHaveCount(0);
        }
    });
}
