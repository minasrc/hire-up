import { expect, test } from '@playwright/test';

test('hydrates the homepage without client errors', async ({ page }) => {
    const browserErrors = [];

    page.on('console', (message) => {
        if (message.type() === 'error') {
            browserErrors.push(message.text());
        }
    });
    page.on('pageerror', (error) => browserErrors.push(error.message));

    for (const path of ['/_vercel/insights/script.js', '/_vercel/speed-insights/script.js']) {
        await page.route((url) => url.origin === 'http://127.0.0.1:3000' && url.pathname === path,
            (route) => route.fulfill({ contentType: 'application/javascript', body: '' }));
    }
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: /High-Fidelity Talent Infrastructure/ })).toBeVisible();
    await page.waitForTimeout(500);

    expect(browserErrors).toEqual([]);
});
