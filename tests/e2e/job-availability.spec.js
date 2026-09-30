import { expect, test } from '@playwright/test';
import { createSyntheticPdf } from '../support/cv-fixtures.js';

const LISTED_JOB = {
    id: 'synthetic-listed-role',
    title: 'Synthetic Listed Role',
    company: 'Synthetic Labs',
    type: 'Full-time',
    location: 'Remote',
    salary: 'USD 120k - 150k',
    description: 'Fallback plaintext description.',
    descriptionDocument: {
        type: 'doc',
        content: [
            {
                type: 'paragraph',
                content: [{ type: 'text', text: 'A real first paragraph.' }],
            },
            {
                type: 'heading',
                attrs: { level: 2 },
                content: [{ type: 'text', text: 'What you will own' }],
            },
            {
                type: 'bulletList',
                content: [
                    {
                        type: 'listItem',
                        content: [{
                            type: 'paragraph',
                            content: [{ type: 'text', text: 'Ship the real protocol upgrade' }],
                        }],
                    },
                ],
            },
        ],
    },
    publishedAt: '2026-09-20T10:00:00.000Z',
    applicationOpen: true,
};

const UNAVAILABLE_PAYLOAD = {
    status: 503,
    json: {
        code: 'JOBS_UNAVAILABLE',
        message: 'Job listings are temporarily unavailable. Please try again.',
    },
};

const mockSession = (page) => page.route(
    '**/api/auth/session', (route) => route.fulfill({ json: {} }));

const cardFor = (page, title) => page.locator('div.group').filter({
    has: page.getByRole('heading', { name: title, exact: true }),
});

const applyButton = (card) => card.getByRole('button', { name: '[ APPLY ]', exact: true });

const outageBanner = (page) => page.getByRole('alert')
    .filter({ hasText: 'Job listings are temporarily unavailable.' });

test('a listing outage keeps the last cards and fails closed on open actions', async ({ page }) => {
    await mockSession(page);
    let down = true;
    await page.route('**/api/public/jobs', (route) => (down
        ? route.fulfill(UNAVAILABLE_PAYLOAD)
        : route.fulfill({ json: { jobs: [LISTED_JOB] } })));
    await page.goto('/jobs');
    const staticCard = cardFor(page, 'Founding Engineer');
    await staticCard.waitFor();
    await expect(outageBanner(page)).toBeVisible();

    await applyButton(staticCard).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await staticCard.getByRole('button', { name: 'Learn more' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(staticCard).toBeVisible();

    down = false;
    await outageBanner(page).getByRole('button', { name: 'Retry' }).click();
    const listedCard = cardFor(page, 'Synthetic Listed Role');
    await listedCard.waitFor();
    await applyButton(listedCard).click();
    await expect(page.getByRole('dialog')).toContainText('Signal Submission');
});

for (const action of ['Learn more', '[ APPLY ]']) {
    test(`click preflight rejects a removed job through ${action}`, async ({ page }) => {
        await mockSession(page);
        await page.clock.install();
        let available = true;
        await page.route('**/api/public/jobs', (route) => route.fulfill({
            json: { jobs: available ? [LISTED_JOB] : [] },
        }));
        await page.goto('/jobs');
        const card = cardFor(page, LISTED_JOB.title);
        await expect(card).toBeVisible();
        await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));

        available = false;
        const freshListing = page.waitForResponse((response) =>
            new URL(response.url()).pathname === '/api/public/jobs'
                && response.request().method() === 'GET');
        await card.getByRole('button', { name: action, exact: true }).dispatchEvent('click');
        const response = await freshListing;
        expect(response.status()).toBe(200);
        expect(await response.json()).toEqual({ jobs: [] });
        await expect(page.getByText('This position is no longer available.', { exact: true })).toBeVisible();
        await expect(card).toHaveCount(0);
        await expect(page.getByRole('dialog')).toHaveCount(0);
    });
}

