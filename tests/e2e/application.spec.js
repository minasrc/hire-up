import { expect, test } from '@playwright/test';
import { createSyntheticDocx } from '../support/cv-fixtures.js';

const APPLICATION_JOB = {
    id: 'gondor-founding-engineer', title: 'Founding Engineer', company: 'Synthetic Company',
    type: 'Full-time', location: 'Remote', salary: 'Not specified',
    description: 'Synthetic application test role.', tags: [], applicationOpen: true,
};

const openApplication = async (page) => {
    await page.route('**/api/auth/session', (route) => route.fulfill({ json: {} }));
    await page.route('**/api/public/jobs', (route) => route.request().method() === 'GET'
        ? route.fulfill({ json: { jobs: [APPLICATION_JOB] } })
        : route.continue());
    await page.goto('/jobs', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('button', { name: '[ APPLY ]', exact: true })).toHaveCount(1);
    await page.getByRole('button', { name: '[ APPLY ]', exact: true }).first().click();
    await expect(page.getByRole('dialog')).toContainText('Founding Engineer');
};

const completeApplication = async (page) => {
    await page.getByLabel('Full name').fill('Ada Lovelace');
    await page.getByLabel('Email address').fill('ada@example.com');
    await page.getByLabel('Professional URL').fill('www.linkedin.com/in/ada');
    await page.getByLabel('Professional URL').blur();
    await page.getByLabel('Technical achievement').fill('Built a protocol.');
    await page.getByLabel('Upload CV as PDF or DOCX, maximum 4 MB').setInputFiles({
        name: 'ada-cv.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: createSyntheticDocx(),
    });
};

test('submits the selected job and all visible candidate fields', async ({ page }) => {
    let requestBody = '';
    await page.route('**/api/submit-signal', async (route) => {
        requestBody = route.request().postDataBuffer()?.toString('utf8') || '';
        await route.fulfill({ status: 200, json: { success: true, refId: 'AG-A1B2C3D4E5F6' } });
    });

    await openApplication(page);
    await completeApplication(page);
    await page.getByRole('button', { name: 'SUBMIT_SIGNAL' }).click();

    await expect(page.getByText('SIGNAL_VERIFIED')).toBeVisible();
    await expect(page.getByText('REFERENCE: AG-A1B2C3D4E5F6')).toBeVisible();
    expect(requestBody).toContain('gondor-founding-engineer');
    expect(requestBody).toContain('Ada Lovelace');
    expect(requestBody).toContain('ada@example.com');
    expect(requestBody).toContain('https://www.linkedin.com/in/ada');
    expect(requestBody).toContain('ada-cv.docx');
    expect(requestBody).toContain('Built a protocol.');
});

test('explains an email entered as a professional URL and clears the error when corrected', async ({ page }) => {
    await openApplication(page);

    const professionalUrl = page.getByLabel('Professional URL');
    await professionalUrl.fill('ada@example.com');
    await professionalUrl.blur();

    const professionalUrlError = page.locator('#application-professional-url-error');
    await expect(professionalUrlError).toHaveText(
        'Enter a LinkedIn, GitHub, or portfolio URL, not an email address.',
    );
    await expect(professionalUrl).toHaveAttribute('aria-invalid', 'true');

    await professionalUrl.fill('github.com/ada');
    await professionalUrl.blur();

    await expect(professionalUrl).toHaveValue('https://github.com/ada');
    await expect(professionalUrl).toHaveAttribute('aria-invalid', 'false');
    await expect(professionalUrlError).toBeHidden();
});

test('does not show verified when the server response has no application reference', async ({ page }) => {
    await page.route('**/api/submit-signal', (route) => route.fulfill({
        status: 202,
        json: { success: true, message: 'Application received.' },
    }));

    await openApplication(page);
    await completeApplication(page);
    await page.getByRole('button', { name: 'SUBMIT_SIGNAL' }).click();

    await expect(page.getByText('SIGNAL_VERIFIED')).toBeHidden();
    await expect(page.getByRole('alert').filter({ hasText: 'We could not confirm' })).toHaveText(
        'We could not confirm that your application was saved. Please try again.',
    );
});

test('shows a server error and allows the candidate to retry', async ({ page }) => {
    await page.route('**/api/submit-signal', (route) => route.fulfill({
        status: 500,
        json: { success: false, code: 'APPLICATION_SAVE_FAILED', message: 'Please try again.' },
    }));

    await openApplication(page);
    await completeApplication(page);
    await page.getByRole('button', { name: 'SUBMIT_SIGNAL' }).click();

    await expect(page.getByRole('alert').filter({ hasText: 'Please try again.' })).toHaveText('Please try again.');
    await expect(page.getByRole('button', { name: 'SUBMIT_SIGNAL' })).toBeEnabled();
});
