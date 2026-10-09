import { expect, test } from '@playwright/test';

test('public routes keep their chrome without fetching a session; staff sign-in stays bare', async ({ page }) => {
    test.setTimeout(90_000);
    const sessionRequests = [];
    const errors = [];
    page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/auth/session') sessionRequests.push(request.url());
    });
    page.on('pageerror', (error) => errors.push(error.message));

    for (const path of ['/', '/jobs', '/for-employers']) {
        // This checks the route's rendered chrome, not completion of every
        // image or external asset loaded by the page.
        await page.goto(path, { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('banner')).toBeVisible();
        await expect(page.getByRole('contentinfo')).toBeVisible();
        await expect(page.locator('.bg-noise')).toHaveCount(1);
    }
    expect(sessionRequests).toEqual([]);

    await page.goto('/staff/sign-in', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
    await expect(page.getByRole('banner')).toHaveCount(0);
    await expect(page.getByRole('contentinfo')).toHaveCount(0);
    await expect(page.locator('.bg-noise')).toHaveCount(0);
    await expect(page.getByRole('main')).toHaveCount(1);
    expect(errors).toEqual([]);
});