test('the board polls while visible, skips hidden ticks, and recovers from a stalled request', async ({ page }) => {
    await mockSession(page);
    await page.clock.install();
    let jobs = [LISTED_JOB];
    let hold = false;
    let hits = 0;
    const held = [];
    await page.route('**/api/public/jobs', (route) => {
        hits += 1;
        if (hold) {
            held.push(route);
            return;
        }
        return route.fulfill({ json: { jobs } });
    });
    await page.goto('/jobs');
    const card = cardFor(page, 'Synthetic Listed Role');
    await card.waitFor();

    jobs = [];
    const ticked = page.waitForRequest('**/api/public/jobs');
    await page.clock.runFor(30_000);
    await ticked;
    await expect(card).toHaveCount(0);

    await page.evaluate(() => {
        let state = 'hidden';
        Object.defineProperty(document, 'visibilityState', {
            get: () => state,
            configurable: true,
        });
        window.__setVisibility = (value) => {
            state = value;
            document.dispatchEvent(new Event('visibilitychange'));
        };
    });
    const hitsBeforeHidden = hits;
    await page.clock.runFor(30_000);
    expect(hits).toBe(hitsBeforeHidden);

    jobs = [LISTED_JOB];
    const visibilityFetch = page.waitForRequest('**/api/public/jobs');
    await page.evaluate(() => window.__setVisibility('visible'));
    await visibilityFetch;
    await card.waitFor();

    hold = true;
    const stalled = page.waitForRequest('**/api/public/jobs');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await stalled;
    await page.clock.runFor(11_000);
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();

    await held[held.length - 1].fulfill({ json: { jobs } });
    hold = false;
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(card).toBeVisible();
    await expect(outageBanner(page)).toHaveCount(0);
});

test('the application form keeps entered data through outage and relisting', async ({ page }) => {
    await mockSession(page);
    let mode = 'open';
    await page.route('**/api/public/jobs', (route) => {
        if (mode === 'down') return route.fulfill(UNAVAILABLE_PAYLOAD);
        if (mode === 'gone') return route.fulfill({ json: { jobs: [] } });
        return route.fulfill({ json: { jobs: [LISTED_JOB] } });
    });
    await page.goto('/jobs');
    const card = cardFor(page, 'Synthetic Listed Role');
    await card.waitFor();
    await applyButton(card).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    const name = page.getByLabel('Full name');
    const email = page.getByLabel('Email address');
    const fileLabel = page.getByText('SELECTED: ada-cv.pdf');
    const submit = page.getByRole('button', { name: 'SUBMIT_SIGNAL' });
    await name.fill('Ada Lovelace');
    await email.fill('ada@example.com');
    await page.getByLabel('Upload CV as PDF or DOCX, maximum 4 MB').setInputFiles({
        name: 'ada-cv.pdf',
        mimeType: 'application/pdf',
        buffer: createSyntheticPdf(),
    });
    await expect(fileLabel).toBeVisible();
    await expect(submit).toBeEnabled();

    mode = 'down';
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const unknownBanner = dialog.getByRole('alert')
        .filter({ hasText: 'We could not confirm this position is still open' });
    await expect(unknownBanner).toBeVisible();
    await expect(submit).toBeDisabled();
    await expect(name).toHaveValue('Ada Lovelace');
    await expect(email).toHaveValue('ada@example.com');
    await expect(fileLabel).toBeVisible();

    mode = 'open';
    await unknownBanner.getByRole('button', { name: 'Retry' }).click();
    await expect(submit).toBeEnabled();
    await expect(name).toHaveValue('Ada Lovelace');
    await expect(fileLabel).toBeVisible();

    mode = 'gone';
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(
        dialog.getByText('This position is no longer accepting applications.'),
    ).toBeVisible();
    await expect(submit).toBeDisabled();
    await expect(name).toHaveValue('Ada Lovelace');
    await expect(fileLabel).toBeVisible();

    mode = 'open';
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(submit).toBeEnabled();
    await expect(name).toHaveValue('Ada Lovelace');
    await expect(email).toHaveValue('ada@example.com');
    await expect(fileLabel).toBeVisible();
});

