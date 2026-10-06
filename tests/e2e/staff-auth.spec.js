import { expect, test } from '@playwright/test';

// These routes share a cold Next dev server in CI, so a streamed redirect
// can take longer than Playwright's default five-second assertion window.
test.setTimeout(90_000);

// Cold next-dev compilation plus the layout redirect can abort or stall the
// navigation's load event in CI; commit resolves once the redirected document
// commits, and the toHaveURL poll confirms the final location.
const gotoStaff = async (page, path) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            await page.goto(path, { waitUntil: 'commit' });
            await page.waitForURL(/\/staff\/sign-in/, { timeout: 30_000 });
            return;
        } catch (error) {
            if (attempt === 2 || !String(error).includes('ERR_ABORTED')) {
                throw error;
            }
        }
    }
};

test('staff area redirects unauthenticated visitors to the staff sign-in page', async ({ page }) => {
    await gotoStaff(page, '/staff');
    await expect(page).toHaveURL(/\/staff\/sign-in/);
    await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
});

test('staff no-access page redirects unauthenticated visitors to sign-in', async ({ page }) => {
    await gotoStaff(page, '/staff/no-access');
    await expect(page).toHaveURL(/\/staff\/sign-in/);
});

test('staff MFA pages redirect unauthenticated visitors to sign-in', async ({ page }) => {
    for (const path of ['/staff/mfa/enroll', '/staff/mfa/verify', '/staff/mfa/backup-codes']) {
        await gotoStaff(page, path);
        await expect(page).toHaveURL(/\/staff\/sign-in/);
    }
});

const id = '00000000-0000-4000-8000-000000000000';
for (const path of [
    '/staff/clients',
    '/staff/clients/new',
    `/staff/clients/${id}`,
    '/staff/jobs',
    '/staff/jobs/new',
    `/staff/jobs/${id}`,
    `/staff/jobs/${id}/edit`,
    '/staff/applications',
    '/staff/candidates',
    '/staff/candidates/duplicates',
    `/staff/candidates/${id}`,
    '/staff/members',
    '/staff/unavailable',
]) {
    test(`${path} redirects unauthenticated visitors to sign-in`, async ({ page }) => {
        await gotoStaff(page, path);
        await expect(page).toHaveURL(/\/staff\/sign-in/);
    });
}

for (const path of [
    '/api/staff/clients',
    `/api/staff/clients/${id}`,
    '/api/staff/jobs',
    `/api/staff/jobs/${id}/draft`,
    `/api/staff/jobs/${id}/revision`,
    `/api/staff/jobs/${id}/publish`,
    `/api/staff/jobs/${id}/listing`,
    '/api/staff/applications',
    '/api/staff/candidates',
    '/api/staff/candidates/duplicates',
    '/api/staff/members',
    '/api/staff/mfa/enroll',
    '/api/staff/mfa/verify',
    '/api/staff/mfa/backup-codes',
    '/api/staff/members/mfa-reset',
]) {
    test(`${path} rejects unauthenticated requests`, async ({ request }) => {
        const response = await request.post(path, { data: {} });
        expect(response.status()).toBe(401);
    });
}

test('duplicate review API rejects unauthenticated reads', async ({ request }) => {
    const response = await request.get('/api/staff/candidates/duplicates');
    expect(response.status()).toBe(401);
});

test('duplicate merge API rejects unauthenticated writes', async ({ request }) => {
    const response = await request.post('/api/staff/candidates/duplicates/merge', {
        data: {},
        headers: { origin: 'http://127.0.0.1:3000' },
    });
    expect(response.status()).toBe(401);
});

test('staff document download rejects unauthenticated requests', async ({ request }) => {
    const id = '00000000-0000-4000-8000-000000000000';
    const response = await request.get(`/api/staff/documents/${id}`);
    expect(response.status()).toBe(401);
});
