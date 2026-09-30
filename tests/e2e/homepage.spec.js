import { expect, test } from '@playwright/test';

test.beforeAll(async ({ request }) => {
    const response = await request.get('/');
    expect(response.status()).toBe(200);
});

test('hydrates the homepage without client errors', async ({ page }) => {
    const browserErrors = [];

    page.on('console', (message) => {
        if (message.type() === 'error') {
            browserErrors.push(message.text());
        }
    });
    page.on('pageerror', (error) => browserErrors.push(error.message));

    await page.goto('/');
    await expect(page.getByRole('heading', { name: /High-Fidelity Talent Infrastructure/ })).toBeVisible();
    const faqs = page.locator('#faqs2');
    const question = faqs.getByRole('button', {
        name: 'What kind of companies do you work with?', exact: true,
    });
    await question.evaluate((element) => element.focus({ preventScroll: true }));
    await question.press('Enter');
    await expect(question).toHaveAttribute('aria-expanded', 'true');
    await expect(faqs.getByText(
        'We partner with a curated portfolio of high-quality, well-funded companies, including: High-Growth Startups, Established Protocols, Web2 Innovators and funds that back the best in the business.',
        { exact: true },
    )).toBeVisible();

    expect(browserErrors).toEqual([]);
});