test('closing during the availability check never submits, and double-submit sends one request', async ({ page }) => {
    await mockSession(page);
    let hold = false;
    const held = [];
    await page.route('**/api/public/jobs', (route) => {
        if (hold) {
            held.push(route);
            return;
        }
        return route.fulfill({ json: { jobs: [LISTED_JOB] } });
    });
    let posts = 0;
    await page.route('**/api/submit-signal', (route) => {
        posts += 1;
        return route.fulfill({ status: 200, json: { success: true, refId: 'AG-A1B2C3D4E5F6' } });
    });
    await page.goto('/jobs');
    const card = cardFor(page, 'Synthetic Listed Role');
    await card.waitFor();
    await applyButton(card).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await page.getByLabel('Full name').fill('Ada Lovelace');
    await page.getByLabel('Email address').fill('ada@example.com');
    await page.getByLabel('Upload CV as PDF or DOCX, maximum 4 MB').setInputFiles({
        name: 'ada-cv.pdf',
        mimeType: 'application/pdf',
        buffer: createSyntheticPdf(),
    });

    hold = true;
    const checking = page.waitForRequest('**/api/public/jobs');
    await page.getByRole('button', { name: 'SUBMIT_SIGNAL' }).click();
    await checking;
    await dialog.getByRole('button', { name: 'Close application form' }).click();
    const listingResponse = page.waitForResponse('**/api/public/jobs');
    await held[held.length - 1].fulfill({ json: { jobs: [LISTED_JOB] } });
    await (await listingResponse).finished();
    await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => resolve())),
    );
    expect(posts).toBe(0);
    await expect(dialog).toHaveCount(0);

    hold = false;
    await applyButton(card).click();
    await dialog.waitFor();
    await page.getByLabel('Full name').fill('Ada Lovelace');
    await page.getByLabel('Email address').fill('ada@example.com');
    await page.getByLabel('Upload CV as PDF or DOCX, maximum 4 MB').setInputFiles({
        name: 'ada-cv.pdf',
        mimeType: 'application/pdf',
        buffer: createSyntheticPdf(),
    });
    const submit = dialog.locator('button[type="submit"]');
    hold = true;
    const rechecking = page.waitForRequest('**/api/public/jobs');
    await submit.click();
    await rechecking;
    await submit.dispatchEvent('click');
    hold = false;
    await held[held.length - 1].fulfill({ json: { jobs: [LISTED_JOB] } });
    await expect(page.getByText('SIGNAL_VERIFIED')).toBeVisible();
    expect(posts).toBe(1);
});

test('the detail modal renders the published document and locks scroll', async ({ page }, testInfo) => {
    await mockSession(page);
    let jobs = [LISTED_JOB];
    await page.route('**/api/public/jobs', (route) => route.fulfill({ json: { jobs } }));
    await page.goto('/jobs');
    const card = cardFor(page, 'Synthetic Listed Role');
    await card.waitFor();
    await card.getByRole('button', { name: 'Learn more' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();

    await expect(dialog.getByRole('heading', { name: 'Role Overview' })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'What you will own' })).toBeVisible();
    await expect(
        dialog.locator('li').filter({ hasText: 'Ship the real protocol upgrade' }),
    ).toBeVisible();
    await expect(dialog.locator('time'))
        .toHaveAttribute('dateTime', '2026-09-20T10:00:00.000Z');
    await expect(dialog.getByText('Posted 2 days ago')).toHaveCount(0);
    await expect(dialog.getByText('Architect')).toHaveCount(0);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
    await expect(dialog).toHaveCSS('opacity', '1');
    await expect(dialog.locator('..')).toHaveCSS('opacity', '1');
    await expect.poll(async () => dialog.evaluate((el) => {
        const transform = getComputedStyle(el).transform;
        return transform === 'none' || new DOMMatrixReadOnly(transform).isIdentity;
    })).toBe(true);
    await expect.poll(async () => card.evaluate((el) => {
        const style = getComputedStyle(el);
        return style.opacity === '1'
            && (style.transform === 'none'
                || new DOMMatrixReadOnly(style.transform).isIdentity);
    })).toBe(true);
    await page.screenshot({
        path: `test-results/job-availability-detail-${testInfo.project.name}.png`,
    });

    jobs = [{ ...LISTED_JOB, applicationOpen: false }];
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(dialog.getByRole('button', { name: 'APPLY NOW' })).toBeDisabled();
    await expect(
        dialog.getByText('This position is no longer accepting applications.'),
    ).toBeVisible();

    jobs = [LISTED_JOB];
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const apply = dialog.getByRole('button', { name: 'APPLY NOW' });
    await expect(apply).toBeEnabled();
    await apply.click();
    const form = page.getByRole('dialog');
    await expect(form).toContainText('Signal Submission');
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');

    await form.getByRole('button', { name: 'Close application form' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
});
