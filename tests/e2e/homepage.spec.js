import { expect, test } from '@playwright/test';

test('hydrates the homepage without client errors', async ({ page }) => {
    const browserErrors = [];

    page.on('console', (message) => {
        if (message.type() === 'error') {
            browserErrors.push(message.text());
        }
    });
    page.on('pageerror', (error) => browserErrors.push(error.message));

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: /High-Fidelity Talent Infrastructure/ })).toBeVisible();
    await page.waitForTimeout(500);

    expect(browserErrors).toEqual([]);
});
